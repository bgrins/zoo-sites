// Golden-path self-test: proves each eval task is still SOLVABLE and that its
// validator still accepts a correct solution and rejects a wrong one — without
// spending agent budget.
//
//   node eval/verify.mjs [--task <ids>] [--headed] [--list] [--jobs <n>] [--extract]
//                   [--profile [path]]
//
// Tasks run across parallel workers by default (each with its own pages server
// and Firefox instance, the same isolation run.mjs uses for --parallel-tasks);
// --jobs 1 restores the serial behaviour.
//
// Why this exists: every fixture change risks silently breaking a task (a
// restyle can change measured behaviour with no logic change) and every
// validator risks failing correct answers (the most common defect).
// An agent sweep catches both, at ~$20 and ~30 minutes. This catches most of it
// in minutes for nothing.
//
// It drives the browser through a real MCP server — the same surface the `mcp`
// condition uses — so a green run also proves the snapshot and tool surface are
// sufficient to win the task. A Playwright-driven equivalent would not: it would
// prove only that the fixture works.
//
// Each driver returns the answer text a correct agent would produce, having done
// the real interaction so the server-observed gates are genuinely satisfied.
// Tasks whose success is prose or judgment (a written summary, a phishing
// verdict) can only have their interaction driven and their prose supplied
// canned — those are marked `canned: true` and prove the validator accepts a
// correct answer, not that composing one is possible.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtoolsMcpEntry, startMcpServer } from './mcp-stdio.mjs';
import { detectScreen, windowGrid } from './window-grid.mjs';
import { startPagesServer } from '../server.mjs';
import { conforms, extractFields } from './extract.mjs';
import { DRIVERS } from './verify-drivers/index.mjs';
import { checkFixtures } from '../scripts/check-fixtures.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const HEADED = args.includes('--headed');
// Paid, opt-in: runs the real extraction model over the driver's text answer
// and the wrong/alsoCorrect strings of schema tasks, asserting the
// extraction-then-validation outcome. The only place the extractor's own
// quality is measured; the default gate stays free.
const EXTRACT = args.includes('--extract');
// --profile [path]: record ONE Gecko profile covering the whole run, and mark
// each task's boundaries inside it so a hot region can be attributed to a
// driver. Open the result at https://profiler.firefox.com.
//
// What it measures is Firefox UNDER AUTOMATION: much of the cost is WebDriver
// BiDi traffic and the accessibility-tree walk every take_snapshot performs.
// That is the interesting workload for a browser agent, but it is not ordinary
// browsing, and these fixtures are small synthetic pages run headless, so
// layout and paint numbers here do not transfer to real sites.
//
// Resolved by hand rather than with flag(): the path is optional, so a bare
// `--profile --jobs 1` must not read the next flag as a filename.
const PROFILE = (() => {
  const i = args.indexOf('--profile');
  if (i === -1) return null;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : 'profile.json';
})();
// Firefox reads these at startup and writes the profile when it exits, so the
// whole run has to share one browser. 10ms sampling with 100M entries held a
// full 91-driver run with nothing discarded, costing ~800MB of buffer and a
// ~270MB profile. Raise the interval before raising the buffer if a longer run
// overflows.
const PROFILE_ENV = PROFILE
  ? {
      MOZ_PROFILER_STARTUP: '1',
      MOZ_PROFILER_STARTUP_INTERVAL: flag('profile-interval', '10'),
      MOZ_PROFILER_STARTUP_ENTRIES: flag('profile-entries', '100000000'),
      MOZ_PROFILER_SHUTDOWN: resolve(PROFILE),
    }
  : {};
// One browser means one profile. Profiling many workers would have each Firefox
// race to write the same file, so the flag pins --jobs 1 and says so.
const JOBS_REQUESTED = flag('jobs', null);
if (PROFILE && JOBS_REQUESTED && Number(JOBS_REQUESTED) !== 1) {
  throw new Error('--profile records one browser for the whole run, so it cannot combine with --jobs > 1');
}
const JOBS = PROFILE
  ? 1
  : Number(JOBS_REQUESTED ?? String(Math.min(4, Math.max(1, availableParallelism() - 2))));
