// Compare one condition across two runs, and refuse when the runs differ in
// anything but the tool: backend, model, effort, seed, eval commit, suite,
// serving or extractor. Two runs never share a prompt cache, so cost is left
// out; for a comparison that can include it, run both builds as conditions of
// one run and use eval/ab.mjs.
//
//   node eval/scripts/compare.mjs <runA>[:<condition>] <runB>[:<condition>]
//
// The condition defaults to the only one a run has. Exits 1 on a refusal.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hierarchicalBootstrap,
  mcnemarExact,
  minimumDetectableEffect,
  sd,
  signTest,
  taskDiff,
} from '../ab.mjs';
import { buildKey, runFlags } from './identity.mjs';

const [argA, argB] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!argA || !argB) {
  console.error('usage: node eval/scripts/compare.mjs <runA>[:<condition>] <runB>[:<condition>]');
  process.exit(1);
}

function load(arg) {
  const at = arg.lastIndexOf(':');
  const hasCondition = at > 0 && !existsSync(join(arg, 'results.json'));
  const dir = hasCondition ? arg.slice(0, at) : arg;
  const run = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  const conditions = [...new Set(run.results.map((r) => r.condition))];
  const condition = hasCondition ? arg.slice(at + 1) : conditions.length === 1 ? conditions[0] : null;
  if (!condition || !conditions.includes(condition)) {
    console.error(`${dir}: name a condition as ${dir}:<condition>; this run has ${conditions.join(', ')}`);
    process.exit(1);
  }
  return { dir, meta: run.meta ?? {}, rows: run.results.filter((r) => r.condition === condition), condition, all: run.results };
}

const A = load(argA);
const B = load(argB);

// What must match, read from each run's meta. A value either run did not
// record cannot be shown to match, so it refuses too.
const backendOf = (x) => x.rows[0]?.backend ?? x.meta.backend;
const KEYS = {
  backend: backendOf,
  model: (x) => x.rows[0]?.model ?? x.meta.models?.[backendOf(x)] ?? null,
  effort: (x) => x.meta.effort ?? null,
  seed: (x) => x.meta.seed ?? null,
  'eval commit': (x) => x.meta.git?.commit ?? null,
  'eval tree dirty': (x) => x.meta.git?.dirty ?? null,
  suite: (x) => x.meta.suite ?? null,
  serving: (x) => x.meta.serving ?? 'single-origin',
  extractor: (x) => (x.meta.extractor ? `${x.meta.extractor.extractor}/${x.meta.extractor.model}` : null),
};
const REQUIRED = new Set(['backend', 'model', 'effort', 'seed', 'eval commit']);
const problems = [];
for (const [name, read] of Object.entries(KEYS)) {
  const va = read(A);
  const vb = read(B);
  if (REQUIRED.has(name) && (va == null || vb == null)) problems.push(`${name} not recorded (${va ?? 'none'} vs ${vb ?? 'none'})`);
  else if (JSON.stringify(va) !== JSON.stringify(vb)) problems.push(`${name} differs: ${va} vs ${vb}`);
}
if (A.meta.git?.dirty || B.meta.git?.dirty) problems.push('an eval tree was dirty, so one commit does not pin what graded it');
for (const [x, label] of [[A, 'A'], [B, 'B']]) {
  for (const f of runFlags(x.meta, x.all, { condition: x.condition }).filter((f) => ['contaminated', 'pre-isolation'].includes(f.flag))) {
    problems.push(`run ${label} is ${f.flag}: ${f.why}`);
  }
}
console.log(`A = ${A.dir} : ${A.condition} (${JSON.stringify(buildKey(A.meta, A.condition))})`);
console.log(`B = ${B.dir} : ${B.condition} (${JSON.stringify(buildKey(B.meta, B.condition))})`);
if (problems.length) {
  console.log('\nREFUSED: these runs differ in more than the tool, so a difference between them cannot be attributed to it:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

const valid = (r) => !r.infra && !r.error && !r.invalid && r.output_tokens > 0;
const groups = (metric) => {
  const byTask = (rows) => {
    const m = new Map();
    for (const r of rows.filter(valid)) {
      if (!(r[metric] > 0)) continue;
      if (!m.has(r.task)) m.set(r.task, []);
      m.get(r.task).push(Math.log(r[metric]));
    }
    return m;
  };
  const a = byTask(A.rows);
  const b = byTask(B.rows);
  return [...a.keys()].filter((t) => b.has(t)).map((task) => ({ task, a: a.get(task), b: b.get(task) }));
};
const seed = A.meta.seed ?? 'compare';
const fmt = (x) => (x == null ? 'n/a' : x.toFixed(3));
const out = groups('output_tokens');
const boot = hierarchicalBootstrap(out, { seed });
const diffs = out.map(taskDiff);
const sign = signTest(diffs);
const mde = minimumDetectableEffect(sd(diffs), out.length);
const turns = hierarchicalBootstrap(groups('turns'), { seed, resamples: 4000 });
console.log(
  `\noutput tokens A/B over ${out.length} tasks: ${fmt(boot?.estimate)} [${fmt(boot?.lo)}, ${fmt(boot?.hi)}] (hierarchical bootstrap, seed ${seed})`,
  `\nA higher on ${sign.up}, lower on ${sign.down}; sign test p=${sign.p.toFixed(4)}; minimum detectable effect x${fmt(mde?.up)}`,
  `\nturns A/B: ${fmt(turns?.estimate)} [${fmt(turns?.lo)}, ${fmt(turns?.hi)}]`,
  '\ncost: not compared, because two runs never meet the same prompt cache'
);
const key = (r) => `${r.task}#${r.rep ?? 1}`;
const bRows = new Map(B.rows.filter((r) => !r.infra && !r.invalid).map((r) => [key(r), r]));
const pairs = A.rows.filter((r) => !r.infra && !r.invalid && bRows.has(key(r))).map((r) => [r, bRows.get(key(r))]);
const aOnly = pairs.filter(([x, y]) => x.success && !y.success).map(([x]) => x.task);
const bOnly = pairs.filter(([x, y]) => !x.success && y.success).map(([x]) => x.task);
console.log(
  `pass: A ${pairs.filter(([x]) => x.success).length}/${pairs.length}, B ${pairs.filter(([, y]) => y.success).length}/${pairs.length}; ` +
    `A-only ${aOnly.length}${aOnly.length ? ` (${aOnly.join(', ')})` : ''}, B-only ${bOnly.length}${bOnly.length ? ` (${bOnly.join(', ')})` : ''}; ` +
    `exact McNemar p=${mcnemarExact(aOnly.length, bOnly.length).toFixed(4)}`
);
const movers = out.map((g) => [g.task, Math.exp(taskDiff(g))]).sort((x, y) => y[1] - x[1]);
console.log('\nlargest per-task ratios A/B (single samples misrank tasks; read with repeats):');
const shown = movers.length <= 10 ? movers : [...movers.slice(0, 5), ...movers.slice(-5)];
for (const [task, r] of shown) console.log(`  ${task.padEnd(24)} ${fmt(r)}`);
