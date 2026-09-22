// The A/B statistics (ab.mjs) checked against what they claim, with no browser
// and no model, so it costs the gate nothing (statsCheckFailures): the t and
// binomial tails against exact values, the figures abReport prints against the
// helpers applied to its rows, the ratios ab.mjs, compare.mjs and report.mjs
// print against a reshuffle of their rows, ab.mjs's and compare.mjs's against
// their arms swapped, and the interval, the sign test, the minimum detectable
// effect and the per-task band against simulated runs whose noise is the
// stored A/A sweeps' (stats-aa.json). Every simulation is seeded, so a check
// passes or fails the same way on every run.
//
//   node eval/scripts/stats-checks.mjs            the checks, then each measured rate
//   node eval/scripts/stats-checks.mjs --repeats <run-dir> [...]
//                                                the SD of a task's repeats per condition
//   node eval/scripts/stats-checks.mjs --refresh [--root <results-dir>]
//                                                stats-aa.json again from the stored runs it names
//
// To take the noise from another A/A sweep, set an entry's "run", "a" and "b"
// in stats-aa.json to that run and its two labels of one build, then --refresh.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  abReport,
  binomTwoSided,
  GUARD_RAILS,
  groupsFor,
  mcnemarExact,
  mean,
  MIN_TASKS,
  minimumDetectableEffect,
  normalCdf,
  pairsNeeded,
  passFlips,
  perTaskBand,
  rng,
  sd,
  signTest,
  taskBootstrap,
  taskDiff,
  tQuantile,
} from '../ab.mjs';
import { markdownReport, totalsByCondition } from '../report.mjs';
import { isRunDir, readRun, RESULTS_ROOT } from '../run-files.mjs';
import { buildKey } from './identity.mjs';
import { shellAssistedOf, withRolloutFacts } from './row-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AA_FILE = join(HERE, 'stats-aa.json');
const COMPARE = join(HERE, 'compare.mjs');
const AA = JSON.parse(readFileSync(AA_FILE, 'utf8'));
const logRatios = (name) => AA[name].tasks.map(([, a, b]) => Math.log(a) - Math.log(b));

// Simulated runs per design: SIMS at 36 and 102 tasks, SMALL_SIMS at 12 tasks
// and under, where the checks that tell a bug from a correct build live; and
// bootstrap resamples per run, which cover as 10,000 do at 6 and 8 tasks.
const SIMS = 1000;
const SMALL_SIMS = 4000;
const RESAMPLES = 1000;

// The ranges a correct build's true rates lie in. In 8,000 to 20,000 seeded
// runs of the stored A/A noise the interval covers 94.3-94.7% at 102 and 36
// tasks and at 12 tasks of three repeats, and 92.7-93.8% at 6 and 8 tasks at
// one repeat, where heavy tails and few tasks cost a point or two; at the MDE
// the report prints, the CI excludes 1 in 79.5-80.5% of runs at 102 tasks and
// 12 x 3. The bugs they guard against measure outside them: plain percentiles
// cover 90.7% at 12 x 3 and 82.8-87.2% at 6 and 8 tasks, and exclude 1 at the
// MDE in 87-88% at 12 x 3; resampling repeats inside tasks covers 97.5-97.8%
// at 12 x 3 and excludes 1 at the MDE in 72%.
const COVERAGE = [0.93, 0.96];
const SMALL_COVERAGE = [0.91, 0.96];
const POWER = [0.77, 0.83];

// A rate measured over `sims` runs passes when it lies within four Monte Carlo
// SEs of the range its true value must lie in, so a correct build fails one
// such check at most about once in 30,000 reseeds: a change to the draws, to
// SIMS or to stats-aa.json is a reseed, and must not turn the gate red.
function rateWithin(what, x, sims, [lo, hi]) {
  const se = (p) => Math.sqrt((p * (1 - p)) / sims);
  const [from, to] = [lo - 4 * se(lo), hi + 4 * se(hi)];
  return (x >= from && x <= to) || `${what} ${x.toFixed(4)} over ${sims} runs, outside [${from.toFixed(4)}, ${to.toFixed(4)}]`;
}

// One simulated run: `tasks` tasks at `repeats` repeats per arm, each task's A
// log output moved by shift(rand), its effect. At one repeat a task's log ratio
// is a stored A/A task's with its sign flipped at random: two identical arms
// swap without changing anything, so the flip makes the true ratio exactly 1
// and keeps the stored spread and tails. At more repeats each row's noise is a
// stored log ratio over sqrt(2), sign flipped, which keeps a one-repeat task's
// SD; the stored runs' repeats are consistent with that (eval/README.md,
// "Budget").
function simulate(d, { tasks, repeats, shift = () => 0, arms = ['a', 'b'] }, rand) {
  const flip = (x) => (rand() < 0.5 ? -x : x);
  const draw = () => flip(d[Math.floor(rand() * d.length)] / Math.SQRT2);
  return Array.from({ length: tasks }, (_, t) => {
    const task = `t${String(t).padStart(3, '0')}`;
    const effect = shift(rand);
    if (repeats === 1 && arms.length === 2) return { task, a: [flip(d[Math.floor(rand() * d.length)]) + effect], b: [0] };
    const g = { task };
    for (const arm of arms) g[arm] = Array.from({ length: repeats }, () => draw() + (arm === 'a' ? effect : 0));
    return g;
  });
}