if (!Number.isInteger(JOBS) || JOBS < 1) {
  throw new Error('--jobs must be a positive integer');
}
const SEED = flag('seed', null);
const ONLY = flag('task', null);
const patterns = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;
const selected = (id) => !patterns || patterns.some((p) => (p.includes('*')
  ? new RegExp('^' + p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(id)
  : p === id));

// The gate covers the web suite AND the devtools suite: every task with a
// driver is verified regardless of which suite a paid run selects. The
// factories are the same modules run.mjs imports, so the gate always grades
// exactly the code a paid run grades.
async function loadTasks(base) {
  const { webTasks } = await import('./tasks/web.mjs');
  const { devtoolsTasks } = await import('./tasks/devtools.mjs');
  return [...(await webTasks(base)), ...(await devtoolsTasks(base))];
}

// Without this, an unrecognised --help silently ran the whole two-minute gate.
if (args.includes('--help') || args.includes('-h')) {
  console.log(`The gate: drive every task's golden path through a real browser and
assert that each validator accepts a correct answer and rejects a wrong one.
Free, no API spend, about 90 seconds.

Usage: node eval/verify.mjs [options]

  --task <ids>            comma list; * wildcards, e.g. --task 'ledger-*'
  --list                  every task and whether it has a driver
  --jobs <n>              parallel workers (default: cores - 2, capped at 4)
  --headed                visible Firefox, one window per worker, tiled into a
                          screen-sized grid
  --screen <WxH>          screen size for the headed grid (default: detected
                          on macOS, else 1920x1080)
  --seed <string>         pin per-session difficulty draws, so a rerun faces
                          the same shapes as the run it is compared against
  --extract               PAID: also run the real extraction model over the
                          driver answers and assert the graded outcome
  --profile [path]        record one Gecko profile of the whole run, task
                          boundaries marked (default: profile.json; pins --jobs 1)
  --profile-interval <ms> profiler sampling interval (default: 10)
  --profile-entries <n>   profiler buffer entries (default: 100000000)
  --help                  show this help

Set FIREFOX_DEVTOOLS_MCP=/path/to/checkout to gate your own build of the tool.
Read the failures block rather than a piped exit status: \`verify.mjs | tail\`
reports tail's status, which has hidden red gates before.`);
  process.exit(0);
}

if (args.includes('--list')) {
  const tasks = await loadTasks('http://placeholder');
  const withDriver = tasks.filter((t) => DRIVERS[t.id]);
  console.log(`${withDriver.length}/${tasks.length} tasks have a golden path\n`);
  for (const t of tasks) {
    const d = DRIVERS[t.id];
    console.log(
      `  ${d ? (d.canned ? 'canned ' : 'driven ') : '  --   '} ${t.id}` +
        (d?.note ? `  (${d.note})` : '')
    );
  }
  console.log('\ndriven = interaction and answer both produced by the driver');
  console.log('canned = interaction driven, prose supplied (judgment/composition task)');
  console.log('  --   = no golden path yet');
  process.exit(0);
}

// Headless Firefox on macOS still plays to the machine's speakers, so an unmuted
// fixture beeps at whoever runs the suite. Muting costs no measurement: a muted
// element still decodes, currentTime still advances, and cues still fire.
function assertFixtureMediaMuted() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'pages');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.html')) {
        const html = readFileSync(full, 'utf8');
        for (const [tag] of html.matchAll(/<(?:audio|video)\b[^>]*>/gi)) {
          if (!/\bmuted\b/i.test(tag)) offenders.push(`${relative(root, full)}: ${tag.trim()}`);
        }
      }
    }
  };
  walk(root);
  if (offenders.length) {
    console.error('unmuted media element(s) in fixtures (see "Silent by default" in docs/authoring-fixtures.md):');
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }
}

