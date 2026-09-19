// Golden-path self-test: proves each eval task is still SOLVABLE and that its
// validator still accepts a correct solution and rejects a wrong one — without
// spending agent budget.
//
//   node eval/verify.mjs [--task <ids>] [--headed] [--list] [--jobs <n>] [--extract]
//                   [--origins] [--profile [path]]
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
// It drives the browser through a real MCP server, the same one the
// `firefox-devtools-mcp` condition uses. A green run proves the site behaves
// correctly and its server-side state lands; it does NOT prove the snapshot is
// enough to win the task, because drivers reach past snapshot limits with
// evaluate_script and what a surface cannot read is the result the eval reports
// ("What green means" in docs/authoring-fixtures.md).
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
import { devtoolsMcpEntry, downloadPrefs, prefArgs, startMcpServer } from './mcp-stdio.mjs';
import { detectScreen, windowGrid } from './window-grid.mjs';
import { startPagesServer } from '../server.mjs';
import { ORIGINS, originUrls } from '../manifest.mjs';
import { conforms, enforceQuotes, extractFields, normalise } from './extract.mjs';
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
// The container's shape (serve.mjs): every site on its own port with its
// directory at '/', instead of every site under a path prefix on one port.
// Ports stay ephemeral so parallel workers never collide.
const ORIGIN_MODE = args.includes('--origins');
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
async function loadTasks(base, origins) {
  const { webTasks } = await import('./tasks/web.mjs');
  const { devtoolsTasks } = await import('./tasks/devtools.mjs');
  return [...(await webTasks(base, origins)), ...(await devtoolsTasks(base, origins))];
}

