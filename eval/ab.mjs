// A/B report: two arms of one run compared task by task. The arms are
// conditions of the same run, so they met the same pages, the same prompt cache
// and, when the run is seeded, the same difficulty draws; that is what makes a
// within-run ratio worth quoting and a cross-run one not.
//
//   node eval/ab.mjs <run-dir> --ab <A>,<B> [--control <A>,<A2>] [--seed <s>]
//                    [--guard <task,...>] [--resamples <n>] [--out <file>]
//
// run.mjs --report-from <dir> --ab A,B [--control A,A2] calls abReport too.
// Every ratio is A/B: below 1 means A spent less than B. Put the build under
// test first and its baseline second, and the A/A control as the baseline and
// its copy, so the headline reads candidate/baseline. A pair holding a
// shell-assisted row (scripts/row-evidence.mjs) stays out of every figure, and
// a closing sensitivity section gives the figures with it.
//
// The statistics are exported as pure helpers so a reader can check them:
// geometric-mean ratio, a seeded hierarchical bootstrap (tasks, then the
// repeats inside each task), a sign test, an exact McNemar test and the minimum
// detectable effect.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envMismatches, frictionOf, snapshotOf } from './report.mjs';
import { browserBuilds, buildKey, countOf, drawKey, findBuild, foreignCallsOf, runFlags } from './scripts/identity.mjs';
import { shellAssistedOf, withRolloutFacts } from './scripts/row-evidence.mjs';
import { classOf, FAILURE_CLASSES, TOOL_CLASSES, triageRun } from './scripts/triage.mjs';
import { runToolStats, sumToolStats } from './scripts/tool-stats.mjs';

// z for a two-sided 0.05 test plus z for 80% power.
const Z_ALPHA = 1.959964;
const Z_POWER = 0.841621;

// Dense-page tasks where firefox-devtools-mcp spent less than playwright-mcp in
// run-2026-08-18T19-55-49-724Z (0.58-0.73 output ratio). A change that grows
// snapshots shows up here first.
export const GUARD_RAILS = ['checkout-stop', 'cart-math', 'qty-limit', 'kanban-triage'];

// --- statistics -------------------------------------------------------------

// mulberry32, seeded from an FNV-1a hash of the seed string: a small PRNG whose
// sequence is the same on every machine, so a seeded CI is reproducible.
export function rng(seed = 'ab') {
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let s = h || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
export function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// exp(mean(log(a/b))) over [a, b] pairs.
export function geoMeanRatio(pairs) {
  const logs = pairs.filter(([a, b]) => a > 0 && b > 0).map(([a, b]) => Math.log(a / b));
  return logs.length ? Math.exp(mean(logs)) : null;
}

// One task's log ratio: the mean log of A's repeats minus the mean log of B's.
export const taskDiff = ({ a, b }) => mean(a) - mean(b);

// groups: [{ a: [log values], b: [log values] }], one per task. Resamples tasks
// with replacement, then each resampled task's repeats of each arm with
// replacement, so the interval carries both task-to-task and repeat-to-repeat
// noise. With one repeat per arm it is the ordinary paired task bootstrap.
export function hierarchicalBootstrap(groups, { seed = 'ab', resamples = 10000, level = 0.95 } = {}) {
  if (!groups.length) return null;
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let total = 0;
    for (let t = 0; t < groups.length; t++) {
      const g = pick(groups);
      let sa = 0;
      for (let i = 0; i < g.a.length; i++) sa += pick(g.a);
      let sb = 0;
      for (let i = 0; i < g.b.length; i++) sb += pick(g.b);
      total += sa / g.a.length - sb / g.b.length;
    }
    stats[r] = total / groups.length;
  }
  stats.sort();
  const q = (1 - level) / 2;
  return {
    estimate: Math.exp(mean(groups.map(taskDiff))),
    lo: Math.exp(stats[Math.floor(q * resamples)]),
    hi: Math.exp(stats[Math.min(resamples - 1, Math.floor((1 - q) * resamples))]),
    resamples,
    seed: String(seed),
  };
}

// P(X <= k) for X ~ Binomial(n, 1/2), summed in log space so large n does not
// underflow.
function binomLowerTail(k, n) {
  let logp = -n * Math.LN2;
  let sum = Math.exp(logp);
  for (let i = 0; i < k; i++) {
    logp += Math.log(n - i) - Math.log(i + 1);
    sum += Math.exp(logp);
  }
  return sum;
}
export function binomTwoSided(k, n) {
  if (!n) return 1;
  return Math.min(1, 2 * binomLowerTail(Math.min(k, n - k), n));
}

// Two-sided sign test on per-task differences; ties drop out.
export function signTest(diffs) {
  const up = diffs.filter((d) => d > 0).length;
  const down = diffs.filter((d) => d < 0).length;
  return { up, down, ties: diffs.length - up - down, p: binomTwoSided(Math.min(up, down), up + down) };
}

// Exact McNemar on the discordant pairs: b pairs where only A passed, c where
// only B passed.
export const mcnemarExact = (b, c) => binomTwoSided(Math.min(b, c), b + c);

// The smallest ratio a paired comparison of n tasks detects at 80% power and a
// two-sided 0.05 level, from the SD of the per-task log ratio.
export function minimumDetectableEffect(sigma, n) {
  if (sigma == null || !n) return null;
  const delta = ((Z_ALPHA + Z_POWER) * sigma) / Math.sqrt(n);
  return { delta, up: Math.exp(delta), down: Math.exp(-delta) };
}

