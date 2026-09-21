// Compare one condition across two runs, and refuse when the runs differ in
// anything but the tool: backend, model, effort, seed, eval commit and diff,
// suite, serving, extractor or browser pins. Two runs never share a prompt
// cache, so cost is left out; for a comparison that can include it, run both
// builds as conditions of one run and use eval/ab.mjs.
//
//   node eval/scripts/compare.mjs <runA>[:<condition>] <runB>[:<condition>]
//
// The condition defaults to the only one a run has. Exits 1 on a refusal. A
// dirty tree compares by the diff of its eval paths (run.mjs gitState): none,
// as a clean tree, or the same hash.
// A shell-assisted row (row-evidence.mjs) stays out of every figure, and a
// stored codex row's turns are its rollout's model requests, as a new row's
// are.

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
import { shellAssistedOf, withRolloutFacts } from './row-evidence.mjs';

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
  const all = run.results.map((r) => withRolloutFacts(r, dir));
  return { dir, meta: run.meta ?? {}, rows: all.filter((r) => r.condition === condition), condition, all };
}

const A = load(argA);
const B = load(argB);

// What must match, read from each run's meta. A value either run did not
// record cannot be shown to match, so it refuses too.
const backendOf = (x) => x.rows[0]?.backend ?? x.meta.backend;
// 'clean' for a tree whose eval paths match its commit, the opening of their
// diff's hash for a dirty one, UNHASHED for a dirty one that hashed none, and
// null when the run did not say.
const UNHASHED = 'dirty, not hashed';
const evalDiff = (x) => {
  const g = x.meta.git ?? {};
  if (g.dirty == null) return null;
  if (!g.dirty || (g.dirtyFiles && g.diffSha256 == null && !g.diffError)) return 'clean';
  return g.diffSha256 ? `sha256 ${g.diffSha256.slice(0, 16)}` : UNHASHED;
};
const KEYS = {
  backend: backendOf,
  model: (x) => x.rows[0]?.model ?? x.meta.models?.[backendOf(x)] ?? null,
  effort: (x) => x.meta.effort ?? null,
  seed: (x) => x.meta.seed ?? null,
  'eval commit': (x) => x.meta.git?.commit ?? null,
  'eval diff': evalDiff,
  suite: (x) => x.meta.suite ?? null,
  serving: (x) => x.meta.serving ?? 'single-origin',
  extractor: (x) => (x.meta.extractor ? `${x.meta.extractor.extractor}/${x.meta.extractor.model}` : null),
};
const REQUIRED = new Set(['backend', 'model', 'effort', 'seed', 'eval commit', 'eval diff']);
const problems = [];
for (const [name, read] of Object.entries(KEYS)) {
  const va = read(A);
  const vb = read(B);
  if (REQUIRED.has(name) && (va == null || vb == null)) problems.push(`${name} not recorded (${va ?? 'none'} vs ${vb ?? 'none'})`);
  else if (JSON.stringify(va) !== JSON.stringify(vb)) problems.push(`${name} differs: ${va} vs ${vb}`);
}
for (const [x, label] of [[A, 'A'], [B, 'B']]) {
  if (evalDiff(x) === UNHASHED) problems.push(`run ${label}'s eval tree was dirty and hashed no diff, so its commit does not pin what graded it`);
}
// The browser pins (locale, viewport, pdf.js, the prefs): two runs pinned
// differently met different browsers.
const pinsA = JSON.stringify(A.meta.envPins ?? null);
const pinsB = JSON.stringify(B.meta.envPins ?? null);
if (pinsA !== pinsB) {
  const keys = [...new Set([...Object.keys(A.meta.envPins ?? {}), ...Object.keys(B.meta.envPins ?? {})])].filter(
    (k) => JSON.stringify(A.meta.envPins?.[k]) !== JSON.stringify(B.meta.envPins?.[k])
  );
  problems.push(`browser pins differ${A.meta.envPins && B.meta.envPins ? `: ${keys.join(', ')}` : ` (${A.meta.envPins ? 'B' : 'A'} records none)`}`);
}
for (const [x, label] of [[A, 'A'], [B, 'B']]) {
  for (const f of runFlags(x.meta, x.all, { condition: x.condition, runDir: x.dir }).filter((f) => ['contaminated', 'pre-isolation'].includes(f.flag))) {
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

const assistedA = A.rows.filter((r) => shellAssistedOf(r, A.dir));
const assistedB = B.rows.filter((r) => shellAssistedOf(r, B.dir));
const assisted = new Set([...assistedA, ...assistedB]);
if (assisted.size) {
  const list = (rows) => (rows.length ? `${rows.length} (${rows.map((r) => r.task).join(', ')})` : '0');
  console.log(`\nshell-assisted rows left out: A ${list(assistedA)}, B ${list(assistedB)}`);
}
const valid = (r) => !r.infra && !r.error && !r.invalid && !assisted.has(r) && r.output_tokens > 0;
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
const paired = (r) => !r.infra && !r.invalid && !assisted.has(r);
const bRows = new Map(B.rows.filter(paired).map((r) => [key(r), r]));
const pairs = A.rows.filter((r) => paired(r) && bRows.has(key(r))).map((r) => [r, bRows.get(key(r))]);
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