assertFixtureMediaMuted();

// The 91 drivers below only ever drive single-origin mode, so a link that
// resolves under site prefixes and 404s under the container's one-origin-per-port
// mounts passes every one of them. This is the only check that sees both.
function assertFixturesResolve() {
  const problems = checkFixtures();
  if (problems.length) {
    console.error('fixture check failed (see scripts/check-fixtures.mjs):');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

assertFixturesResolve();

// One isolated worker env: pages server + one firefox-devtools-mcp server
// over stdio. The server is a child process (see mcp-stdio.mjs), so a worker
// that dies takes its Firefox with it, and FIREFOX_DEVTOOLS_MCP points the
// whole gate at a local tool checkout.
async function makeWorker(grid, slot) {
  const pages = await startPagesServer({ seed: SEED });
  // Headed workers each launch into a seeded profile so their windows tile
  // instead of stacking; the browser owns the dir, so it outlives no run.
  const stateDir = grid ? mkdtempSync(join(tmpdir(), 'zoo-verify-')) : null;
  const server = await startMcpServer({
    args: [
      devtoolsMcpEntry(),
      '--enable-script',
      ...(HEADED ? [] : ['--headless']),
      ...(grid ? ['--profile-path', grid.seed(stateDir, slot)] : []),
    ],
    env: PROFILE_ENV,
  });
  const mcp = (name, toolArgs = {}) => server.call(name, toolArgs);
  // Most drivers only need to navigate and read/poke the page; uid-based tools
  // are available too, and using them is what makes this a real dogfood of the
  // surface.
  const helpers = {
    mcp,
    base: pages.url,
    goto: (path) => mcp('navigate_page', { url: pages.url + path }),
    evaluate: async (fn, fnArgs) => {
      const r = await mcp('evaluate_script', { function: String(fn), args: fnArgs });
      const text = (r.content ?? []).map((c) => c.text).join('\n');
      const m = text.match(/```json\n([\s\S]*?)\n```/);
      if (!m) return text;
      // A function with no return value comes back as the literal `undefined`,
      // which is not JSON; treat any unparseable payload as raw text.
      try {
        return JSON.parse(m[1]);
      } catch {
        return m[1] === 'undefined' ? undefined : m[1];
      }
    },
    snapshot: async () => {
      const r = await mcp('take_snapshot', {});
      return (r.content ?? []).map((c) => c.text).join('\n');
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Stamp a named point inside the running task's profile span, e.g.
    // `await mark('scrolled-to-batch-8')`. runOne sets taskId, so a label only
    // has to be unique within its own driver. Costs nothing and reaches nothing
    // without --profile, so a driver may call it freely.
    mark: (label) => mark(helpers, `zoo:${helpers.taskId}:${label}`),
    taskId: null,
  };
  // Settle the browser onto a real content process before the first task, so
  // that task's boundary marks are comparable with each other. Without it the
  // opening mark lands in the startup process, whose clock does not line up
  // with the one the fixtures then run in. Profiling only: an extra navigation
  // would otherwise change what the gate exercises.
  if (PROFILE) await helpers.goto('/');
  // Task asks embed the pages URL, so each worker rebuilds its own task list.
  const tasks = await loadTasks(pages.url);
  const close = async () => {
    await server.close();
    await pages.close();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  };
  return { pages, helpers, tasks, close };
}

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

// Stamp a task boundary into the Gecko profile. `performance.mark` surfaces as a
// UserTiming marker carrying its own name, which is what lets a hot region in
// the profile be attributed to one driver. Two instant marks rather than a
// `performance.measure`: marks belong to a document, drivers navigate, and a
// measure whose start mark died with the previous document throws.
//
// A mark's timestamp is only comparable to another mark's when both land in the
// SAME content process. Measured: two marks in one process matched the harness
// clock exactly (1204ms vs 1204ms), while a pair that straddled the startup
// process produced a span of MINUS 142ms. makeWorker therefore navigates once
// before the first task, so every mark lands in a settled content process
// instead of the startup one, and durations below come from the harness rather
// than from subtracting two marks.
//
// Best-effort throughout: a mark that does not land must never fail the task it
// was only annotating.
async function mark(helpers, name) {
  if (!PROFILE) return;
  await helpers
    .mcp('evaluate_script', { function: `() => performance.mark(${JSON.stringify(name)})` })
    .catch(() => {});
}

// Authoritative per-task browser time, written beside the profile. Reading it
// costs nothing, where answering "which driver was expensive" from the profile
// itself means loading a ~270MB JSON.
const taskTimings = [];

async function runOne(worker, id) {
  const { pages, helpers } = worker;
  const task = worker.tasks.find((t) => t.id === id);
  const driver = DRIVERS[task.id];
  const ctx = { pages };
  pages.state.reset();
  // Restore the window before every task, not just after the one that resizes.
  // A driver that resizes restores in its own `finally`, but that restore is
  // swallowed on failure, and the resize tool can time out under load — which
  // leaves the window at phone width and makes the NEXT task in this worker fail
  // for a reason nothing points at.
  await helpers.mcp('set_viewport_size', { width: 1366, height: 768 }).catch(() => {});
  // The same per-task modes runOne applies, so a golden path is graded against
  // the pages the real run serves. mirror-reroute's driver ASSERTS the outage
  // is armed rather than arming it, which is what keeps this plumbing covered.
  Object.assign(pages.state.modes, task.serverModes ?? {});
  helpers.taskId = task.id;
  await mark(helpers, `zoo:${task.id}:start`);
  const startedAt = Date.now();
  let out;
  try {
    out = await driver.run(helpers, ctx);
  } catch (error) {
    await mark(helpers, `zoo:${task.id}:end`);
    taskTimings.push({ task: task.id, ms: Date.now() - startedAt, ok: false });
    fail++;
    failures.push(`${task.id}: driver threw — ${error.message}`);
    console.log(`FAIL  ${task.id}  driver threw: ${error.message}`);
    return;
  }
  // Grading is harness-side and costs the browser nothing, so the task's span
  // ends with its last browser interaction rather than with its verdict.
  await mark(helpers, `zoo:${task.id}:end`);
  taskTimings.push({ task: task.id, ms: Date.now() - startedAt, ok: true });
  // A throwing validator must register as that task's failure, not abort the
  // whole gate mid-flight with workers still up.
  try {
    await gradeOne();
  } catch (error) {
    fail++;
    failures.push(`${task.id}: validator threw — ${error.message}`);
    console.log(`FAIL  ${task.id}  validator threw: ${error.message}`);
  }
  return;

  async function gradeOne() {
  // Schema tasks return { text, fields }: fields graded here for free, text
  // kept for the transcript-shaped assertions and --extract mode.
  const answer = typeof out === 'string' ? out : out.text;
  const fields = typeof out === 'string' ? null : (out.fields ?? null);
  if (task.answerSchema) {
    const schemaProblems = [
      ...conforms(fields, task.answerSchema).map((e) => `driver fields${e}`),
      ...[driver.wrongFields ?? []].flat().flatMap((wf, i) =>
        conforms(wf, task.answerSchema).map((e) => `wrongFields[${i}]${e}`)
      ),
      ...[driver.alsoCorrectFields ?? []].flat().flatMap((af, i) =>
        conforms(af, task.answerSchema).map((e) => `alsoCorrectFields[${i}]${e}`)
      ),
    ];
    if (!(driver.wrongFields ?? []).length) {
      schemaProblems.push('schema task has no wrongFields regression assertions');
    }
    if (schemaProblems.length) {
      fail++;
      failures.push(`${task.id}: ${schemaProblems[0]}`);
      console.log(`FAIL  ${task.id}  ${schemaProblems.join('; ')}`);
      return;
    }
    const good = task.validate(answer, ctx, fields);
    const badAccepted = (driver.wrongFields ?? [])
      .map((wf) => ({ wf, r: task.validate('', ctx, wf) }))
      .filter(({ r }) => r.pass !== false);
    const goodRejected = (driver.alsoCorrectFields ?? [])
      .map((af) => ({ af, r: task.validate('', ctx, af) }))
      .filter(({ r }) => r.pass !== true);
    // The never-answered case: all-null fields (extraction skipped or fully
    // quote-gated) must fail for every schema task, unconditionally.
    const nulls = task.validate('', ctx, null);
    if (good.pass === true && !badAccepted.length && !goodRejected.length && nulls.pass === false) {
      if (EXTRACT) {
        const extractProblems = [];
        const graded = async (text) => {
          const { fields: f } = await extractFields({
            ask: task.ask,
            answer: text,
            schema: task.answerSchema,
          });
          return task.validate(text, ctx, f);
        };
        try {
          const own = await graded(answer);
          if (own.pass !== true) {
            extractProblems.push(`driver text failed after extraction — ${own.detail ?? ''}`);
          }
          for (const w of [driver.wrong ?? []].flat()) {
            const r = await graded(w);
            if (r.pass !== false) {
              extractProblems.push(`wrong string PASSED after extraction: ${JSON.stringify(w.slice(0, 60))}`);
            }
          }
          for (const a of [driver.alsoCorrect ?? []].flat()) {
            const r = await graded(a);
            if (r.pass !== true) {
              extractProblems.push(`correct phrasing FAILED after extraction: ${JSON.stringify(a.slice(0, 60))} — ${r.detail ?? ''}`);
            }
          }
        } catch (error) {
          extractProblems.push(`extractor threw — ${error.message}`);
        }
        if (extractProblems.length) {
          fail++;
          failures.push(`${task.id}: ${extractProblems[0]}`);
          console.log(`FAIL  ${task.id}  [--extract] ${extractProblems.join('; ')}`);
          return;
        }
      }
      pass++;
      console.log(
        `ok    ${task.id}  (fields; ${(driver.wrongFields ?? []).length} wrong, ` +
          `${(driver.alsoCorrectFields ?? []).length} accepted variants` +
          `${EXTRACT ? '; extractor verified' : ''})`
      );
    } else {
      fail++;
      const why =
        good.pass !== true
          ? `validator REJECTED the driver's fields — ${good.detail ?? ''}`
          : badAccepted.length
            ? `validator ACCEPTED wrongFields ${JSON.stringify(badAccepted[0].wf).slice(0, 70)} — ${badAccepted[0].r.detail ?? ''}`
            : goodRejected.length
              ? `validator REJECTED alsoCorrectFields ${JSON.stringify(goodRejected[0].af).slice(0, 70)} — ${goodRejected[0].r.detail ?? ''}`
              : 'validator PASSED all-null fields (never-answered must fail)';
      failures.push(`${task.id}: ${why}`);
      console.log(`FAIL  ${task.id}  ${why}`);
    }
    return;
  }
  const good = task.validate(answer, ctx);
  // The same server state must REJECT every wrong answer, or the validator is
  // only checking the interaction and would pass any prose. `wrong` may be a
  // list: specific strings can wrongly PASS (a region-totals table naming the
  // wrong winner, added/removed lists swapped, a rotated points column), so a
  // validator carries those exact strings here as a permanent regression
  // assertion.
  const wrongs = [driver.wrong ?? 'The answer is 42.'].flat();
  // `alsoCorrect` is the mirror: strings that MUST pass. A validator can reject
  // a correct answer for paraphrasing, hedging, or naming a rival value
  // contrastively ("X, not Y"). Those go here so a future tightening cannot
  // silently reintroduce the false fail.
  const alsoCorrect = [driver.alsoCorrect ?? []].flat();

  const badAccepted = wrongs
    .map((w) => ({ w, r: task.validate(w, ctx) }))
    .filter(({ r }) => r.pass !== false);
  const goodRejected = alsoCorrect
    .map((a) => ({ a, r: task.validate(a, ctx) }))
    .filter(({ r }) => r.pass !== true);

  const ok = good.pass === true && !badAccepted.length && !goodRejected.length;
  if (ok) {
    const extra = [
      driver.canned ? 'canned prose' : null,
      wrongs.length > 1 ? `${wrongs.length} wrong answers rejected` : null,
      alsoCorrect.length ? `${alsoCorrect.length} phrasings accepted` : null,
    ].filter(Boolean);
    pass++;
    console.log(`ok    ${task.id}${extra.length ? `  (${extra.join(', ')})` : ''}`);
  } else {
    fail++;
    let why;
    if (good.pass !== true) {
      why = `validator REJECTED a correct solution — ${good.detail ?? ''}`;
    } else if (badAccepted.length) {
      const { w, r } = badAccepted[0];
      why = `validator ACCEPTED a wrong answer ${JSON.stringify(w.slice(0, 70))} — ${r.detail ?? ''}`;
    } else {
      const { a, r } = goodRejected[0];
      why = `validator REJECTED a correct phrasing ${JSON.stringify(a.slice(0, 70))} — ${r.detail ?? ''}`;
    }
    failures.push(`${task.id}: ${why}`);
    console.log(`FAIL  ${task.id}  ${why}`);
  }
  }
}

const allTasks = await loadTasks('http://placeholder');
const queue = [];
for (const task of allTasks) {
  if (!selected(task.id)) continue;
  if (!DRIVERS[task.id]) {
    skipped++;
    continue;
  }
  queue.push(task.id);
}

if (patterns && !queue.length) {
  console.error(`--task matched nothing for: ${patterns.join(', ')}`);
  process.exit(1);
}

const workers = [];
try {
  const count = Math.min(JOBS, Math.max(1, queue.length));
  // Grid sized to the workers that will actually exist, not to --jobs: a
  // two-task run asked for eight ways still tiles into two cells.
  const grid = HEADED ? windowGrid(count, detectScreen(flag('screen', null))) : null;
  for (let i = 0; i < count; i++) workers.push(await makeWorker(grid, i));
  let next = 0;
  await Promise.all(
    workers.map(async (worker) => {
      while (next < queue.length) {
        await runOne(worker, queue[next++]);
      }
    })
  );
} finally {
  for (const worker of workers) await worker.close();
}

console.log(`\n${pass} ok, ${fail} failed, ${skipped} without a golden path`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
if (PROFILE) {
  // Firefox writes the profile as it exits, which worker.close() above has just
  // triggered; report what actually landed rather than where it was asked to go.
  const path = resolve(PROFILE);
  const size = statSync(path, { throwIfNoEntry: false })?.size;
  const timings = path.replace(/\.json$/, '') + '.tasks.json';
  const slowest = taskTimings.slice().sort((a, b) => b.ms - a.ms);
  writeFileSync(
    timings,
    JSON.stringify({ totalMs: taskTimings.reduce((n, t) => n + t.ms, 0), tasks: taskTimings }, null, 2)
  );
  console.log(
    size
      ? `\nprofile: ${path} (${(size / 1024 / 1024).toFixed(0)} MB)\n` +
          `  open at https://profiler.firefox.com; filter markers for "zoo:" to find a task\n` +
          `timings: ${timings}\n` +
          `  slowest: ` +
          slowest.slice(0, 3).map((t) => `${t.task} ${t.ms}ms`).join(', ')
      : `\nprofile: nothing written to ${path} — Firefox may have been killed rather than closed`
  );
}
process.exitCode = fail ? 1 : 0;