// Paired tasks needed to detect `ratio` at 80% power from sigma.
export function pairsNeeded(sigma, ratio) {
  return Math.ceil((((Z_ALPHA + Z_POWER) * sigma) / Math.abs(Math.log(ratio))) ** 2);
}

// --- rows -------------------------------------------------------------------

const repOf = (r) => r.rep ?? 1;
const totalInput = (r) =>
  r.input_tokens == null ? null : (r.input_tokens ?? 0) + (r.cache_creation ?? 0) + (r.cache_read ?? 0);
const METRICS = {
  output: (r) => r.output_tokens,
  turns: (r) => r.turns,
  'total input': totalInput,
  cost: (r) => r.cost_usd,
  wall: (r) => r.wall_s,
  api: (r) => r.api_s,
};

// Why a row cannot carry an efficiency figure, or null when it can.
// `assisted` holds the rows whose shell got answers from a graded fixture
// route (scripts/row-evidence.mjs), which measured the shell as well as the
// surface.
function exclusion(row, assisted = null) {
  if (row.infra) return 'infra';
  if (row.error) return 'error';
  if (row.invalid) return `invalid:${row.invalid}`;
  if (assisted?.has(row)) return 'shell-assisted';
  if (!(row.output_tokens > 0)) return 'no output tokens';
  return null;
}

// Per task, the valid values of one metric in each arm, as log groups.
function groupsFor(rowsA, rowsB, metric, keep = () => true, assisted = null) {
  const byTask = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (exclusion(r, assisted) || !keep(r)) continue;
      const v = METRICS[metric](r);
      if (!(v > 0)) continue;
      if (!m.has(r.task)) m.set(r.task, []);
      m.get(r.task).push(Math.log(v));
    }
    return m;
  };
  const a = byTask(rowsA);
  const b = byTask(rowsB);
  return [...a.keys()].filter((t) => b.has(t)).map((task) => ({ task, a: a.get(task), b: b.get(task) }));
}

const fmt = (x, d = 3) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(d));
const fmtP = (p) => (p == null ? 'n/a' : p < 0.0001 ? p.toExponential(1) : p.toFixed(4));
const ci = (b) => (b ? `${fmt(b.estimate)} [${fmt(b.lo)}, ${fmt(b.hi)}]` : 'n/a');
const pct = (x) => (x == null ? 'n/a' : `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(1)}%`);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// Sums of one metric over the (task, repeat) pairs where both arms carry a
// value, so an arm that lost rows to an exclusion is not summed over fewer rows.
function pairedSums(rowsA, rowsB, metric, assisted = null) {
  const key = (r) => `${r.task}#${repOf(r)}`;
  const value = (r) => (exclusion(r, assisted) ? null : METRICS[metric](r));
  const b = new Map(rowsB.filter((r) => value(r) != null).map((r) => [key(r), value(r)]));
  let a = 0;
  let sb = 0;
  let n = 0;
  for (const r of rowsA) {
    if (value(r) == null || !b.has(key(r))) continue;
    a += value(r);
    sb += b.get(key(r));
    n++;
  }
  return n ? { a, b: sb, n } : { a: null, b: null, n: 0 };
}

// The rows' family and areas, else what the caller loaded from the task
// definitions (identity.mjs taskInfo), else unknown.
function tagsOf(row, info) {
  const t = info?.get?.(row.task) ?? info?.[row.task];
  return {
    family: row.family ?? t?.family ?? 'unknown',
    areas: row.areas ?? t?.areas ?? [],
  };
}

// A condition's tools/list: its meta.builds entry (firefox-devtools-mcp
// builds), else its meta.surfaces entry, which every condition has, playwright-mcp
// included.
function toolsOf(meta, condition) {
  const build = findBuild(meta, condition);
  if (build?.tools) return build.tools;
  const bare = String(condition).split('/').pop();
  return meta?.surfaces?.[bare]?.tools ?? meta?.surfaces?.[bare.split('@')[0]]?.tools ?? null;
}

// The browser environments of A and B as the preflight measured them, and
// every Firefox build their rows recorded: a difference here is a difference
// the surface did not make.
function envDiff(meta, rowsA, rowsB, a, b) {
  const bare = (c) => String(c).split('/').pop();
  const env = Object.fromEntries([a, b].map((c) => [bare(c), meta.env?.[bare(c)]]).filter(([, e]) => e));
  const out = [];
  if (Object.keys(env).length === 2) {
    for (const m of envMismatches({ ...meta, env })) out.push(`- **ENV-MISMATCH**: ${m}`);
  } else {
    out.push(`- browser environment: not recorded for ${[a, b].filter((c) => !env[bare(c)]).join(' and ')}`);
  }
  const builds = browserBuilds([...rowsA, ...rowsB]);
  const describe = (c) => (builds[c] ?? []).map((x) => `${x.version ?? '?'} ${x.buildID ?? '?'} (${x.rows} rows)`).join(', ');
  if (builds[a] || builds[b]) {
    out.push(`- Firefox builds the rows ran on: A ${describe(a) || 'not recorded'}; B ${describe(b) || 'not recorded'}`);
    for (const c of [a, b]) {
      if ((builds[c] ?? []).length > 1) out.push(`- **BROWSER-CHANGED**: ${c}'s Firefox changed between attempts`);
    }
  }
  return out;
}