// The design's own SD of the per-task log ratio: E[d^2] / repeats, since the
// sign flips centre the stored ratios on 0.
const designSigma = (d, repeats) => Math.sqrt(mean(d.map((x) => x * x)) / repeats);

// The rates one design gives over `sims` seeded runs: the interval's coverage of
// the true ratio, how often it excludes 1, and how often the sign test rejects
// at 0.05.
function measure(name, design, truth = 1, label = '', sims = SIMS) {
  const d = logRatios(name);
  const rand = rng(`stats-${name}-${design.tasks}x${design.repeats}-${truth}-${label}`);
  let covered = 0;
  let excludes = 0;
  let signed = 0;
  for (let s = 0; s < sims; s++) {
    const groups = simulate(d, design, rand);
    const boot = taskBootstrap(groups, { seed: `r${s}`, resamples: RESAMPLES });
    if (boot.lo <= truth && truth <= boot.hi) covered++;
    if (boot.lo > 1 || boot.hi < 1) excludes++;
    if (signTest(groups.map(taskDiff)).p <= 0.05) signed++;
  }
  return { coverage: covered / sims, excludes: excludes / sims, sign: signed / sims };
}

// The exact size of the two-sided sign test at level 0.05 over n tasks when
// each ties with probability `tie`: the chance a run with no effect rejects.
function signTestSize(n, tie = 0) {
  const sizeAt = (m) => {
    let size = 0;
    for (let k = 0; k <= m; k++) {
      if (binomTwoSided(Math.min(k, m - k), m) > 0.05) continue;
      size += Math.exp(logChoose(m, k) - m * Math.LN2);
    }
    return size;
  };
  if (!tie) return sizeAt(n);
  let total = 0;
  for (let m = 0; m <= n; m++) total += Math.exp(logChoose(n, m) + m * Math.log(1 - tie) + (n - m) * Math.log(tie)) * sizeAt(m);
  return total;
}
function logChoose(n, k) {
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

// A candidate, its baseline and the baseline's copy, as abReport reads them:
// how often the ship rule's two statistical checks hold, the primary CI below 1
// and the primary estimate below the A/A CI.
function shipRate(name, { tasks, repeats, shift }) {
  const d = logRatios(name);
  const rand = rng(`ship-${name}-${tasks}-${repeats}-${shift}`);
  let shipped = 0;
  for (let s = 0; s < SIMS; s++) {
    const g = simulate(d, { tasks, repeats, shift: () => shift, arms: ['a', 'b', 'c'] }, rand);
    const primary = taskBootstrap(g.map(({ task, a, b }) => ({ task, a, b })), { seed: `r${s}`, resamples: RESAMPLES });
    const control = taskBootstrap(g.map(({ task, c, b }) => ({ task, a: c, b })), { seed: `r${s}`, resamples: RESAMPLES });
    if (primary.hi < 1 && primary.estimate < control.lo) shipped++;
  }
  return shipped / SIMS;
}

// Kurtosis, 3 for normal noise.
function kurtosis(xs) {
  const m = mean(xs);
  const v = mean(xs.map((x) => (x - m) ** 2));
  return mean(xs.map((x) => (x - m) ** 4)) / v ** 2;
}

const [CAND, BASE, COPY] = ['firefox-devtools-mcp@cand', 'firefox-devtools-mcp@base', 'firefox-devtools-mcp@aa'];

// A run's rows from a stored A/A sweep's outputs: A and B as recorded, a
// second and third repeat of every third task, a copy of B for the control
// whose noise is 0.8 of the stored ratios' and which misses every fifth task,
// a few failures, an infra and an error row, and two tasks only A ran, so
// every section of the report has figures to print. `scale` multiplies A's
// output.
function syntheticRows(name, scale = 1) {
  const rand = rng(`rows-${name}`);
  const d = logRatios(name);
  const rows = [];
  const row = (condition, task, rep, output, success = true, extra = {}) => ({
    task, condition, rep, success, output_tokens: output, turns: 2 + Math.round(output / 700),
    input_tokens: 40 * output, cache_creation: 0, cache_read: 300 * output, cost_usd: output * 7e-5, wall_s: output / 90,
    family: ['forms', 'commerce', 'auth'][task.length % 3], ...extra,
  });
  AA[name].tasks.forEach(([task, a, b], i) => {
    for (let rep = 1; rep <= (i % 3 ? 1 : 3); rep++) {
      const jitter = rep === 1 ? 1 : Math.exp(d[(i * 7 + rep) % d.length] / 2);
      const copy = Math.round(b * jitter * Math.exp(0.8 * d[(i * 13 + 5 + rep) % d.length] * (rand() < 0.5 ? -1 : 1)));
      rows.push(row(CAND, task, rep, Math.round(a * jitter * scale), i % 17 !== 3));
      rows.push(row(BASE, task, rep, Math.round(b * jitter), i % 23 !== 4));
      if (i % 5 !== 1) rows.push(row(COPY, task, rep, copy));
    }
    if (i === 7) rows.push(row(BASE, task, 9, 500, false, { infra: 'browser died' }));
    if (i === 8) rows.push(row(BASE, task, 9, 500, false, { error: 'agent crashed' }));
  });
  for (const task of ['only-a-1', 'only-a-2']) rows.push(row(CAND, task, 1, 700));
  return rows;
}
const efficiencyRows = (rows) => rows.filter((r) => !r.infra && !r.error);
const shuffled = (xs, seed) => {
  const rand = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const report = (rows, a, b, control) =>
  abReport(rows, { a, b, control, seed: 'stats', resamples: 2000, meta: { seed: 'stats', backend: 'scripted' } });

// The first "x [lo, hi]" on the report line that holds `label`.
const interval = (md, label) => {
  const line = md.split('\n').find((l) => l.includes(label));
  const m = line?.match(/(\d+\.\d+) \[(\d+\.\d+), (\d+\.\d+)\]/);
  return m ? m.slice(1).map(Number) : null;
};
const perTaskRatios = (md) =>
  new Map(
    md
      .split('\n## Per task\n')[1]
      .split('\n')
      .filter((l) => /^\| [\w-]+ \|/.test(l) && !l.startsWith('| task |'))
      .map((l) => l.split('|').map((c) => c.trim()))
      .map((c) => [c[1], Number(c[6])])
  );
const flipsOf = (md) => md.match(/A-only passes (\d+), B-only passes (\d+); A passed more repeats on (\d+) tasks, B on (\d+); exact McNemar over tasks p=(\S+)/)?.slice(1);
// Two ratios read to 3 decimals are inverses when their product is 1 within
// what the rounding of both allows.
const inverse = (x, y) => Math.abs(x * y - 1) <= 0.0005 * (x + y) + 1e-9;

const near = (x, want, tol) => Math.abs(x - want) <= tol;
const f3 = (x) => x.toFixed(3);

const CHECKS = {
  // Student's t and the normal CDF at table values.
  't and normal quantiles match their tables': () =>
    near(tQuantile(0.975, 1), 12.7062, 1e-4) && near(tQuantile(0.975, 5), 2.5706, 1e-4) &&
    near(tQuantile(0.975, 11), 2.2010, 1e-4) && near(tQuantile(0.975, 30), 2.0423, 1e-4) &&
    near(tQuantile(0.8, 10), 0.8791, 1e-4) && near(tQuantile(0.975, 1e6), 1.9600, 1e-4) &&
    near(tQuantile(0.025, 11), -2.2010, 1e-4) && near(normalCdf(1.959964), 0.975, 1e-6) && near(normalCdf(-1), 0.158655, 1e-6),
  // Exact binomial tails summed by hand: 7 of 8 is 2 * 9/256; 9 of 10 is
  // 2 * 11/1024; 15 of 20 is 2 * 21700/2^20; 2 of 12 discordant pairs is
  // 2 * 79/4096; 6 of 6 is the fewest tasks that can reach 0.05; 450 of 1000
  // is the exact sum in integers.
  'sign test and McNemar match exact binomial tails': () => {
    const s = (up, down, ties = 0) => signTest([...Array(up).fill(0.1), ...Array(down).fill(-0.1), ...Array(ties).fill(0)]);
    const p = (x, want) => near(x, want, 1e-12 * want);
    return (
      p(s(7, 1).p, 18 / 256) && p(s(9, 1).p, 22 / 1024) && p(s(15, 5).p, 43400 / 1048576) &&
      p(s(6, 0).p, 2 / 64) && p(s(5, 0).p, 2 / 32) && s(2, 1, 3).ties === 3 && s(2, 1, 3).p === 1 && s(0, 0, 4).p === 1 &&
      p(mcnemarExact(2, 10), 158 / 4096) && mcnemarExact(10, 2) === mcnemarExact(2, 10) &&
      mcnemarExact(1, 2) === 1 && mcnemarExact(0, 0) === 1 && p(mcnemarExact(0, 5), 2 / 32) &&
      near(mcnemarExact(450, 550), 0.00173053608497, 1e-9 * 0.00173053608497) && mcnemarExact(1500, 1500) === 1
    );
  },
  // Two tasks A passes and B fails at three repeats each, and one where B
  // fails one repeat of three, are three discordant tasks, p = 2/8, not seven
  // discordant rows, p = 2/128; at one repeat it is McNemar on the rows. The
  // A/B report prints the task-level test.
  'McNemar counts tasks, not repeats': () => {
    const pair = (task, rep, a, b) => [{ task, rep, success: a }, { task, rep, success: b }];
    const pairs = [];
    for (let t = 0; t < 12; t++) {
      for (let rep = 1; rep <= 3; rep++) pairs.push(pair(`t${t}`, rep, true, t >= 2 && !(t === 5 && rep === 1)));
    }
    const f = passFlips(shuffled(pairs, 'flips'));
    const one = passFlips(Array.from({ length: 10 }, (_, t) => pair(`t${t}`, 1, t !== 9, t >= 2)));
    const rows = pairs.flatMap(([x, y]) => [
      { ...x, condition: 'x', output_tokens: 100, turns: 2 },
      { ...y, condition: 'y', output_tokens: 100, turns: 2 },
    ]);
    const flips = flipsOf(report(rows, 'x', 'y'));
    return (
      f.aOnly.length === 7 && f.bOnly.length === 0 && f.tasksA === 3 && f.tasksB === 0 && near(f.p, 0.25, 1e-15) &&
      f.aOnly.map(([x]) => `${x.task}#${x.rep}`).join() === 't0#1,t0#2,t0#3,t1#1,t1#2,t1#3,t5#1' &&
      one.tasksA === 2 && one.tasksB === 1 && one.p === mcnemarExact(2, 1) &&
      flips?.join() === '7,0,3,0,0.2500'
    );
  },
  // The minimum detectable effect is the t test's, and the tasks a plan asks
  // for are the fewest whose MDE reaches the ratio.
  'MDE and the task plan are the t test\'s': () => {
    const m = minimumDetectableEffect(0.3, 12);
    const want = ((tQuantile(0.975, 11) + tQuantile(0.8, 11)) * 0.3) / Math.sqrt(12);
    const n = pairsNeeded(0.252, 0.8);
    return (
      near(m.delta, want, 1e-12) && near(m.down, Math.exp(-want), 1e-12) &&
      minimumDetectableEffect(0.252, n).delta <= Math.abs(Math.log(0.8)) && minimumDetectableEffect(0.252, n - 1).delta > Math.abs(Math.log(0.8)) &&
      pairsNeeded(0.01, 0.5) === MIN_TASKS
    );
  },
  // Five tasks cover at most 94% (ab.mjs MIN_TASKS), so under six there is
  // neither an interval nor an MDE, and the report says why it reads no band
  // and ticks no box.
  'under six tasks there is no interval': () => {
    const groups = (n) => Array.from({ length: n }, (_, i) => ({ task: `t${i}`, a: [Math.log(1 + i / 10)], b: [0] }));
    const five = syntheticRows('codex').filter((r) => AA.codex.tasks.slice(0, 5).some(([t]) => t === r.task));
    const md = report(five, CAND, BASE, [COPY, BASE]);
    return (
      MIN_TASKS === 6 && taskBootstrap(groups(5)).lo === null && taskBootstrap(groups(5)).estimate > 1 &&
      taskBootstrap(groups(6)).lo > 1 && minimumDetectableEffect(0.3, 5) === null && minimumDetectableEffect(0.3, 6) !== null &&
      md.includes('[no CI under 6 tasks]** (95% bootstrap') && md.includes('the primary estimate is not read against the A/A band') &&
      md.includes('"Measuring a tool change": not run, since the primary and the A/A control each need 6 tasks') && !md.includes('- [x]')
    );
  },
  // The bootstrap resamples tasks in task order and adds each task's repeats
  // in ascending order, so neither a reshuffle of the tasks nor a permutation
  // of the repeats moves a bit of a bound, and swapping the arms negates every
  // draw, so B/A is 1 over A/B. The repeats move by a rotation, which is no
  // leading swap: over ten runs of 20 tasks at three repeats, a task's
  // left-to-right mean moves a bound at least once, so the check can fail.
  'the bootstrap reads the same in any row order and inverts with the arms': () => {
    const opts = { seed: 's', resamples: 3000 };
    const rotate = (xs) => [...xs.slice(1), xs[0]];
    const naive = ({ a, b }) => mean(a) - mean(b);
    const asDiffs = (gs, f) => gs.map((g) => ({ task: g.task, a: [f(g)], b: [0] }));
    const same = (x, y) => x.lo === y.lo && x.hi === y.hi && x.estimate === y.estimate;
    let sensitive = 0;
    let stable = true;
    let inverts = true;
    for (let k = 0; k < 10; k++) {
      const groups = simulate(logRatios('codex'), { tasks: 20, repeats: 3 }, rng(`order${k}`));
      const moved = shuffled(groups.map((g) => ({ ...g, a: rotate(g.a), b: rotate(g.b).reverse() })), `o${k}`);
      if (!same(taskBootstrap(asDiffs(groups, naive), opts), taskBootstrap(asDiffs(moved, naive), opts))) sensitive++;
      const ab = taskBootstrap(groups, opts);
      const ba = taskBootstrap(groups.map(({ task, a, b }) => ({ task, a: b, b: a })), opts);
      stable &&= same(ab, taskBootstrap(moved, opts)) && groups.every((g) => taskDiff(g) === taskDiff(moved.find((m) => m.task === g.task)));
      inverts &&= near(ab.estimate * ba.estimate, 1, 1e-12) && near(ab.lo * ba.hi, 1, 1e-12) && near(ab.hi * ba.lo, 1, 1e-12);
    }
    return (sensitive > 0 && stable && inverts) || `${sensitive} of 10 runs sensitive, stable ${stable}, inverts ${inverts}`;
  },
  // The whole A/B report: the same text in any row order, and with the arms
  // swapped every ratio it prints is the inverse, and every count and p value
  // the mirror.
  'the A/B report reads the same in any row order and inverts with the arms': () => {
    const rows = syntheticRows('codex');
    const withControl = report(rows, CAND, BASE, [COPY, BASE]);
    const orderFree = [1, 2].every((i) => report(shuffled(rows, `rows${i}`), CAND, BASE, [COPY, BASE]) === withControl);
    const tasksOf = (rs) => groupsFor(rs.filter((r) => r.condition === CAND), rs.filter((r) => r.condition === BASE), 'output').map((g) => [g.task, taskDiff(g)]);
    const groupsOrderFree = JSON.stringify(tasksOf(shuffled(rows, 'rows3'))) === JSON.stringify(tasksOf(rows));
    const ab = report(rows, CAND, BASE);
    const ba = report(rows, BASE, CAND);
    const labels = ['geometric-mean ratio A/B', '| turns |', '| total input |', '| cost (within', '| wall (machine'];
    const intervals = labels.every((label) => {
      const [x, y] = [interval(ab, label), interval(ba, label)];
      return x && y && inverse(x[0], y[0]) && inverse(x[1], y[2]) && inverse(x[2], y[1]);
    });
    const counts = (md) => md.match(/A higher on (\d+) tasks, lower on (\d+), tied on (\d+); sign test p=(\S+)/).slice(1);
    const [cab, cba, fab, fba] = [counts(ab), counts(ba), flipsOf(ab), flipsOf(ba)];
    const sums = (md) => Number(md.match(/ratio of sums (\d+\.\d+)/)[1]);
    const tab = perTaskRatios(ab);
    const tba = perTaskRatios(ba);
    const paired = [...tab].filter(([, r]) => Number.isFinite(r));
    return (
      orderFree && groupsOrderFree && intervals && inverse(sums(ab), sums(ba)) &&
      cab[0] === cba[1] && cab[1] === cba[0] && cab[2] === cba[2] && cab[3] === cba[3] &&
      fab[0] === fba[1] && fab[1] === fba[0] && fab[2] === fba[3] && fab[3] === fba[2] && fab[4] === fba[4] &&
      tab.size === 104 && paired.length === 102 && paired.every(([task, r]) => inverse(r, tba.get(task))) &&
      withControl.includes('B error 1, infra 1')
    );
  },
  // The report's MDE, noise-floor MDE, task plan, per-task band and guard
  // rails against the helpers applied to SDs and task counts read here from
  // the rows, and its two statistical ship checks against the intervals it
  // prints: with no effect the primary CI straddles 1 and neither box is
  // ticked, at 0.6x output both are, at 1.6x neither.
  'the A/B report prints what its helpers give for its rows': () => {
    const logs = (rows, c) => {
      const m = new Map();
      for (const r of rows.filter((x) => x.condition === c)) m.set(r.task, [...(m.get(r.task) ?? []), Math.log(r.output_tokens)]);
      return m;
    };
    const diffs = (rows, x, y) => {
      const [lx, ly] = [logs(rows, x), logs(rows, y)];
      return new Map([...lx.keys()].filter((t) => ly.has(t)).map((t) => [t, mean(lx.get(t)) - mean(ly.get(t))]));
    };
    const figures = (scale) => {
      const rows = efficiencyRows(syntheticRows('codex', scale));
      const md = report(syntheticRows('codex', scale), CAND, BASE, [COPY, BASE]);
      const primary = diffs(rows, CAND, BASE);
      const control = diffs(rows, COPY, BASE);
      const [sigma, cs] = [sd([...primary.values()]), sd([...control.values()])];
      const [n, cn] = [primary.size, control.size];
      const mde = minimumDetectableEffect(sigma, n);
      const cmde = minimumDetectableEffect(cs, n);
      const band = perTaskBand(cs, cn);
      const plan = [0.7, 0.8, 0.9, 0.95].map((r) => pairsNeeded(cs, r));
      const guards = GUARD_RAILS.every((t) => {
        const r = Math.exp(primary.get(t));
        return md.includes(`| ${t} | ${f3(r)} | ${r > band[1] ? 'ABOVE' : r < band[0] ? 'below' : 'within'} |`);
      });
      const wired =
        f3(sigma) !== f3(cs) && pairsNeeded(sigma, 0.9) !== plan[2] && cn < n && guards &&
        md.includes(`SD of the per-task log ratio ${f3(sigma)}; minimum detectable effect at 80% power: x${f3(mde.up)} or x${f3(mde.down)}`) &&
        md.includes(`over ${cn} tasks; SD ${f3(cs)}, so the noise-floor MDE for ${n} tasks is x${f3(cmde.up)} or x${f3(cmde.down)}`) &&
        md.includes(`from SD ${f3(cs)} (A/A): -30.0% ${plan[0]}, -20.0% ${plan[1]}, -10.0% ${plan[2]}, -5.0% ${plan[3]}`) &&
        md.includes(`from the control's SD over ${cn} tasks: [${f3(band[0])}, ${f3(band[1])}]`);
      const [, lo, hi] = interval(md, 'geometric-mean ratio A/B');
      const [, controlLo] = interval(md, `- A/A control ${COPY}/${BASE}:`);
      const [estimate] = interval(md, 'geometric-mean ratio A/B');
      const box = (label) => md.includes(`- [x] ${label}`);
      return {
        wired, lo, hi,
        ship: box('the primary CI lies below 1') === hi < 1 && box('the primary estimate lies below the A/A band') === estimate < controlLo,
        ticked: [box('the primary CI lies below 1'), box('the primary estimate lies below the A/A band')],
      };
    };
    const [none, win, loss] = [figures(1), figures(0.6), figures(1.6)];
    return (
      [none, win, loss].every((f) => f.wired && f.ship) && none.lo < 1 && none.hi > 1 &&
      none.ticked.join() === 'false,false' && win.ticked.join() === 'true,true' && loss.ticked.join() === 'false,false'
    );
  },
  // The report adds each sum's pairs in key order. A float sum depends on its
  // order: 2^53 loses every 1 added after it, so a sum in row order prints
  // 2^53 for one order of these rows and 2^53 + 8 for another.
  'the A/B report adds its sums in one order': () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      ['x', 'y'].map((condition) => ({ task: `t${i}`, condition, rep: 1, success: true, output_tokens: 100, turns: 2, cost_usd: i ? 1 : 2 ** 53 }))
    ).flat();
    const costLine = (rs) => report(rs, 'x', 'y').split('\n').find((l) => l.startsWith('| cost'));
    return new Set([rows, [...rows].reverse(), shuffled(rows, 'sums')].map(costLine)).size === 1;
  },
  // report.mjs's surface ratio is the geometric mean over tasks, with the
  // condition --conditions named first over the other, whichever row came
  // first.
  'report.mjs reads its surface ratio as a geometric mean in any row order': () => {
    const rows = AA.haiku.tasks.slice(0, 12).flatMap(([task, a, b]) =>
      [['firefox-devtools-mcp', a], ['playwright-mcp', b]].map(([condition, output]) => ({
        task, condition, rep: 1, success: true, backend: 'anthropic', turns: 2 + Math.round(output / 500), output_tokens: output,
        input_tokens: 10, cache_creation: 0, cache_read: 0, cost_usd: 0.01, friction: { tool_search: 1, tool_search_turns: 1, tool_search_output_tokens: 20 },
      }))
    );
    const meta = { backend: 'anthropic', models: { anthropic: 'm' }, effort: 'default', suite: 'web', seed: 's', conditions: 'firefox-devtools-mcp,playwright-mcp' };
    const line = (rs) => markdownReport({ meta, results: rs, totals: totalsByCondition(rs) }).split('\n').find((l) => l.startsWith('Surface ratio'));
    const gm = (pick) => f3(Math.exp(mean(AA.haiku.tasks.slice(0, 12).map(([, a, b]) => Math.log(pick(a)) - Math.log(pick(b))))));
    const want = `output ${gm((x) => x)} (${gm((x) => x - 20)} without ToolSearch)`;
    const first = line(rows);
    return (
      first.startsWith('Surface ratio firefox-devtools-mcp / playwright-mcp, the geometric mean over 12 paired tasks') &&
      first.includes(want) && [[...rows].reverse(), shuffled(rows, 'surface')].every((rs) => line(rs) === first)
    );
  },
  // compare.mjs across two stored runs: B/A is 1 over A/B, and a run whose
  // rows arrive in another order prints the same figures.
  'compare.mjs inverts with its runs and ignores row order': () => {
    const dir = mkdtempSync(join(tmpdir(), 'stats-'));
    try {
      const meta = { backend: 'scripted', models: { scripted: 'm' }, effort: 'medium', seed: 's', suite: 'web', git: { commit: 'c0ffee', dirty: false }, isolation: {} };
      const d = logRatios('codex');
      const run = (name, arm, order = (xs) => xs) => {
        const results = order(AA.codex.tasks.flatMap(([task, a, b], i) =>
          [1, 2, 3].slice(0, i % 4 ? 1 : 3).map((rep) => {
            const out = Math.round((arm === 'a' ? a : b) * Math.exp(rep === 1 ? 0 : d[(i + rep) % d.length] / 2));
            return { task, condition: 'firefox-devtools-mcp', rep, backend: 'scripted', model: 'm', success: i % 11 !== (arm === 'a' ? 2 : 5), output_tokens: out, turns: 2 + Math.round(out / 400) };
          })
        ));
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'results.json'), JSON.stringify({ meta, results }));
        return join(dir, name);
      };
      const [x, y, xShuffled] = [run('x', 'a'), run('y', 'b'), run('x2', 'a', (rows) => shuffled(rows, 'compare'))];
      const out = (p, q) => {
        const r = spawnSync(process.execPath, [COMPARE, p, q], { encoding: 'utf8' });
        return r.status === 0 ? r.stdout.split('\n').slice(2).join('\n') : '';
      };
      const [xy, yx] = [out(x, y), out(y, x)];
      const figures = (text) => {
        const [est, lo, hi] = text.match(/output tokens A\/B over 102 tasks: (\S+) \[(\S+), (\S+)\]/).slice(1).map(Number);
        const [, up, down] = text.match(/A higher on (\d+), lower on (\d+)/).map(Number);
        const [, aOnly, bOnly] = text.match(/A-only (\d+).*B-only (\d+)/).map(Number);
        const [, tasksA, tasksB] = text.match(/A passed more repeats on (\d+) tasks, B on (\d+)/).map(Number);
        return { est, lo, hi, up, down, aOnly, bOnly, tasksA, tasksB };
      };
      const [f, g] = [figures(xy), figures(yx)];
      // A passes where B fails on the tasks at i % 11 === 5, B where A fails
      // at 2; every fourth task has three repeats.
      const flipped = (at) => AA.codex.tasks.map((_, i) => i).filter((i) => i % 11 === at);
      const rowsOf = (is) => is.reduce((n, i) => n + (i % 4 ? 1 : 3), 0);
      return (
        inverse(f.est, g.est) && inverse(f.lo, g.hi) && inverse(f.hi, g.lo) && f.up === g.down && f.down === g.up &&
        f.aOnly === g.bOnly && f.bOnly === g.aOnly && f.tasksA === g.tasksB && f.tasksB === g.tasksA && out(xShuffled, y) === xy &&
        f.aOnly === rowsOf(flipped(5)) && f.tasksA === flipped(5).length && f.bOnly === rowsOf(flipped(2)) && f.tasksB === flipped(2).length &&
        f.aOnly + f.bOnly > f.tasksA + f.tasksB
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  // Normal A/A noise over a 12-task control: the band holds 95% of a further
  // A/A task, as a t prediction range does, where the z range holds 92%. Each
  // simulated control adds the exact chance a fresh task falls outside its
  // band, so the rate carries only the controls' noise.
  'the per-task band holds 95% of normal A/A tasks': () => {
    const rand = rng('band');
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    let outside = 0;
    const sims = 4000;
    for (let s = 0; s < sims; s++) {
      const [lo, hi] = perTaskBand(sd(Array.from({ length: 12 }, gauss)), 12);
      outside += normalCdf(Math.log(lo)) + 1 - normalCdf(Math.log(hi));
    }
    return near(outside / sims, 0.05, 0.002) || `a fresh task falls outside the band ${(outside / sims).toFixed(4)} of the time`;
  },
};

// The simulated rates, per stored sweep: the designs are the sweeps' own (102
// tasks at one repeat), a targeted A/B's (12 tasks at 3 repeats, "Measuring a
// tool change") and the fewest tasks with an interval (6 and 8), with no
// effect, with 0.8x and 1.2x output, with an uneven 0.8x that puts each task
// 0.15 above or below ln 0.8 at random, and at the MDE the report prints.
// Under the sign flips a task's log ratio is as likely up as down, so the sign
// test's rejection rate is binomial at its exact size: that check proves the
// simulated arms exchangeable and the ties read as signTest reads them.
function simulatedChecks() {
  const checks = {};
  for (const name of Object.keys(AA)) {
    const d = logRatios(name);
    const zeroes = d.filter((x) => x === 0).length / d.length;
    for (const [tasks, repeats, sims, range] of [[102, 1, SIMS, COVERAGE], [12, 3, SMALL_SIMS, COVERAGE], [8, 1, SMALL_SIMS, SMALL_COVERAGE], [6, 1, SMALL_SIMS, SMALL_COVERAGE]]) {
      const at = `${name}, ${tasks} tasks at ${repeats} repeat(s)`;
      checks[`A/A ${at}: the CI covers 1 at close to 95% and the sign test keeps its size`] = () => {
        const m = measure(name, { tasks, repeats }, 1, '', sims);
        const size = signTestSize(tasks, repeats === 1 ? zeroes : 0);
        const cover = rateWithin('coverage', m.coverage, sims, range);
        const sign = size <= 0.05 ? rateWithin('sign test rejections', m.sign, sims, [size, size]) : `exact sign test size ${size}`;
        return cover === true ? sign : cover;
      };
      if (tasks < 12) continue;
      const mde = minimumDetectableEffect(designSigma(d, repeats), tasks);
      checks[`${at}: the MDE the report prints has 80% power`] = () =>
        rateWithin('power', measure(name, { tasks, repeats, shift: () => -mde.delta }, mde.down, '', sims).excludes, sims, POWER);
    }
    for (const [label, ratio, spread] of [['0.8x', 0.8, 0], ['1.2x', 1.2, 0], ['uneven 0.8x', 0.8, 0.15]]) {
      checks[`${label} ${name}, 36 tasks: the CI covers the truth at close to 95%`] = () => {
        const shift = (rand) => Math.log(ratio) + (rand() < 0.5 ? spread : -spread);
        return rateWithin('coverage', measure(name, { tasks: 36, repeats: 1, shift }, ratio, label).coverage, SIMS, COVERAGE);
      };
    }
  }
  return checks;
}

// The checks that fail, each named with what it measured when it says.
export function statsCheckFailures() {
  return Object.entries({ ...CHECKS, ...simulatedChecks() }).flatMap(([name, check]) => {
    let result;
    try {
      result = check();
    } catch (error) {
      result = error.message;
    }
    return result === true ? [] : [typeof result === 'string' ? `${name} (${result})` : name];
  });
}

// stats-aa.json from the stored runs it names, under `root`: each A/A pair's
// valid, unassisted output per task, as ab.mjs pairs them.
function refresh(root = RESULTS_ROOT) {
  const out = {};
  for (const [name, entry] of Object.entries(AA)) {
    const dir = join(root, entry.run);
    if (!isRunDir(dir)) {
      console.error(
        `${name}: stats-aa.json names ${entry.run}, which is not a run under ${root}. Pass --root <results-dir>, ` +
          `or set the entry's "run", "a" and "b" to another A/A sweep.`
      );
      process.exit(1);
    }
    const rows = readRun(dir).results.map((r) => withRolloutFacts(r, dir));
    const rowsA = rows.filter((r) => r.condition === entry.a);
    const rowsB = rows.filter((r) => r.condition === entry.b);
    if (!rowsA.length || !rowsB.length) {
      console.error(`${name}: ${entry.run} has no rows for ${[entry.a, entry.b].filter((c) => !rows.some((r) => r.condition === c)).join(' or ')}`);
      process.exit(1);
    }
    const assisted = new Set([...rowsA, ...rowsB].filter((r) => shellAssistedOf(r, dir)));
    const one = (rs) => (rs.length === 1 ? Math.round(Math.exp(rs[0])) : null);
    const tasks = groupsFor(rowsA, rowsB, 'output', undefined, assisted)
      .map((g) => [g.task, one(g.a), one(g.b)])
      .filter(([, a, b]) => a && b);
    out[name] = { ...entry, tasks };
    console.log(`${name}: ${tasks.length} tasks from ${entry.run} (${entry.a} vs ${entry.b})`);
  }
  writeFileSync(AA_FILE, JSON.stringify(out, null, 1).replace(/\[\n\s+("[^"]+"),\n\s+(\d+),\n\s+(\d+)\n\s+\]/g, '[$1, $2, $3]') + '\n');
}

// Per condition of a run, the SD of a task's repeats in log output, pooled
// over the tasks with two or more valid rows: what one repeat adds to a task's
// noise, and so what σ/√2 of an A/A pair of the same build should match.
function repeatSpread(dir) {
  const run = readRun(dir);
  const rows = run.results.map((r) => withRolloutFacts(r, dir));
  const cells = new Map();
  for (const r of rows) {
    if (r.infra || r.error || r.invalid || !(r.output_tokens > 0) || shellAssistedOf(r, dir)) continue;
    const key = `${r.condition}\n${r.task}`;
    cells.set(key, [...(cells.get(key) ?? []), Math.log(r.output_tokens)]);
  }
  const by = new Map();
  for (const [key, xs] of [...cells].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (xs.length < 2) continue;
    const condition = key.split('\n')[0];
    const m = mean(xs);
    const c = by.get(condition) ?? { ss: 0, df: 0, tasks: 0 };
    by.set(condition, { ss: c.ss + xs.reduce((s, x) => s + (x - m) ** 2, 0), df: c.df + xs.length - 1, tasks: c.tasks + 1 });
  }
  console.log(`${dir}: backend ${run.meta?.backend ?? '?'}`);
  if (!by.size) console.log('  no task has two valid repeats in one condition');
  for (const [condition, { ss, df, tasks }] of by) {
    const version = buildKey(run.meta ?? {}, condition).version;
    console.log(`  ${condition}${version ? ` (${version})` : ''}: SD of a task's repeats ${Math.sqrt(ss / df).toFixed(3)} in log output, ${tasks} tasks, ${df} degrees of freedom`);
  }
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
  if (args.includes('--refresh')) {
    const at = args.indexOf('--root');
    refresh(at === -1 ? undefined : args[at + 1]);
    process.exit(0);
  }
  if (args.includes('--repeats')) {
    const dirs = args.filter((a) => !a.startsWith('--'));
    const missing = dirs.filter((dir) => !existsSync(dir) || !isRunDir(dir));
    if (!dirs.length || missing.length) {
      console.error(`usage: node eval/scripts/stats-checks.mjs --repeats <run-dir> [...]${missing.length ? `; not a run: ${missing.join(', ')}` : ''}`);
      process.exit(1);
    }
    for (const dir of dirs) repeatSpread(dir);
    process.exit(0);
  }
  const started = Date.now();
  const failed = statsCheckFailures();
  const total = Object.keys({ ...CHECKS, ...simulatedChecks() }).length;
  for (const name of failed) console.error(`stats check failed: ${name}`);
  console.log(`${total - failed.length}/${total} statistics checks pass (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
  for (const name of Object.keys(AA)) {
    const d = logRatios(name);
    const band = perTaskBand(sd(d), d.length);
    const outside = d.filter((x) => Math.exp(x) < band[0] || Math.exp(x) > band[1]).length;
    console.log(
      `${name}: ${AA[name].run} ${AA[name].a} vs ${AA[name].b}, ${d.length} tasks, SD of the per-task log ratio ${sd(d).toFixed(3)} ` +
        `(so a repeat's SD in one arm of σ/√2 = ${(sd(d) / Math.SQRT2).toFixed(3)}), kurtosis ${kurtosis(d).toFixed(2)} (3 at normal noise)`
    );
    console.log(`  per-task band [${band.map((x) => x.toFixed(3)).join(', ')}] leaves out ${outside} of ${d.length} stored A/A tasks`);
    for (const [tasks, repeats] of [[102, 1], [36, 1], [24, 2], [12, 3], [12, 1], [8, 1], [6, 1]]) {
      const sigma = designSigma(d, repeats);
      const mde = minimumDetectableEffect(sigma, tasks);
      const sims = tasks <= 12 ? SMALL_SIMS : SIMS;
      const aa = measure(name, { tasks, repeats }, 1, '', sims);
      const power = measure(name, { tasks, repeats, shift: () => -mde.delta }, mde.down, '', sims).excludes;
      const ship = shipRate(name, { tasks, repeats, shift: -mde.delta });
      const further = shipRate(name, { tasks, repeats, shift: -1.12 * mde.delta });
      const falseShip = shipRate(name, { tasks, repeats, shift: 0 });
      console.log(
        `  ${tasks} tasks x ${repeats}: A/A coverage ${aa.coverage.toFixed(3)}, sign test rejects ${aa.sign.toFixed(3)} ` +
          `(exact size ${signTestSize(tasks).toFixed(3)}); MDE x${mde.down.toFixed(3)}: CI excludes 1 in ${power.toFixed(3)}, ` +
          `ship checks hold in ${ship.toFixed(3)}, at 1.12 times its distance (x${Math.exp(-1.12 * mde.delta).toFixed(3)}) in ${further.toFixed(3)}, ` +
          `with no effect in ${falseShip.toFixed(3)}`
      );
    }
  }
  process.exit(failed.length ? 1 : 0);
}