// Without this, an unrecognised --help silently ran the whole four-minute gate.
if (args.includes('--help') || args.includes('-h')) {
  console.log(`The gate: drive every task's golden path through a real browser and
assert that each validator accepts a correct answer and rejects a wrong one.
Free, no API spend, about 4 minutes.

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
  --origins               serve every site on its own port with its directory
                          at '/', the container's shape, instead of under path
                          prefixes on one port
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

// The drivers below drive single-origin mode unless --origins is given, so a
// link that resolves under site prefixes and 404s under the container's
// one-origin-per-port mounts passes every one of them in the default gate. This
// is the only default check that sees both.
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
  const pages = await startPagesServer({ seed: SEED, origins: ORIGIN_MODE ? ORIGINS : null });
  const origins = ORIGIN_MODE ? originUrls(pages.url, pages.origins) : undefined;
  // Drivers name single-origin paths (/paylink/checkout.html). In origin mode
  // the site owning the longest matching dir prefix serves the rest of the path
  // at its own root, so shop/gadgetron-mirror never lands on shop/gadgetron.
  // A path no site owns (/, /api/...) stays on the single-origin listener.
  // Only goto maps: helpers.base stays that listener, so an answer a driver
  // builds from base or a prefixed path grades the single-origin answer.
  const byDir = [...pages.origins].sort((a, b) => b.dir.length - a.dir.length);
  const urlFor = (path) => {
    const owner = byDir.find(
      (o) => path.startsWith(`/${o.dir}`) && /^([/?#]|$)/.test(path.slice(o.dir.length + 1))
    );
    if (!owner) return pages.url + path;
    const rest = path.slice(owner.dir.length + 1);
    return owner.url + (rest.startsWith('/') ? rest : `/${rest}`);
  };
  // Headed workers each launch into a seeded profile so their windows tile
  // instead of stacking; the browser owns the dir, so it outlives no run. A
  // download lands in the worker's dir too, never in the operator's ~/Downloads.
  const stateDir = mkdtempSync(join(tmpdir(), 'zoo-verify-'));
  const server = await startMcpServer({
    args: [
      devtoolsMcpEntry(),
      '--enable-script',
      ...(HEADED ? [] : ['--headless']),
      ...(grid ? ['--profile-path', grid.seed(stateDir, slot)] : []),
      ...prefArgs(downloadPrefs(join(stateDir, 'downloads'))),
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
    goto: (path) => mcp('navigate_page', { url: urlFor(path) }),
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
  const tasks = await loadTasks(pages.url, origins);
  const close = async () => {
    await server.close();
    await pages.close();
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { pages, helpers, tasks, close };
}

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
const exercised = {
  wrongFields: 0,
  alsoCorrectFields: 0,
  wrongState: 0,
  alsoCorrectState: 0,
  neverAnswered: 0,
};

// A deep copy of the pages server's state for one wrongState/alsoCorrectState
// case. One structuredClone call copies every data member together, so a
// reference two members share stays shared in the copy (a roster beacon holds
// the same attendees array as its session). The server's methods close over the
// original state, so each one validators call is rebuilt on the copy, and a
// method this does not know fails loudly rather than reading the real state.
const STATE_METHODS = new Set(['beaconsOf', 'reset']);
function cloneState(state) {
  const methods = Object.keys(state).filter((k) => typeof state[k] === 'function');
  const unknown = methods.filter((k) => !STATE_METHODS.has(k));
  if (unknown.length) throw new Error(`cloneState cannot rebuild state.${unknown.join(', state.')}`);
  // state.beacons and state.collect are CappedLog arrays (server.mjs); their rows
  // are plain data, so a case grades a plain array of the same rows.
  const data = Object.fromEntries(
    Object.entries(state)
      .filter(([k]) => !methods.includes(k))
      .map(([k, v]) => [k, Array.isArray(v) ? Array.from(v) : v])
  );
  assertPlainData(data, 'state', new Set());
  const clone = structuredClone(data);
  clone.beaconsOf = (kind) => clone.beacons.filter((b) => b.kind === kind);
  return clone;
}

// structuredClone throws on a function, and silently turns a class instance or
// a Buffer into a plain object or Uint8Array without its methods, so anything
// outside plain data fails here, naming its path, before a case grades a copy
// that differs from the state.
const PLAIN_PROTOTYPES = new Set([
  null,
  Object.prototype,
  Array.prototype,
  Map.prototype,
  Set.prototype,
  Date.prototype,
]);
function assertPlainData(value, path, seen) {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`${path} holds a ${typeof value}, which a state case cannot copy`);
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (!PLAIN_PROTOTYPES.has(Object.getPrototypeOf(value))) {
    throw new Error(`${path} holds a ${value.constructor?.name ?? 'exotic object'}, which a state case cannot copy`);
  }
  const entries =
    value instanceof Map
      ? [...value]
      : value instanceof Set
        ? [...value].map((child, i) => [i, child])
        : Object.entries(value);
  for (const [key, child] of entries) assertPlainData(child, `${path}.${String(key)}`, seen);
}

// What a validator receives when extraction runs over an answer that states
// nothing: the extractor nulls every { value, quote } pair and enforceQuotes
// collapses the pairs onto the task's own shape. The quoted schema never lets an
// object or array be null, so objects keep their keys and arrays come back
// empty, or as one row of nulls, the other shape an extractor can emit.
function neverAnswered(schema) {
  const raw = (node, rows) =>
    node.type === 'object'
      ? Object.fromEntries(Object.entries(node.properties ?? {}).map(([k, v]) => [k, raw(v, rows)]))
      : node.type === 'array'
        ? Array.from({ length: rows }, () => raw(node.items, rows))
        : { value: null, quote: null };
  const shapes = [0, 1].map((rows) => enforceQuotes(raw(schema, rows), normalise('')));
  return JSON.stringify(shapes[0]) === JSON.stringify(shapes[1]) ? [shapes[0]] : shapes;
}

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
  // Every check below grades fields against the task's schema, so a task graded
  // on prose alone would have nothing here to pass or fail.
  if (!task.answerSchema) {
    fail++;
    failures.push(`${task.id}: task has no answerSchema`);
    console.log(`FAIL  ${task.id}  task has no answerSchema`);
    return;
  }
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
    // Drivers return { text, fields }: fields graded here for free, text kept
    // for the transcript-shaped assertions and --extract mode.
    const answer = typeof out === 'string' ? out : out.text;
    const fields = typeof out === 'string' ? null : (out.fields ?? null);
    const wrongFields = [driver.wrongFields ?? []].flat();
    const alsoCorrectFields = [driver.alsoCorrectFields ?? []].flat();
    const wrongState = [driver.wrongState ?? []].flat();
    const alsoCorrectState = [driver.alsoCorrectState ?? []].flat();
    const schemaProblems = [
      ...conforms(fields, task.answerSchema).map((e) => `driver fields${e}`),
      ...wrongFields.flatMap((wf, i) =>
        conforms(wf, task.answerSchema).map((e) => `wrongFields[${i}]${e}`)
      ),
      ...alsoCorrectFields.flatMap((af, i) =>
        conforms(af, task.answerSchema).map((e) => `alsoCorrectFields[${i}]${e}`)
      ),
      ...Object.entries({ wrongState, alsoCorrectState }).flatMap(([key, cases]) =>
        cases.flatMap((c, i) => [
          ...(typeof c?.name === 'string' && typeof c?.mutate === 'function'
            ? []
            : [`${key}[${i}] needs a name and a mutate(state)`]),
          ...(c?.fields === undefined
            ? []
            : conforms(c.fields, task.answerSchema).map((e) => `${key}[${i}].fields${e}`)),
        ])
      ),
    ];
    if (!wrongFields.length) {
      schemaProblems.push('schema task has no wrongFields regression assertions');
    }
    if (schemaProblems.length) {
      fail++;
      failures.push(`${task.id}: ${schemaProblems[0]}`);
      console.log(`FAIL  ${task.id}  ${schemaProblems.join('; ')}`);
      return;
    }
    const good = task.validate(answer, ctx, fields);
    const badAccepted = wrongFields
      .map((wf) => ({ wf, r: task.validate('', ctx, wf) }))
      .filter(({ r }) => r.pass !== false);
    const goodRejected = alsoCorrectFields
      .map((af) => ({ af, r: task.validate('', ctx, af) }))
      .filter(({ r }) => r.pass !== true);
    // The field arrays vary only the answer against the golden server state, so
    // a server-state conjunct can go always-true under them and stay green.
    // State cases vary the state instead (a purchase in a stray session, a
    // budget split across cookies), each on its own copy, so the real state
    // every other check reads never changes.
    const gradeState = (c) => {
      try {
        const state = cloneState(pages.state);
        c.mutate(state);
        const caseFields = c.fields === undefined ? fields : c.fields;
        return task.validate('', { ...ctx, pages: { ...pages, state } }, caseFields);
      } catch (error) {
        return { threw: error };
      }
    };
    const stateAccepted = wrongState
      .map((c) => ({ c, r: gradeState(c) }))
      .filter(({ r }) => r.pass !== false);
    const stateRejected = alsoCorrectState
      .map((c) => ({ c, r: gradeState(c) }))
      .filter(({ r }) => r.pass !== true);
    // Never answered: null fields (extraction skipped or failed) and the shapes
    // an answer that states nothing extracts to must fail for every task.
    const unansweredShapes = [null, ...neverAnswered(task.answerSchema)];
    const unanswered = unansweredShapes
      .map((f) => {
        try {
          return { f, r: task.validate('', ctx, f) };
        } catch (error) {
          return { f, r: { threw: error } };
        }
      })
      .filter(({ r }) => r.pass !== false);
    exercised.wrongFields += wrongFields.length;
    exercised.alsoCorrectFields += alsoCorrectFields.length;
    exercised.wrongState += wrongState.length;
    exercised.alsoCorrectState += alsoCorrectState.length;
    exercised.neverAnswered += unansweredShapes.length;
    const stateWhy = (verb, key, { c, r }) =>
      r.threw
        ? `${key} "${c.name}" threw — ${r.threw.message}`
        : `validator ${verb} ${key} "${c.name}" — ${r.detail ?? ''}`;
    const why = [
      good.pass !== true && `validator REJECTED the driver's fields — ${good.detail ?? ''}`,
      ...badAccepted.map(
        ({ wf, r }) => `validator ACCEPTED wrongFields ${JSON.stringify(wf).slice(0, 70)} — ${r.detail ?? ''}`
      ),
      ...goodRejected.map(
        ({ af, r }) => `validator REJECTED alsoCorrectFields ${JSON.stringify(af).slice(0, 70)} — ${r.detail ?? ''}`
      ),
      ...stateAccepted.map((s) => stateWhy('ACCEPTED', 'wrongState', s)),
      ...stateRejected.map((s) => stateWhy('REJECTED', 'alsoCorrectState', s)),
      ...unanswered.map(({ f, r }) =>
        r.threw
          ? `validator threw on never-answered fields ${JSON.stringify(f).slice(0, 70)} — ${r.threw.message}`
          : `validator PASSED never-answered fields ${JSON.stringify(f).slice(0, 70)} (never-answered must fail) — ${r.detail ?? ''}`
      ),
    ].filter(Boolean);
    if (why.length) {
      fail++;
      failures.push(`${task.id}: ${why[0]}${why.length > 1 ? `  (+${why.length - 1} more, listed above)` : ''}`);
      console.log(`FAIL  ${task.id}  ${why.join('\n        ')}`);
      return;
    }
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
        // `wrong` is the prose form of wrongFields: strings that must FAIL once
        // extracted. Specific strings can wrongly PASS (a region-totals table
        // naming the wrong winner, added/removed lists swapped, a rotated
        // points column), so a driver carries those exact strings as a
        // permanent regression assertion.
        for (const w of [driver.wrong ?? []].flat()) {
          const r = await graded(w);
          if (r.pass !== false) {
            extractProblems.push(`wrong string PASSED after extraction: ${JSON.stringify(w.slice(0, 60))}`);
          }
        }
        // `alsoCorrect` is the mirror: strings that MUST pass. A validator can
        // reject a correct answer for paraphrasing, hedging, or naming a rival
        // value contrastively ("X, not Y"), and these keep a future tightening
        // from silently reintroducing the false fail.
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
    const stateCounts =
      wrongState.length || alsoCorrectState.length
        ? `; ${wrongState.length} wrong states, ${alsoCorrectState.length} accepted states`
        : '';
    console.log(
      `ok    ${task.id}  (fields; ${wrongFields.length} wrong, ` +
        `${alsoCorrectFields.length} accepted variants${stateCounts}` +
        `${EXTRACT ? '; extractor verified' : ''})`
    );
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

console.log(
  `\n${pass} ok, ${fail} failed, ${skipped} without a golden path` +
    `${ORIGIN_MODE ? ' (origin mode)' : ''}`
);
console.log(
  `cases exercised: ${exercised.wrongFields} wrongFields and ${exercised.wrongState} wrongState ` +
    `(must fail), ${exercised.alsoCorrectFields} alsoCorrectFields and ` +
    `${exercised.alsoCorrectState} alsoCorrectState (must pass), ` +
    `${exercised.neverAnswered} never-answered shapes (must fail)`
);
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