function toolListDiff(meta, a, b) {
  const ba = { tools: toolsOf(meta, a) };
  const bb = { tools: toolsOf(meta, b) };
  if (!ba?.tools || !bb?.tools) {
    return [`- tools/list: not recorded for ${[!ba?.tools && a, !bb?.tools && b].filter(Boolean).join(' and ')} (no meta.builds or meta.surfaces entry)`];
  }
  const na = new Set(ba.tools.names ?? []);
  const nb = new Set(bb.tools.names ?? []);
  const onlyA = [...na].filter((n) => !nb.has(n));
  const onlyB = [...nb].filter((n) => !na.has(n));
  const same = ba.tools.hash && ba.tools.hash === bb.tools.hash;
  return [
    `- tools/list: A ${ba.tools.count ?? na.size} tools, ${ba.tools.schemaChars ?? '?'} schema chars (hash ${String(ba.tools.hash ?? '?').slice(0, 12)}); ` +
      `B ${bb.tools.count ?? nb.size} tools, ${bb.tools.schemaChars ?? '?'} schema chars (hash ${String(bb.tools.hash ?? '?').slice(0, 12)})` +
      (same ? ', identical' : ''),
    ...(onlyA.length ? [`  - only in A: ${onlyA.join(', ')}`] : []),
    ...(onlyB.length ? [`  - only in B: ${onlyB.join(', ')}`] : []),
    ...(!same && !onlyA.length && !onlyB.length ? ['  - same names, different schemas'] : []),
  ];
}

function drawMismatches(rowsA, rowsB) {
  const key = (r) => `${r.task}#${repOf(r)}`;
  const b = new Map(rowsB.filter((r) => r.draws).map((r) => [key(r), r]));
  const out = [];
  let compared = 0;
  let extra = 0;
  for (const r of rowsA.filter((x) => x.draws)) {
    const other = b.get(key(r));
    if (!other) continue;
    compared++;
    const [ka, kb] = [drawKey(r.draws), drawKey(other.draws)];
    if (ka.extra || kb.extra) extra++;
    if (ka.key !== kb.key) out.push(r.task + (r.rep ? ` (r${r.rep})` : ''));
  }
  return { compared, out, extra };
}

// --- the report -------------------------------------------------------------

// `input` is a run's rows, or its whole results.json object. Options:
//   a, b       the two conditions; ratios are A/B
//   control    [C1, C2], two arms of one build (an A/A pair) whose ratio is the
//              noise floor
//   seed       bootstrap seed; defaults to the run's seed
//   meta       the run's meta, for build identity and flags
//   runDir     the run directory, for transcript-derived telemetry and triage
//              of rows that predate it
//   taskInfo   identity.mjs taskInfo(), for family and areas of rows that
//              predate the tags
//   guardRails task ids to watch; defaults to GUARD_RAILS
export function abReport(input, options = {}) {
  const meta = options.meta ?? (Array.isArray(input) ? {} : input?.meta ?? {});
  const { a, b, runDir = null, taskInfo = null } = options;
  // A codex row that predates row.code_mode reads its rollout's, and its turns
  // become the rollout's model requests (row-evidence.mjs withRolloutFacts).
  const results = (Array.isArray(input) ? input : input?.results ?? []).map((r) => withRolloutFacts(r, runDir));
  const control = typeof options.control === 'string' ? options.control.split(',') : options.control;
  const seed = options.seed ?? meta.seed ?? 'ab';
  const resamples = options.resamples ?? 10000;
  const guardRails = options.guardRails ?? GUARD_RAILS;
  const conditions = [...new Set(results.map((r) => r.condition))];
  const lines = [`# A/B: ${a} vs ${b}`, ''];
  const missing = [a, b, ...(control ?? [])].filter((c) => !conditions.includes(c));
  if (missing.length) {
    lines.push(`No rows for ${missing.join(', ')}. Conditions in this run: ${conditions.join(', ')}.`);
    return lines.join('\n') + '\n';
  }
  const rowsA = results.filter((r) => r.condition === a);
  const rowsB = results.filter((r) => r.condition === b);
  // Rows whose shell got answers from a graded fixture route: out of every
  // paired figure, which "Sensitivity: shell-assisted rows" gives with them.
  const assisted = new Set([...rowsA, ...rowsB].filter((r) => shellAssistedOf(r, runDir)));
  const excl = (r) => exclusion(r, assisted);

  // Old rows carry no surface_calls, so their validity comes from the transcripts.
  const derived = new Map();
  const needsDerived = runDir && results.some((r) => r.surface_calls == null || r.tools == null);
  if (needsDerived) {
    for (const { row, stats } of runToolStats(runDir, [...rowsA, ...rowsB])) derived.set(row, stats);
  }
  const surfaceCallsOf = (r) => (typeof r.surface_calls === 'number' ? r.surface_calls : derived.get(r)?.surface_calls ?? null);
  const triages = triageRun(results, { runDir, tasks: taskInfo });
  const triageOf = new Map(results.map((r, i) => [r, triages[i]]));

  // --- validity ---
  const flags = runFlags(meta, results, { runDir });
  lines.push(
    `A = \`${a}\`, B = \`${b}\`. Every ratio below is A/B: under 1 means A spent less.`,
    '',
    '## Validity',
    '',
    `- run: ${meta.date ?? '?'} · backend ${meta.backend ?? '?'} · models ${Object.entries(meta.models ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '?'} · ` +
      `effort ${meta.effort ?? '?'} · suite ${meta.suite ?? '?'} · serving ${meta.serving ?? 'single-origin (not recorded)'}` +
      ` · eval ${meta.git?.commit ? `${meta.git.commit.slice(0, 10)}${meta.git.dirty ? ' (dirty)' : ''}` : 'commit not recorded'}`,
    `- run seed: ${meta.seed ?? 'NONE'}; bootstrap seed: ${seed}, ${resamples} resamples`,
  );
  // The shell-assisted rows are named, pair by pair, further down.
  for (const f of flags.filter((f) => f.flag !== 'shell-assisted')) lines.push(`- **${f.flag.toUpperCase()}**: ${f.why}`);
  for (const c of [a, b]) {
    const k = buildKey(meta, c);
    lines.push(
      `- build ${c}: ${
        k.unknown
          ? 'not recorded'
          : [
              k.version && `version ${k.version}`,
              k.sha256 && `sha256 ${k.sha256.slice(0, 12)}`,
              k.walkerSha256 && `walker ${k.walkerSha256.slice(0, 12)}`,
              k.commit && `commit ${k.commit.slice(0, 10)}${k.dirty ? ' (dirty)' : ''}`,
              k.command && `command ${k.command}`,
            ]
              .filter(Boolean)
              .join(', ') || 'recorded without identity'
      }`
    );
  }
  lines.push(...toolListDiff(meta, a, b));
  lines.push(...envDiff(meta, rowsA, rowsB, a, b));
  const tasksA = new Set(rowsA.map((r) => r.task));
  const tasksB = new Set(rowsB.map((r) => r.task));
  const onlyA = [...tasksA].filter((t) => !tasksB.has(t));
  const onlyB = [...tasksB].filter((t) => !tasksA.has(t));
  lines.push(
    `- tasks: ${tasksA.size} in A, ${tasksB.size} in B, ${[...tasksA].filter((t) => tasksB.has(t)).length} in both` +
      (onlyA.length ? `; only A: ${onlyA.join(', ')}` : '') +
      (onlyB.length ? `; only B: ${onlyB.join(', ')}` : ''),
  );
  if (meta.taskHashes) {
    const hashed = [...tasksA].filter((t) => meta.taskHashes[t]).length;
    lines.push(`- task hashes: ${hashed} of ${tasksA.size} tasks hashed in meta.taskHashes; both arms ran one process's definitions`);
  } else {
    lines.push("- task hashes: not recorded; both arms ran one process's definitions, but a regrade or a cross-run comparison cannot check them");
  }
  const excluded = (rows) => {
    const counts = {};
    for (const r of rows) {
      const why = excl(r);
      if (why) counts[why] = (counts[why] ?? 0) + 1;
    }
    return Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  };
  lines.push(`- rows excluded from efficiency: A ${excluded(rowsA)}; B ${excluded(rowsB)}`);
  const foreignOf = (r) => (r.foreign_tools != null ? foreignCallsOf(r) : countOf(derived.get(r)?.foreign_tools));
  const foreign = (rows) => rows.filter((r) => foreignOf(r) > 0).length;
  const noSurface = (rows) => rows.filter((r) => surfaceCallsOf(r) === 0).length;
  if (needsDerived) {
    lines.push(
      `- from transcripts (the rows predate the telemetry): rows that never called their own surface A ${noSurface(rowsA)}, ` +
        `B ${noSurface(rowsB)}; rows that called another MCP server A ${foreign(rowsA)}, B ${foreign(rowsB)}`
    );
  } else {
    lines.push(`- rows that called another MCP server: A ${foreign(rowsA)}, B ${foreign(rowsB)}`);
  }
  const draws = drawMismatches(rowsA, rowsB);
  if (draws.compared) {
    lines.push(
      draws.out.length
        ? `- DRAWS DIFFER on ${draws.out.length} of ${draws.compared} paired rows, so those pairs faced different variants: ${draws.out.slice(0, 8).join(', ')}`
        : `- draws: the same first pick per scope on all ${draws.compared} paired rows`,
      ...(draws.extra ? [`  - ${draws.extra} paired row(s) drew a scope again in a later session; only first picks are compared`] : [])
    );
  } else {
    lines.push('- draws: not recorded on the rows, so paired rows are not known to have faced the same variants');
  }

  if (assisted.size) {
    const list = (rows) => rows.filter((r) => assisted.has(r)).map((r) => r.task + (r.rep ? ` (r${r.rep})` : '')).join(', ') || 'none';
    lines.push(
      `- **SHELL-ASSISTED**: ${assisted.size} row(s) got answers through the agent's shell from a graded fixture route, ` +
        `so every pair holding one is left out below: A ${list(rowsA)}; B ${list(rowsB)}`
    );
  }

  // --- primary ---
  const groups = groupsFor(rowsA, rowsB, 'output', undefined, assisted);
  const boot = hierarchicalBootstrap(groups, { seed, resamples });
  const diffs = groups.map(taskDiff);
  const sign = signTest(diffs);
  const sigma = sd(diffs);
  const mde = minimumDetectableEffect(sigma, groups.length);
  const repsA = groups.reduce((n, g) => n + g.a.length, 0);
  const repsB = groups.reduce((n, g) => n + g.b.length, 0);
  const sums = pairedSums(rowsA, rowsB, 'output', assisted);
  lines.push(
    '',
    '## Output tokens (primary)',
    '',
    `- geometric-mean ratio A/B: **${ci(boot)}** (95% hierarchical bootstrap, tasks then repeats), ` +
      `${groups.length} tasks, ${repsA} A rows and ${repsB} B rows`,
    `- A higher on ${sign.up} tasks, lower on ${sign.down}, tied on ${sign.ties}; sign test p=${fmtP(sign.p)}`,
    `- ratio of sums ${fmt(sums.a && sums.b ? sums.a / sums.b : null)} (${sums.a} vs ${sums.b} over ${sums.n} paired rows); a few long tasks dominate a sum, so the geometric mean is the headline`,
    `- SD of the per-task log ratio ${fmt(sigma)}; minimum detectable effect at 80% power: ` +
      (mde ? `x${fmt(mde.up)} or x${fmt(mde.down)} (${pct(mde.down)})` : 'n/a'),
  );
  let controlBoot = null;
  let controlSigma = null;
  if (control?.length === 2) {
    const [c1, c2] = control;
    const cg = groupsFor(
      results.filter((r) => r.condition === c1),
      results.filter((r) => r.condition === c2),
      'output'
    );
    controlBoot = hierarchicalBootstrap(cg, { seed, resamples });
    controlSigma = sd(cg.map(taskDiff));
    const cmde = minimumDetectableEffect(controlSigma, groups.length);
    const where = !boot || !controlBoot
      ? 'n/a'
      : boot.estimate < controlBoot.lo ? 'below' : boot.estimate > controlBoot.hi ? 'ABOVE' : 'INSIDE';
    lines.push(
      `- A/A control ${c1}/${c2}: ${ci(controlBoot)} over ${cg.length} tasks; SD ${fmt(controlSigma)}, ` +
        `so the noise-floor MDE for ${groups.length} tasks is ` +
        (cmde ? `x${fmt(cmde.up)} or x${fmt(cmde.down)}` : 'n/a'),
      `- the primary estimate lies ${where} the A/A band` +
        (controlBoot && (controlBoot.lo > 1 || controlBoot.hi < 1) ? '; the A/A CI itself excludes 1, so the arms differ by more than their build' : ''),
    );
  }
  const planSigma = controlSigma ?? sigma;
  if (planSigma) {
    lines.push(
      `- paired tasks needed at 80% power from SD ${fmt(planSigma)}${controlSigma ? ' (A/A)' : ' (this pair, an upper bound on noise)'}: ` +
        [0.7, 0.8, 0.9, 0.95].map((r) => `${pct(r)} ${pairsNeeded(planSigma, r)}`).join(', ')
    );
  }

  // --- secondary ---
  lines.push('', '## Secondary metrics', '', 'Sums run over the paired rows where both arms carry the metric.', '', '| metric | GM ratio A/B [95% CI] | tasks | paired rows | sum A | sum B |', '|---|---|---|---|---|---|');
  for (const metric of ['turns', 'total input', 'cost', 'wall', 'api']) {
    const g = groupsFor(rowsA, rowsB, metric, undefined, assisted);
    const bs = g.length ? hierarchicalBootstrap(g, { seed, resamples: Math.min(resamples, 4000) }) : null;
    const { a: sa, b: sb, n } = pairedSums(rowsA, rowsB, metric, assisted);
    const note = metric === 'cost' ? ' (within this run only)' : metric === 'wall' ? ' (machine noise)' : '';
    lines.push(
      `| ${metric}${note} | ${bs ? ci(bs) : 'n/a'} | ${g.length} | ${n} | ${sa == null ? 'n/a' : +sa.toFixed(4)} | ${sb == null ? 'n/a' : +sb.toFixed(4)} |`
    );
  }

  // --- passes and flips ---
  const pairKey = (r) => `${r.task}#${repOf(r)}`;
  const bByKey = new Map(rowsB.map((r) => [pairKey(r), r]));
  const pairsWith = (keepShell) =>
    rowsA
      .filter((r) => bByKey.has(pairKey(r)))
      .map((r) => [r, bByKey.get(pairKey(r))])
      .filter(([x, y]) => [x, y].every((z) => !z.infra && !z.invalid && (keepShell || !assisted.has(z))));
  const pairs = pairsWith(false);
  const aOnly = pairs.filter(([x, y]) => x.success && !y.success);
  const bOnly = pairs.filter(([x, y]) => !x.success && y.success);
  lines.push(
    '',
    '## Pass rate (a guard, not an endpoint)',
    '',
    `- A ${pairs.filter(([x]) => x.success).length}/${pairs.length}, B ${pairs.filter(([, y]) => y.success).length}/${pairs.length} over paired rows (infra, invalid and shell-assisted rows excluded)`,
    `- flips: A-only passes ${aOnly.length}, B-only passes ${bOnly.length}; exact McNemar p=${fmtP(mcnemarExact(aOnly.length, bOnly.length))}`,
  );
  const flipLine = (failed, passedArm) => {
    const t = triageOf.get(failed);
    const cls = classOf(t) ?? 'untriaged';
    return (
      `  - ${failed.task}${failed.rep ? ` (r${failed.rep})` : ''}: ${passedArm} passed, ${failed.condition} failed: ` +
      `**${cls}** (${FAILURE_CLASSES[cls]?.owner ?? '?'})${t?.evidence ? `: ${cell(t.evidence).slice(0, 200)}` : ''}`
    );
  };
  for (const [x, y] of aOnly) lines.push(flipLine(y, 'A'));
  for (const [x, y] of bOnly) lines.push(flipLine(x, 'B'));

  // --- breakdowns ---
  const breakdown = (title, keysOf) => {
    const buckets = new Map();
    for (const g of groups) {
      const row = rowsA.find((r) => r.task === g.task);
      for (const k of keysOf(tagsOf(row, taskInfo))) {
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(g);
      }
    }
    if (!buckets.size) return [];
    const out = ['', `## By ${title}`, '', `| ${title} | tasks | GM ratio A/B [95% CI] | A higher | pass A | pass B |`, '|---|---|---|---|---|---|'];
    for (const [k, gs] of [...buckets].sort((x, y) => y[1].length - x[1].length)) {
      const bs = hierarchicalBootstrap(gs, { seed, resamples: Math.min(resamples, 4000) });
      const tasks = new Set(gs.map((g) => g.task));
      const passA = pairs.filter(([x]) => tasks.has(x.task) && x.success).length;
      const passB = pairs.filter(([, y]) => tasks.has(y.task) && y.success).length;
      const n = pairs.filter(([x]) => tasks.has(x.task)).length;
      out.push(`| ${k} | ${gs.length} | ${gs.length > 1 ? ci(bs) : fmt(bs.estimate)} | ${gs.filter((g) => taskDiff(g) > 0).length}/${gs.length} | ${passA}/${n} | ${passB}/${n} |`);
    }
    return out;
  };
  lines.push(...breakdown('family', (t) => [t.family]));
  const tagged = groups.some((g) => tagsOf(rowsA.find((r) => r.task === g.task), taskInfo).areas.length);
  if (tagged) lines.push(...breakdown('area', (t) => (t.areas.length ? t.areas : ['(untagged)'])));
  else lines.push('', '## By area', '', 'No row or task definition carries capability areas (eval/tasks/areas.json).');

  // --- per-tool diff ---
  const pairedTasks = new Set(groups.map((g) => g.task));
  const toolsOf = (rows) => {
    const valid = rows.filter((r) => pairedTasks.has(r.task) && !excl(r));
    const fromRows = valid.filter((r) => r.tools && typeof r.tools === 'object');
    if (fromRows.length === valid.length && valid.length) {
      const sum = {};
      for (const r of valid) {
        for (const [name, t] of Object.entries(r.tools)) {
          const s = (sum[name] ??= { calls: 0, errors: 0, chars: 0, ms: [] });
          s.calls += t.calls ?? 0;
          s.errors += t.errors ?? 0;
          s.chars += t.chars ?? 0;
          if (t.p50_ms != null) s.ms.push(t.p50_ms);
        }
      }
      return { rows: valid.length, source: 'tap', tools: sum, stats: null };
    }
    if (!runDir) return null;
    const stats = sumToolStats(valid.map((r) => derived.get(r)).filter(Boolean));
    const tools = Object.fromEntries(
      Object.entries(stats.tools).map(([k, t]) => [k, { calls: t.calls, errors: t.errors, chars: t.chars, ms: t.p50_ms != null ? [t.p50_ms] : [] }])
    );
    return { rows: stats.rows, source: 'transcripts', tools, stats };
  };
  const ta = toolsOf(rowsA);
  const tb = toolsOf(rowsB);
  if (ta && tb) {
    lines.push(
      '',
      '## Per tool',
      '',
      `Calls per paired row, errors per 100 calls, output characters per call, and the median of per-row p50 latency ` +
        `(from ${ta.source === tb.source ? ta.source : `${ta.source} for A, ${tb.source} for B`}; codex rows carry no latency).`,
      '',
      '| tool | calls/row A | calls/row B | err/100 A | err/100 B | chars/call A | chars/call B | p50 ms A | p50 ms B |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    const names = [...new Set([...Object.keys(ta.tools), ...Object.keys(tb.tools)])].sort(
      (x, y) => (tb.tools[y]?.calls ?? 0) + (ta.tools[y]?.calls ?? 0) - (tb.tools[x]?.calls ?? 0) - (ta.tools[x]?.calls ?? 0)
    );
    const col = (side, name, f) => (side.tools[name] ? f(side.tools[name], side.rows) : '-');
    for (const name of names) {
      lines.push(
        `| ${name} | ${col(ta, name, (t, n) => fmt(t.calls / n, 2))} | ${col(tb, name, (t, n) => fmt(t.calls / n, 2))} | ` +
          `${col(ta, name, (t) => fmt((100 * t.errors) / t.calls, 1))} | ${col(tb, name, (t) => fmt((100 * t.errors) / t.calls, 1))} | ` +
          `${col(ta, name, (t) => Math.round(t.chars / t.calls))} | ${col(tb, name, (t) => Math.round(t.chars / t.calls))} | ` +
          `${col(ta, name, (t) => fmt(median(t.ms), 0))} | ${col(tb, name, (t) => fmt(median(t.ms), 0))} |`
      );
    }
    // Friction as report.mjs counts it: a row's counters, those newer than its
    // recorder re-read from its transcript, a codex code-mode row's exec cells
    // and the validator's no-op count.
    const mech = (side, rows) => {
      const valid = rows.filter((r) => pairedTasks.has(r.task) && !excl(r));
      const fr = (k) => {
        if (valid.every((r) => r.friction)) return valid.reduce((n, r) => n + (frictionOf(r, runDir)[k] ?? 0), 0);
        return side.stats?.friction?.[k] ?? null;
      };
      // Snapshot files the agent read back count as snapshot characters
      // (report.mjs snapshotOf).
      const sn = (k) => {
        if (valid.every((r) => r.snapshot)) return valid.reduce((n, r) => n + (snapshotOf(r, runDir)[k] ?? 0), 0);
        return side.stats?.snapshot?.[k] ?? null;
      };
      const per = (x, d = 2) => (x == null ? 'n/a' : fmt(x / side.rows, d));
      return {
        scripts: per(fr('eval_calls')),
        actSnap: fr('act_then_snap'),
        actions: fr('actions'),
        snapChars: per(sn('chars'), 0),
        cut: per(sn('truncated')),
        fileReads: per(sn('file_reads')),
        stale: per(fr('stale_uid')),
        malformed: per(fr('malformed_uid')),
        restarts: per(fr('restarts')),
        sleeps: per(fr('sleeps')),
        discovery: per(fr('tool_search')),
        // Only a codex code-mode row records the outputs codex cut; with none,
        // the count is unknown rather than zero.
        harnessCut: valid.some((r) => r.code_mode) ? per(fr('harness_truncated')) : 'n/a',
        noops: per(fr('noops')),
        // Only an Agent SDK row records the SDK's own API retries.
        retries: valid.some((r) => frictionOf(r, runDir).api_retries != null) ? per(fr('api_retries')) : 'n/a',
        // A codex row written before row.code_mode existed hides the waits and
        // the tool discovery its exec cells ran.
        blind: valid.filter((r) => r.backend === 'codex' && !r.code_mode).length,
      };
    };
    const ma = mech(ta, rowsA);
    const mb = mech(tb, rowsB);
    const rate = (m) => (m.actSnap == null ? 'n/a' : m.actions ? `${fmt(m.actSnap / m.actions, 2)} (${m.actSnap}/${m.actions})` : `${m.actSnap} (actions not recorded)`);
    lines.push(
      '',
      '| mechanism, per row | A | B |',
      '|---|---|---|',
      `| script calls | ${ma.scripts} | ${mb.scripts} |`,
      `| action followed by a snapshot | ${rate(ma)} | ${rate(mb)} |`,
      `| snapshot characters, snapshot files read back included | ${ma.snapChars} | ${mb.snapChars} |`,
      `| snapshot files read back | ${ma.fileReads} | ${mb.fileReads} |`,
      `| snapshots with a cut | ${ma.cut} | ${mb.cut} |`,
      `| stale-uid replies | ${ma.stale} | ${mb.stale} |`,
      `| malformed uids the tool called stale | ${ma.malformed} | ${mb.malformed} |`,
      `| browser restarts | ${ma.restarts} | ${mb.restarts} |`,
      `| waits and sleeps | ${ma.sleeps} | ${mb.sleeps} |`,
      `| tool discovery calls | ${ma.discovery} | ${mb.discovery} |`,
      `| tool outputs the harness cut | ${ma.harnessCut} | ${mb.harnessCut} |`,
      `| no-ops and misses the validators counted | ${ma.noops} | ${mb.noops} |`,
      `| API retries (wall time, not the surface) | ${ma.retries} | ${mb.retries} |`,
    );
    if (ma.blind || mb.blind) {
      lines.push(
        '',
        `Waits and tool discovery leave out what codex exec cells ran on ${ma.blind} A and ${mb.blind} B rows, ` +
          'which predate row.code_mode: a wait an agent slept in a cell, between tool calls, is in no MCP event. ' +
          'The outputs the harness cut are not counted on those rows either.'
      );
    }
  } else {
    lines.push('', '## Per tool', '', 'Rows carry no `tools` telemetry and no run directory was given to derive it from transcripts.');
  }

  // --- guard rails ---
  const perTask = new Map(groups.map((g) => [g.task, Math.exp(taskDiff(g))]));
  const band = controlSigma ? [Math.exp(-Z_ALPHA * controlSigma), Math.exp(Z_ALPHA * controlSigma)] : null;
  const inBand = (r) => (!band ? 'no A/A band' : r > band[1] ? 'ABOVE' : r < band[0] ? 'below' : 'within');
  const inputGroups = groupsFor(rowsA, rowsB, 'total input', undefined, assisted);
  const inputRatio = inputGroups.length ? Math.exp(mean(inputGroups.map(taskDiff))) : null;
  const toolFails = (rows, pairsFailedIn) =>
    pairsFailedIn.filter((r) => TOOL_CLASSES.has(classOf(triageOf.get(r)))).map((r) => `${r.task} (${classOf(triageOf.get(r))})`);
  const newToolFailsA = toolFails(rowsA, bOnly.map(([x]) => x));
  const newToolFailsB = toolFails(rowsB, aOnly.map(([, y]) => y));
  lines.push(
    '',
    '## Guard rails',
    '',
    band
      ? `Per-task A/A band from the control's SD: [${fmt(band[0])}, ${fmt(band[1])}].`
      : 'No A/A control, so there is no per-task noise band; run one before reading a single task.',
    '',
    '| guard | A/B | band |',
    '|---|---|---|',
    ...guardRails.map((t) => (perTask.has(t) ? `| ${t} | ${fmt(perTask.get(t))} | ${inBand(perTask.get(t))} |` : `| ${t} | not paired | |`)),
    `| total input, geometric mean over tasks | ${fmt(inputRatio)} | ${inputRatio != null && inputRatio > 1.2 ? 'OVER the +20% budget' : 'within +20%'} |`,
    '',
    `- A failures a tool class explains where B passed: ${newToolFailsA.join(', ') || 'none'}`,
    `- B failures a tool class explains where A passed: ${newToolFailsB.join(', ') || 'none'}`,
  );
  // One-sided, reading A as the candidate and B as its baseline: a change ships
  // when it costs less, so a CI wholly above 1 or a guard rail cheaper than the
  // band must not tick a box.
  if (control?.length === 2 && boot && controlBoot) {
    const below1 = boot.hi < 1;
    const belowBand = boot.estimate < controlBoot.lo;
    const pairedGuards = guardRails.filter((t) => perTask.has(t));
    const guardsOk = !!band && pairedGuards.length > 0 && pairedGuards.every((t) => perTask.get(t) <= band[1]);
    lines.push(
      '',
      'Mechanical checks from eval/README.md, "Measuring a tool change", reading A as the candidate. They are necessary, not sufficient: the mechanism metric and the cost still need a reader.',
      '',
      `- [${below1 ? 'x' : ' '}] the primary CI lies below 1`,
      `- [${belowBand ? 'x' : ' '}] the primary estimate lies below the A/A band`,
      `- [${newToolFailsA.length ? ' ' : 'x'}] no new A failure that triage attributes to the tool`,
      `- [${guardsOk ? 'x' : ' '}] no paired guard rail lies above the per-task A/A band` +
        (pairedGuards.length ? ` (${pairedGuards.length} paired)` : ' (NOT RUN: no guard rail was paired)'),
      `- [${inputRatio != null && inputRatio <= 1.2 ? 'x' : ' '}] total input up no more than 20%`,
    );
  }

  // --- per task ---
  const med = (rows) => median(rows.filter((r) => !excl(r)).map((r) => r.output_tokens));
  const passes = (rows) => {
    const graded = rows.filter((r) => !r.infra && !r.invalid && !assisted.has(r));
    const shelled = rows.filter((r) => assisted.has(r));
    return `${graded.filter((r) => r.success).length}/${graded.length}${shelled.length ? ` (+${shelled.length} shell-assisted)` : ''}`;
  };
  const classes = (rows) => [...new Set(rows.filter((r) => !r.success).map((r) => classOf(triageOf.get(r)) ?? 'untriaged'))].join(', ');
  lines.push(
    '',
    '## Per task',
    '',
    'Median output per arm across repeats; ratio is the per-task geometric mean A/B; passes leave out infra, invalid and shell-assisted rows; class is the triage of failed rows.',
    '',
    '| task | family | areas | output A | output B | A/B | pass A | pass B | failure class A | failure class B |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  const allTasks = [...new Set([...tasksA, ...tasksB])].sort((x, y) => (perTask.get(y) ?? 0) - (perTask.get(x) ?? 0));
  for (const task of allTasks) {
    const ra = rowsA.filter((r) => r.task === task);
    const rb = rowsB.filter((r) => r.task === task);
    const tags = tagsOf(ra[0] ?? rb[0], taskInfo);
    lines.push(
      `| ${task} | ${tags.family} | ${tags.areas.join(', ')} | ${med(ra) ?? 'n/a'} | ${med(rb) ?? 'n/a'} | ` +
        `${fmt(perTask.get(task) ?? null)} | ${passes(ra)} | ${passes(rb)} | ${classes(ra)} | ${classes(rb)} |`
    );
  }

  // Old rows that never called their surface stay in the primary figure, because
  // nothing on the row marks them; this is how much they move it.
  if (needsDerived) {
    const cg = groupsFor(rowsA, rowsB, 'output', (r) => surfaceCallsOf(r) !== 0, assisted);
    const cb = hierarchicalBootstrap(cg, { seed, resamples });
    lines.push(
      '',
      '## Sensitivity: rows that never called their surface',
      '',
      `These rows carry no \`invalid\` mark, so the primary figure keeps them. Dropping every pair with such a row: ` +
        `${ci(cb)} over ${cg.length} tasks (median per-task ratio ${fmt(Math.exp(median(cg.map(taskDiff))))}).` +
        (results.some((r) => foreignOf(r) > 0 && surfaceCallsOf(r) !== 0)
          ? ' Rows that called a foreign server as well as their own stay in both figures.'
          : ''),
    );
  }
  // The same figures with the shell-assisted rows kept, for a reader who
  // counts a shell's answer as the agent's.
  if (assisted.size) {
    const all = pairsWith(true);
    const onlyA = all.filter(([x, y]) => x.success && !y.success).length;
    const onlyB = all.filter(([x, y]) => !x.success && y.success).length;
    const withShell = (metric) => {
      const g = groupsFor(rowsA, rowsB, metric);
      return { g, bs: g.length ? hierarchicalBootstrap(g, { seed, resamples: metric === 'output' ? resamples : Math.min(resamples, 4000) }) : null };
    };
    const out = withShell('output');
    lines.push(
      '',
      '## Sensitivity: shell-assisted rows',
      '',
      `With the ${assisted.size} shell-assisted row(s) kept: output ${ci(out.bs)} over ${out.g.length} tasks; ` +
        ['turns', 'total input', 'cost'].map((m) => `${m} ${ci(withShell(m).bs)}`).join('; ') +
        `; pass A ${all.filter(([x]) => x.success).length}/${all.length}, B ${all.filter(([, y]) => y.success).length}/${all.length}, ` +
        `flips A-only ${onlyA}, B-only ${onlyB} (McNemar p=${fmtP(mcnemarExact(onlyA, onlyB))}).`,
    );
  }
  return lines.join('\n') + '\n';
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const VALUED = new Set(['--ab', '--control', '--seed', '--out', '--guard', '--resamples']);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const dir = args.find((x, i) => !x.startsWith('--') && !VALUED.has(args[i - 1]));
  const ab = flag('ab')?.split(',');
  if (!dir || !ab || ab.length !== 2 || !existsSync(join(dir, 'results.json'))) {
    console.error('usage: node eval/ab.mjs <run-dir> --ab <A>,<B> [--control <A>,<A2>] [--seed <s>] [--guard <ids>] [--resamples <n>] [--out <file>]');
    process.exit(1);
  }
  const run = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  const { taskInfo } = await import('./scripts/identity.mjs');
  const md = abReport(run, {
    a: ab[0],
    b: ab[1],
    control: flag('control')?.split(','),
    seed: flag('seed') ?? undefined,
    resamples: flag('resamples') ? Number(flag('resamples')) : undefined,
    guardRails: flag('guard')?.split(','),
    runDir: dir,
    taskInfo: await taskInfo(),
  });
  const out = flag('out');
  if (out) {
    writeFileSync(resolve(out), md);
    console.log(`wrote ${resolve(out)}`);
  } else {
    process.stdout.write(md);
  }
}
