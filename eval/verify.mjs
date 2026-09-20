// Golden-path self-test: proves each eval task is still SOLVABLE and that its
// validator still accepts a correct solution and rejects a wrong one — without
// spending agent budget.
//
//   node eval/verify.mjs [--task <ids>] [--area <names>] [--affected [files]]
//                   [--headed] [--list] [--jobs <n>] [--extract] [--origins | --vhosts]
//                   [--telemetry [path]] [--compare <json>] [--record-timings]
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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_PINS,
  PINNED_PREFS,
  devtoolsMcpEntry,
  devtoolsMcpInfo,
  downloadPrefs,
  prefArgs,
  startMcpServer,
} from './mcp-stdio.mjs';
import { detectScreen, windowGrid } from './window-grid.mjs';
import { startPagesServer } from '../server.mjs';
import { ORIGINS, originUrls } from '../manifest.mjs';
import { conforms, enforceQuotes, extractFields, normalise } from './extract.mjs';
import { DRIVERS, DRIVER_FILES } from './verify-drivers/index.mjs';
import { makeHelpers, pagesRouting } from './verify-drivers/helpers.mjs';
import { addSession, textOf } from './verify-drivers/lib.mjs';
import { gradedValues, mintedValues, reachOf } from './surface-reach.mjs';
import { checkFixtures } from '../scripts/check-fixtures.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
// A flag whose value is optional: a bare `--telemetry --jobs 1` must not read
// the next flag as its value.
const optionalFlag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
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
const PROFILE = optionalFlag('profile', 'profile.json');
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
const AREAS = flag('area', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
// --affected [files]: only the tasks the given files (comma list, repo- or
// cwd-relative) can change, or those of the working tree's changes against HEAD
// when no list is given. affectedTasks() below holds the mapping.
const AFFECTED = args.includes('--affected') ? optionalFlag('affected', '') : null;
// Every site on one port, told apart by its Host header (<key>.localhost), the
// shape a host-routed deployment serves; see startPagesServer's `vhosts`.
const VHOSTS = args.includes('--vhosts');
if (VHOSTS && ORIGIN_MODE) throw new Error('--vhosts and --origins are two serving modes; pick one');
const SERVING = VHOSTS ? 'vhosts' : ORIGIN_MODE ? 'origins' : 'single-origin';
// --telemetry [path]: per-tool latency, result size and errors, and whether each
// graded value reached a snapshot the driver received, written as JSON to diff
// between two builds. It records; it never changes what passes. By default it
// lands in eval/results/, which git ignores, stamped so a baseline is never
// overwritten.
const TELEMETRY = optionalFlag(
  'telemetry',
  join(REPO, 'eval', 'results', `verify-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
);
const COMPARE = flag('compare', null);
if (COMPARE && !TELEMETRY) throw new Error('--compare diffs a --telemetry run against a baseline, so it needs --telemetry');
if (COMPARE && !existsSync(COMPARE)) throw new Error(`--compare: no telemetry file at ${COMPARE}`);
// Per-task wall time from a serial run, which orders the queue longest-first.
const TIMINGS_FILE = join(REPO, 'eval', 'verify-drivers', 'timings.json');
const RECORD_TIMINGS = args.includes('--record-timings');

// The gate covers the web suite AND the devtools suite: every task with a
// driver is verified regardless of which suite a paid run selects. The
// factories are the same modules run.mjs imports, so the gate always grades
// exactly the code a paid run grades.
async function loadTasks(base, origins) {
  const { webTasks } = await import('./tasks/web.mjs');
  const { devtoolsTasks } = await import('./tasks/devtools.mjs');
  return [...(await webTasks(base, origins)), ...(await devtoolsTasks(base, origins))];
}

// Without this, an unrecognised --help silently ran the whole gate.
if (args.includes('--help') || args.includes('-h')) {
  console.log(`The gate: drive every task's golden path through a real browser and
assert that each validator accepts a correct answer and rejects a wrong one.
Free, no API spend: under 2 minutes at the default --jobs, about 3.5 with
--jobs 1 (eval/spikes/gate-time.mjs measures both).

Usage: node eval/verify.mjs [options]

  --task <ids>            comma list; * wildcards, e.g. --task 'ledger-*'
  --area <names>          only tasks tagged with one of these capability areas
                          (tasks/areas.json; --list shows each task's)
  --affected [files]      only tasks the files can change (comma list); with no
                          list, the working tree's changes against HEAD
  --list                  every task and whether it has a driver
  --dry-run               print the tasks a run would drive, in queue order, and
                          stop
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
  --vhosts                serve every site on one port, routed by Host header
                          (<key>.localhost)
  --telemetry [path]      write per-tool latency, result chars and errors, and
                          golden-path reach (did each graded value reach a
                          snapshot?) as JSON (default:
                          eval/results/verify-telemetry-<time>.json)
  --compare <json>        with --telemetry, print what changed against an
                          earlier telemetry file (another build's)
  --telemetry-diff <a> <b> print what changed between two telemetry files; runs
                          no task
  --record-timings        write each task's wall time to
                          verify-drivers/timings.json, which orders the queue
                          longest-first; record from a --jobs 1 run
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
        `  [${t.family}: ${t.areas.join(', ') || 'no areas'}]` +
        (d?.note ? `  (${d.note})` : '')
    );
  }
  console.log('\ndriven = interaction and answer both produced by the driver');
  console.log('canned = interaction driven, prose supplied (judgment/composition task)');
  console.log('  --   = no golden path yet');
  const untagged = tasks.filter((t) => !t.areas.length).map((t) => t.id);
  if (untagged.length) {
    console.log(`\nno areas in tasks/areas.json (eval/scripts/derive-areas.mjs derives them): ${untagged.join(', ')}`);
  }
  process.exit(0);
}

const telemetryDiff = args.indexOf('--telemetry-diff');
if (telemetryDiff !== -1) {
  const [a, b] = args.slice(telemetryDiff + 1, telemetryDiff + 3);
  if (!a || !b) throw new Error('--telemetry-diff takes two telemetry files');
  printTelemetryDiff(JSON.parse(readFileSync(a, 'utf8')), JSON.parse(readFileSync(b, 'utf8')));
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
  const pages = await startPagesServer({
    seed: SEED,
    origins: ORIGIN_MODE ? ORIGINS : null,
    ...(VHOSTS ? { vhosts: true } : {}),
  });
  if (VHOSTS && !pages.origins?.length) {
    await pages.close();
    throw new Error('--vhosts needs a server.mjs whose startPagesServer supports { vhosts: true }');
  }
  const origins = ORIGIN_MODE || VHOSTS ? originUrls(pages.url, pages.origins) : undefined;
  // Headed workers each launch into a seeded profile so their windows tile
  // instead of stacking; the browser owns the dir, so it outlives no run. A
  // download lands in the worker's dir too, never in the operator's ~/Downloads.
  const stateDir = mkdtempSync(join(tmpdir(), 'zoo-verify-'));
  const server = await startMcpServer({
    args: [
      devtoolsMcpEntry(),
      '--enable-script',
      // The browser environment paid runs pin (BROWSER_PINS), so a fixture that
      // depends on the time zone, locale or colour scheme behaves the same here.
      ...(HEADED ? [] : ['--headless', '--viewport', '1366x768']),
      ...(grid ? ['--profile-path', grid.seed(stateDir, slot)] : []),
      ...prefArgs({ ...PINNED_PREFS, ...downloadPrefs(join(stateDir, 'downloads')) }),
    ],
    env: { TZ: BROWSER_PINS.timeZone, ...PROFILE_ENV },
  });
  // Every call a driver or the harness makes, for --telemetry. `phase` tells
  // the driver's calls from the harness's own (the viewport reset before a
  // task, the reach snapshot after it), so per-task tool counts are the
  // driver's alone.
  const calls = [];
  // A new browser sits on about:blank until its first navigation, so healthy()
  // reads about:blank as a relaunch only once this worker has navigated.
  let navigated = false;
  const serverCall = async (name, toolArgs) => {
    const result = await server.call(name, toolArgs);
    if (name === 'navigate_page' && !result.isError) navigated = true;
    return result;
  };
  const mcp = async (name, toolArgs = {}) => {
    if (!TELEMETRY) return serverCall(name, toolArgs);
    const started = performance.now();
    const call = { tool: name, phase: helpers.phase, ms: 0, chars: 0, isError: false, threw: null };
    calls.push(call);
    try {
      const result = await serverCall(name, toolArgs);
      const text = textOf(result);
      call.chars = text.length;
      call.isError = !!result.isError;
      if (call.isError) call.errorText = text.slice(0, 160);
      if (name === 'take_snapshot') call.text = text;
      if (name === 'navigate_page') call.url = toolArgs.url;
      return result;
    } catch (error) {
      call.threw = String(error.message).slice(0, 160);
      throw error;
    } finally {
      call.ms = performance.now() - started;
    }
  };
  const helpers = makeHelpers({ mcp, pages, mark });
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
    // Firefox outlives its MCP server by a few hundred ms and meanwhile rewrites
    // a seeded profile, recreating a directory removed too early.
    for (const stop = Date.now() + 10000; Date.now() < stop; ) {
      if (spawnSync('pgrep', ['-f', stateDir]).status !== 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    rmSync(stateDir, { recursive: true, force: true });
  };
  // Whether the MCP server and the browser the driver was using still answer.
  // A hung browser answers nothing, hence the timeout. A crashed one is
  // relaunched silently by firefox-devtools-mcp on its next call, onto
  // about:blank, a page no driver returns to once it has navigated.
  const healthy = async () => {
    let timer;
    const timeout = new Promise((r) => (timer = setTimeout(() => r(false), 15000)));
    const probe = server
      .call('evaluate_script', { function: '() => location.href' })
      .then((r) => !r.isError && !(navigated && /"about:blank"/.test(textOf(r))))
      .catch(() => false);
    const ok = await Promise.race([probe, timeout]);
    clearTimeout(timer);
    return ok;
  };
  const { pathOf } = pagesRouting(pages);
  return { pages, helpers, tasks, close, calls, healthy, pathOf, slot, listTools: server.listTools };
}

// The manifest dir a single-origin path lies under, the longest one winning so
// /shop/gadgetron-mirror/ never reads as shop/gadgetron.
const DIRS_LONGEST_FIRST = [...new Set(ORIGINS.map((o) => o.dir))].sort((a, b) => b.length - a.length);
function dirOfPath(path) {
  return DIRS_LONGEST_FIRST.find((d) => path === `/${d}` || path.startsWith(`/${d}/`)) ?? null;
}

// What a dead or wedged worker throws, as opposed to a driver's own assertion:
// the stdio transport closing, an MCP request timing out, or the browser gone
// from under WebDriver.
const TRANSPORT_ERROR =
  /Connection closed|Not connected|MCP error -3200[01]|Request timed out|EPIPE|ECONNRESET|socket hang up|browser has (?:been )?closed|Browsing context has been discarded|invalid session id|session (?:not created|deleted)/i;

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
  mutantsKilled: 0,
  mutantsRun: 0,
  shadowsIgnored: 0,
  shadowsRun: 0,
};
const staticTruth = [];

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

// Generic state mutants: wrongState/alsoCorrectState cases written once for
// every task, each graded with the driver's own fields on its own copy. A task
// whose truth is minted server-side must fail once the run's server record is
// gone, whether nothing remains (empty: the state as reset() left it before the
// driver ran) or one session that never acted (fresh). It must also ignore a
// session minted ahead of the run and never used, the one a curl probe or a
// cookieless fetch leaves (shadow), so that mutant must still pass.
const copyOf = (state) => {
  if (state instanceof Error) throw state;
  return cloneState(state);
};
const MUTANTS = [
  {
    name: 'empty',
    mustPass: false,
    leaves: 'no sessions, beacons or /collect hits',
    build: ({ pristine }) => copyOf(pristine),
  },
  {
    name: 'fresh',
    mustPass: false,
    leaves: 'only a session that never acted',
    build: ({ pristine }) => {
      const state = copyOf(pristine);
      addSession(state);
      return state;
    },
  },
  {
    name: 'shadow',
    mustPass: true,
    build: ({ golden }) => {
      const state = cloneState(golden);
      addSession(state, {}, { first: true });
      return state;
    },
  },
];

// A task's `truth`: { kind: 'minted', reason? }, the default when absent, or
// { kind: 'static', reason } for a pure-extraction task whose answer is
// published page content (rule 1 in docs/authoring-fixtures.md). A static task
// is exempt from the mutants, and the gate checks the exemption still holds.
function truthOf(task) {
  const t = task.truth;
  if (t === undefined) return { kind: 'minted' };
  const reasoned = typeof t?.reason === 'string' && t.reason.trim();
  if (t?.kind === 'minted' && (t.reason === undefined || reasoned)) return t;
  if (t?.kind === 'static' && reasoned) return t;
  return {
    invalid: `truth must be { kind: 'minted' | 'static', reason } (reason required for static), got ${JSON.stringify(t)}`,
  };
}

// The server-minted codes a golden answer carries, compared the way eqCode
// does. surface-reach's CODE shape is the only mint registry there is, so a
// minted number or word escapes this.
function mintedIn(fields, state) {
  const flat = (s) => String(s).toUpperCase().replace(/[\s-]+/g, '');
  const answer = gradedValues(fields).map(flat);
  return mintedValues(state, Infinity).filter((m) => answer.some((a) => a.includes(flat(m))));
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

// --telemetry's per-task records, keyed by task id.
const telemetryTasks = {};
let restarts = 0;

// The telemetry helpers are function declarations because --telemetry-diff
// calls printTelemetryDiff before the rest of this module has initialised.
function round(n) {
  return Math.round(n * 10) / 10;
}

// Nearest-rank percentile, so a p50 is always a latency some call really took.
function percentile(xs, p) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]);
}

// Per tool over one task's calls. `ms` keeps each call's latency, because
// per-task medians cannot be combined into a median over any set of tasks.
function toolStats(calls) {
  const by = {};
  for (const c of calls) (by[c.tool] ??= []).push(c);
  return Object.fromEntries(
    Object.entries(by)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tool, list]) => [
        tool,
        {
          calls: list.length,
          errors: list.filter((c) => c.isError).length,
          threw: list.filter((c) => c.threw).length,
          chars: list.reduce((n, c) => n + c.chars, 0),
          p50_ms: percentile(list.map((c) => c.ms), 0.5),
          p90_ms: percentile(list.map((c) => c.ms), 0.9),
          max_ms: percentile(list.map((c) => c.ms), 1),
          ms: list.map((c) => round(c.ms)),
        },
      ])
  );
}

// Several tasks' toolStats as one, latency over their pooled calls.
function mergeToolStats(perTask) {
  const by = {};
  for (const stats of perTask) for (const [tool, s] of Object.entries(stats ?? {})) (by[tool] ??= []).push(s);
  const total = (parts, key) => parts.reduce((n, s) => n + (s[key] ?? 0), 0);
  return Object.fromEntries(
    Object.entries(by)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tool, parts]) => {
        const ms = parts.flatMap((s) => s.ms ?? []);
        return [
          tool,
          {
            calls: total(parts, 'calls'),
            errors: total(parts, 'errors'),
            threw: total(parts, 'threw'),
            chars: total(parts, 'chars'),
            p50_ms: percentile(ms, 0.5),
            p90_ms: percentile(ms, 0.9),
            max_ms: percentile(ms, 1),
          },
        ];
      })
  );
}

// What the snapshots a driver received looked like: how many were cut at the
// line window ("[+N lines"), how many hit the walker's depth or node cap
// ("[DOM truncated]"), and how many quoted strings the formatter cut short.
function snapshotStats(snaps) {
  return {
    calls: snaps.length,
    chars: snaps.reduce((n, s) => n + s.length, 0),
    lines: snaps.reduce((n, s) => n + s.split('\n').length, 0),
    lineCut: snaps.filter((s) => /\[\+\d+ lines/.test(s)).length,
    domTruncated: snaps.filter((s) => s.includes('[DOM truncated]')).length,
    cutStrings: snaps.reduce((n, s) => n + (s.match(/\.\.\."/g) ?? []).length, 0),
  };
}

function reachCounts(reach) {
  const out = { values: 0, seen: 0, truncated: 0, absent: 0 };
  for (const state of Object.values(reach ?? {})) {
    out.values++;
    out[state]++;
  }
  return out;
}

// The scalars gradedValues() tests, keyed by where they sit in the answer
// ("rows[2].title"), because a minted value changes every run and its path is
// what two runs share.
function fieldPaths(fields) {
  const out = {};
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, Array.isArray(node) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
      return;
    }
    if ((typeof node === 'string' || typeof node === 'number') && String(node).length >= 3) out[path] = String(node);
  };
  walk(fields, '');
  return out;
}

// Each graded answer field as seen, truncated (the snapshot shows its opening
// and an ellipsis) or absent, over the snapshots the driver itself took and
// over one full-window snapshot the harness takes of the page the driver left;
// and the same counted over the codes the server minted.
function reachRecord(fields, state, driverText, finalText) {
  const paths = fieldPaths(fields);
  const minted = mintedValues(state);
  const over = (text) => {
    const found = reachOf(Object.values(paths), text);
    return {
      fields: Object.fromEntries(Object.entries(paths).map(([p, v]) => [p, found[v] ?? 'absent'])),
      minted: reachCounts(reachOf(minted, text)),
    };
  };
  return { driver: over(driverText), final: over(finalText) };
}

// Which build of the tool this is, by content: a version string cannot tell a
// patched checkout from the release it was cut from.
function buildIdentity() {
  const entry = devtoolsMcpEntry();
  const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
  return {
    ...devtoolsMcpInfo(),
    entry,
    sha256: sha(entry),
    walkerSha256: sha(join(dirname(entry), 'snapshot.injected.global.js')),
  };
}

function toolsIdentity(tools) {
  const described = (tools ?? [])
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const json = JSON.stringify(described);
  return {
    count: described.length,
    names: described.map((t) => t.name),
    hash: createHash('sha256').update(json).digest('hex'),
    schemaChars: json.length,
  };
}

// Run-wide figures over the tasks `ids` names, rebuilt from their per-task
// records, so a diff can total two files over the same tasks.
function telemetryTotals(tasks, ids) {
  const list = ids.map((id) => tasks[id]).filter(Boolean);
  const sum = (key) => {
    const out = {};
    for (const t of list) for (const [k, v] of Object.entries(t[key] ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const reachTotal = (pick, counted = false) => {
    const out = { values: 0, seen: 0, truncated: 0, absent: 0, tasks: 0, tasksAllSeen: 0 };
    for (const t of list) {
      const reach = t.reach && pick(t.reach);
      if (!reach || !Object.keys(reach).length) continue;
      const counts = counted ? reach : reachCounts(reach);
      if (!counts.values) continue;
      for (const k of ['values', 'seen', 'truncated', 'absent']) out[k] += counts[k];
      out.tasks++;
      if (counts.seen === counts.values) out.tasksAllSeen++;
    }
    return out;
  };
  return {
    tasks: list.length,
    tools: mergeToolStats(list.map((t) => t.tools)),
    harness: mergeToolStats(list.map((t) => t.harness)),
    snapshot: sum('snapshot'),
    reach: {
      driver: reachTotal((r) => r.driver.fields),
      final: reachTotal((r) => r.final.fields),
      mintedDriver: reachTotal((r) => r.driver.minted, true),
      mintedFinal: reachTotal((r) => r.final.minted, true),
    },
  };
}

function telemetryReport() {
  const tasks = Object.fromEntries(Object.entries(telemetryTasks).sort(([a], [b]) => a.localeCompare(b)));
  return {
    version: 1,
    build: buildIdentity(),
    tools: toolsIdentity(toolList),
    firefox: firefoxVersion,
    run: {
      at: new Date().toISOString(),
      jobs: JOBS,
      seed: SEED,
      serving: SERVING,
      tasks: Object.keys(tasks).length,
      ok: pass,
      failed: fail,
      restarts,
    },
    // Over the tasks that passed: a failed task's calls stop wherever its
    // driver threw, and its answer fields are not the graded values.
    totals: {
      ...telemetryTotals(tasks, Object.keys(tasks).filter((id) => tasks[id].verdict === 'ok')),
      excluded: Object.fromEntries(
        Object.entries(tasks)
          .filter(([, t]) => t.verdict !== 'ok')
          .map(([id, t]) => [id, t.verdict])
      ),
    },
    tasks,
  };
}

// What changed between two --telemetry files, most often the same gate on two
// builds of the tool. It calls only function declarations, because
// --telemetry-diff calls it before the rest of this module has initialised.
function printTelemetryDiff(a, b) {
  const label = (t) =>
    `${t.build?.version ?? '?'} (${t.build?.source ?? '?'}, ${String(t.build?.sha256 ?? '').slice(0, 12)})`;
  const arrow = (x, y) => (x === y ? String(x ?? '-') : `${x ?? '-'} -> ${y ?? '-'}`);
  console.log(`\ntelemetry diff: ${label(a)} -> ${label(b)}`);
  if (!a.run?.seed || a.run.seed !== b.run?.seed) {
    console.log('  the two runs did not share a --seed, so value-level flips below include difficulty-draw noise');
  }
  if (a.build?.walkerSha256 !== b.build?.walkerSha256) console.log('  the snapshot walker differs');
  if (a.tools?.hash !== b.tools?.hash) {
    const [an, bn] = [new Set(a.tools?.names ?? []), new Set(b.tools?.names ?? [])];
    const added = [...bn].filter((n) => !an.has(n));
    const removed = [...an].filter((n) => !bn.has(n));
    console.log(
      `  tools/list differs: ${arrow(a.tools?.count, b.tools?.count)} tools, ` +
        `${arrow(a.tools?.schemaChars, b.tools?.schemaChars)} schema chars` +
        (added.length ? `; added ${added.join(', ')}` : '') +
        (removed.length ? `; removed ${removed.join(', ')}` : '')
    );
  }
  const flips = Object.keys(b.tasks ?? {})
    .filter((id) => a.tasks?.[id] && a.tasks[id].verdict !== b.tasks[id].verdict)
    .map((id) => `${id} ${a.tasks[id].verdict} -> ${b.tasks[id].verdict}`);
  console.log(`  verdicts: ${arrow(a.run?.ok, b.run?.ok)} ok, ${arrow(a.run?.failed, b.run?.failed)} failed` +
    (flips.length ? `; flipped: ${flips.join(', ')}` : ''));
  // Every figure below is over the tasks ok in both files, so a task one build
  // fails, or one run skipped, moves no total.
  const both = Object.keys(b.tasks ?? {})
    .filter((id) => a.tasks?.[id]?.verdict === 'ok' && b.tasks[id].verdict === 'ok')
    .sort();
  const excluded = new Set([...Object.keys(a.tasks ?? {}), ...Object.keys(b.tasks ?? {})]).size - both.length;
  const [ta, tb] = [telemetryTotals(a.tasks ?? {}, both), telemetryTotals(b.tasks ?? {}, both)];
  console.log(`  totals over the ${both.length} task${both.length === 1 ? '' : 's'} ok in both files (${excluded} excluded)`);
  // Latency moves by tens of percent between two runs of one build, so a row
  // prints for it only past both floors, and one run proves no latency claim.
  const rows = [];
  const names = [...new Set([...Object.keys(ta.tools), ...Object.keys(tb.tools)])].sort();
  for (const name of names) {
    const [x, y] = [ta.tools[name] ?? {}, tb.tools[name] ?? {}];
    const p50 = (x.p50_ms ?? 0) - (y.p50_ms ?? 0);
    const slower = Math.abs(p50) > Math.max(5, 0.25 * (x.p50_ms ?? 0));
    const chars = Math.abs((y.chars ?? 0) - (x.chars ?? 0)) > 0.05 * Math.max(x.chars ?? 0, 1);
    if (x.calls === y.calls && x.errors === y.errors && x.threw === y.threw && !slower && !chars) continue;
    rows.push(
      `    ${name.padEnd(24)} calls ${arrow(x.calls, y.calls)}, errors ${arrow(x.errors, y.errors)}, ` +
        `p50 ${arrow(x.p50_ms, y.p50_ms)} ms, chars ${arrow(x.chars, y.chars)}`
    );
  }
  console.log(rows.length ? `  tools that moved (latency needs 3 runs a side before it means anything):\n${rows.join('\n')}` : '  no tool moved');
  const [sa, sb] = [ta.snapshot, tb.snapshot];
  console.log(
    `  snapshots: ${arrow(sa.calls, sb.calls)} calls, ${arrow(sa.chars, sb.chars)} chars, ` +
      `${arrow(sa.lineCut, sb.lineCut)} line-cut, ${arrow(sa.domTruncated, sb.domTruncated)} DOM-truncated, ` +
      `${arrow(sa.cutStrings, sb.cutStrings)} cut strings`
  );
  for (const key of ['driver', 'final']) {
    const [x, y] = [ta.reach[key], tb.reach[key]];
    console.log(
      `  reach, ${key === 'driver' ? "driver's snapshots" : 'final full-window snapshot'}: ` +
        `seen ${arrow(x.seen, y.seen)} of ${arrow(x.values, y.values)}, truncated ${arrow(x.truncated, y.truncated)}, ` +
        `absent ${arrow(x.absent, y.absent)}`
    );
    const moved = [];
    for (const id of both) {
      const before = a.tasks[id].reach?.[key]?.fields ?? {};
      for (const [value, state] of Object.entries(b.tasks[id].reach?.[key]?.fields ?? {})) {
        if (before[value] && before[value] !== state) moved.push(`      ${id}: ${JSON.stringify(value).slice(0, 60)} ${before[value]} -> ${state}`);
      }
    }
    if (moved.length) console.log(moved.join('\n'));
  }
}

function recordTelemetry(worker, task, { verdict, ms, fields, finalText, finalUrl }) {
  const driverCalls = worker.calls.filter((c) => c.phase === 'driver');
  const snaps = driverCalls.filter((c) => c.tool === 'take_snapshot' && c.text != null).map((c) => c.text);
  const paths = [...driverCalls.filter((c) => c.url).map((c) => c.url), finalUrl]
    .filter(Boolean)
    .map(worker.pathOf)
    .filter(Boolean);
  telemetryTasks[task.id] = {
    family: task.family,
    areas: task.areas,
    verdict,
    ms,
    // The pages the driver navigated to and the one it ended on; a page it
    // reached by clicking a link shows only as the last.
    pages: [...new Set(paths)],
    dirs: [...new Set(paths.map(dirOfPath).filter(Boolean))].sort(),
    tools: toolStats(driverCalls),
    harness: toolStats(worker.calls.filter((c) => c.phase === 'harness')),
    errors: driverCalls.filter((c) => c.isError || c.threw).map((c) => `${c.tool}: ${c.threw ?? c.errorText}`),
    snapshot: snapshotStats(snaps),
    reach: fields ? reachRecord(fields, worker.pages.state, snaps.join('\n'), finalText ?? '') : null,
  };
}

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
  worker.calls.length = 0;
  helpers.phase = 'harness';
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
  // The state before the driver acts, for the mutants that erase the run's
  // record. A copy that cannot be made fails those mutants, not the gate.
  let pristine;
  try {
    pristine = cloneState(pages.state);
  } catch (error) {
    pristine = error;
  }
  helpers.taskId = task.id;
  await mark(helpers, `zoo:${task.id}:start`);
  const startedAt = Date.now();
  let out;
  let verdict = 'fail';
  helpers.phase = 'driver';
  try {
    out = await driver.run(helpers, ctx);
  } catch (error) {
    helpers.phase = 'harness';
    const ms = Date.now() - startedAt;
    await mark(helpers, `zoo:${task.id}:end`);
    taskTimings.push({ task: task.id, ms, ok: false });
    fail++;
    // A dead worker fails every task after this one for no reason of theirs,
    // so it is restarted, and this task's failure says what it most likely
    // was: the browser or the MCP server, not the fixture.
    const transport = TRANSPORT_ERROR.test(error.message) || !(await worker.healthy());
    if (transport) {
      failures.push(
        `${task.id}: transport error on worker ${worker.slot} — ${error.message} ` +
          `(rerun this task alone before reading it as a fixture failure)`
      );
      console.log(`FAIL  ${task.id}  transport error on worker ${worker.slot}: ${error.message}`);
    } else {
      failures.push(`${task.id}: driver threw — ${error.message}`);
      console.log(`FAIL  ${task.id}  driver threw: ${error.message}`);
    }
    if (TELEMETRY) recordTelemetry(worker, task, { verdict: transport ? 'transport' : 'fail', ms });
    return { restart: transport };
  }
  helpers.phase = 'harness';
  const ms = Date.now() - startedAt;
  // Grading is harness-side and costs the browser nothing, so the task's span
  // ends with its last browser interaction rather than with its verdict.
  await mark(helpers, `zoo:${task.id}:end`);
  taskTimings.push({ task: task.id, ms, ok: true });
  // A throwing validator must register as that task's failure, not abort the
  // whole gate mid-flight with workers still up.
  try {
    await gradeOne();
  } catch (error) {
    fail++;
    failures.push(`${task.id}: validator threw — ${error.message}`);
    console.log(`FAIL  ${task.id}  validator threw: ${error.message}`);
  }
  if (TELEMETRY) {
    // The page the driver left, in the whole 500-line window, for reach. Taken
    // once the verdict is in, so it can change neither what the driver saw nor
    // the state the validator graded.
    const finalText = await helpers
      .mcp('take_snapshot', { maxLines: 500 })
      .then(textOf)
      .catch(() => '');
    const finalUrl = await helpers.evaluate(() => location.href).catch(() => null);
    const fields = typeof out === 'string' ? null : (out?.fields ?? null);
    recordTelemetry(worker, task, { verdict, ms, fields, finalText, finalUrl });
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
    const truth = truthOf(task);
    if (truth.invalid) schemaProblems.push(truth.invalid);
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
    // Mutants only mean something against a golden run the validator accepts.
    // A static task runs the empty mutant alone, expecting it to PASS: a
    // declaration its validator has outgrown fails here instead of exempting a
    // task that now reads server state. The empty mutant cannot catch a holed
    // validator that passes it anyway, so a static answer must also carry no
    // code the server minted.
    const minted = good.pass === true ? mintedIn(fields, pages.state) : [];
    const mutants = good.pass !== true
      ? []
      : truth.kind === 'static'
        ? [{ ...MUTANTS[0], mustPass: true }]
        : MUTANTS;
    const mutantResults = mutants.map((m) => {
      try {
        const state = m.build({ pristine, golden: pages.state });
        return { m, r: task.validate('', { ...ctx, pages: { ...pages, state } }, fields) };
      } catch (error) {
        return { m, r: { threw: error } };
      }
    });
    const mutantMisses = mutantResults.filter(({ m, r }) =>
      m.mustPass ? r.pass !== true : r.pass !== false
    );
    if (truth.kind === 'static') staticTruth.push(task.id);
    else {
      const erasing = mutantResults.filter(({ m }) => !m.mustPass);
      exercised.mutantsRun += erasing.length;
      exercised.mutantsKilled += erasing.filter(({ r }) => r.pass === false).length;
      const shadows = mutantResults.filter(({ m }) => m.mustPass);
      exercised.shadowsRun += shadows.length;
      exercised.shadowsIgnored += shadows.filter(({ r }) => r.pass === true).length;
    }
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
      truth.kind === 'static' &&
        minted.length &&
        `truth is declared static ("${truth.reason}") but the golden answer carries ` +
          `${minted.join(', ')}, which the server minted into session state: drop the declaration`,
      ...mutantMisses.map(({ m, r }) =>
        r.threw
          ? `mutant "${m.name}" threw — ${r.threw.message}`
          : truth.kind === 'static'
            ? `truth is declared static ("${truth.reason}") but mutant "empty" fails it, so the ` +
              `verdict reads server state: drop the declaration — ${r.detail ?? ''}`
            : m.mustPass
              ? `validator REJECTED mutant "${m.name}": an unused session minted ahead of the run ` +
                `must not change the verdict — ${r.detail ?? ''}`
              : minted.length
                ? `validator PASSED mutant "${m.name}" with ${m.leaves}, yet the golden answer ` +
                  `carries ${minted.join(', ')}, which the server minted: the validator has a hole ` +
                  `— ${r.detail ?? ''}`
                : `validator PASSED mutant "${m.name}" with ${m.leaves}, so it grades nothing ` +
                  `the server observed: the validator has a hole, unless the answer is published ` +
                  `page content that no session mints, in which case declare truth ` +
                  `{ kind: 'static', reason } — ${r.detail ?? ''}`
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
    verdict = 'ok';
    const stateCounts =
      wrongState.length || alsoCorrectState.length
        ? `; ${wrongState.length} wrong states, ${alsoCorrectState.length} accepted states`
        : '';
    console.log(
      `ok    ${task.id}  (fields; ${wrongFields.length} wrong, ` +
        `${alsoCorrectFields.length} accepted variants${stateCounts}` +
        `; ${truth.kind === 'static' ? 'static truth' : 'mutants killed'}` +
        `${EXTRACT ? '; extractor verified' : ''})`
    );
  }
}

// --affected: which tasks a set of changed files can change. Conservative: a
// file no rule knows maps to every task, and only files the gate never loads
// (docs, results, the paid runner, spikes) map to none.
const AFFECTS_NONE =
  /^(?:docs\/|staging\/|docker\/|\.github\/|eval\/(?:results|spikes|scripts|backends)\/|scripts\/|eval\/(?:run|report|ab|agent-env|run-files)\.mjs$|eval\/tasks\/(?:areas\.json|basic\.mjs)$|eval\/verify-drivers\/timings\.json$|serve\.mjs$|preview\.html$|LICENSE$|NOTICE$)|\.md$/;
const AFFECTS_ALL =
  /^(?:eval\/(?:verify|extract|answers|surface-reach|mcp-stdio|window-grid)\.mjs|eval\/tasks\/web\.mjs|eval\/verify-drivers\/(?:index|helpers)\.mjs|server\.mjs|manifest\.mjs|package(?:-lock)?\.json|sites\/(?:index|lib)\.mjs)$/;

function changedFiles(list) {
  if (list) {
    return list
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => {
        const rel = relative(REPO, resolve(f));
        return (rel.startsWith('..') ? f : rel).split('\\').join('/');
      });
  }
  const git = (gitArgs) => {
    const r = spawnSync('git', ['-C', REPO, ...gitArgs], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`--affected with no file list needs git: ${r.stderr.trim()}`);
    return r.stdout.split('\n').filter(Boolean);
  };
  return [...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])];
}

// Which driver files import each file under verify-drivers/, followed through
// the shared libs, so a change to safety-lib.mjs reaches every driver that
// imports it, directly or through another lib.
function driverImporters() {
  const dir = join(REPO, 'eval', 'verify-drivers');
  const importsOf = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    importsOf[f] = [...readFileSync(join(dir, f), 'utf8').matchAll(/from '\.\/([\w-]+\.mjs)'/g)].map((m) => m[1]);
  }
  const users = (target, seen = new Set()) => {
    for (const [f, deps] of Object.entries(importsOf)) {
      if (deps.includes(target) && !seen.has(f)) {
        seen.add(f);
        users(f, seen);
      }
    }
    return seen;
  };
  return users;
}

// The pages/ dirs each task can load: the origins its ask names, the paths its
// driver's run() names, and the task ids manifest.mjs lists beside each origin.
function taskDirs(tasks) {
  const dirs = new Map(tasks.map((t) => [t.id, new Set()]));
  for (const t of tasks) {
    const source = `${t.ask ?? ''}\n${DRIVERS[t.id]?.run?.toString() ?? ''}`;
    for (const [, path] of source.matchAll(/(?:http:\/\/placeholder|['\`])(\/[\w./-]+)/g)) {
      const dir = dirOfPath(path);
      if (dir) dirs.get(t.id).add(dir);
    }
  }
  const manifest = readFileSync(join(REPO, 'manifest.mjs'), 'utf8');
  for (const [, comment, dir] of manifest.matchAll(/\/\/ ([^\n]*)\n\s*\{ key: '[^']+', dir: '([^']+)'/g)) {
    for (const word of comment.match(/[a-z0-9]+(?:-[a-z0-9]+)+|[a-z]+/g) ?? []) dirs.get(word)?.add(dir);
  }
  return dirs;
}

// The dirs a sites/ module serves: those whose paths it names, and the ones
// named for it (sites/shop.mjs serves shop/*). A module that names none is
// followed to the modules importing it.
function siteDirs(file) {
  const allDirs = DIRS_LONGEST_FIRST;
  const read = (f) => readFileSync(join(REPO, 'sites', f), 'utf8');
  const own = (f) => {
    const src = read(f);
    const name = f.replace(/\.mjs$/, '');
    return allDirs.filter((d) => src.includes(`/${d}/`) || d === name || d.split('/')[0] === name);
  };
  const found = new Set(own(file));
  if (!found.size) {
    for (const f of readdirSync(join(REPO, 'sites')).filter((x) => x.endsWith('.mjs') && x !== 'index.mjs')) {
      if (read(f).includes(`'./${file}'`)) for (const d of own(f)) found.add(d);
    }
  }
  return found;
}

function affectedTasks(files, tasks) {
  const ids = (list) => new Set([...list].filter((id) => DRIVERS[id]));
  const all = ids(tasks.map((t) => t.id));
  const dirs = taskDirs(tasks);
  const users = driverImporters();
  const byDir = (dirSet) => ids(tasks.filter((t) => [...dirs.get(t.id)].some((d) => dirSet.has(d))).map((t) => t.id));
  const out = new Set();
  const lines = [];
  for (const file of files) {
    let hit;
    let why;
    const driverFile = file.match(/^eval\/verify-drivers\/([\w-]+\.mjs)$/)?.[1];
    const family = file.match(/^eval\/tasks\/(?:web\/)?([\w-]+)\.mjs$/)?.[1];
    if (AFFECTS_NONE.test(file)) [hit, why] = [new Set(), 'not loaded by the gate'];
    else if (AFFECTS_ALL.test(file)) [hit, why] = [all, 'shared by every task'];
    else if (driverFile) {
      const files = new Set([driverFile, ...users(driverFile)]);
      hit = ids(Object.entries(DRIVER_FILES).filter(([, f]) => files.has(f)).map(([id]) => id));
      const named = [...files].filter((f) => Object.values(DRIVER_FILES).includes(f));
      why = !hit.size ? 'no driver uses it' : named.length > 4 ? `drivers in ${named.length} files` : `drivers in ${named.join(', ')}`;
    } else if (family && tasks.some((t) => t.family === family)) {
      [hit, why] = [ids(tasks.filter((t) => t.family === family).map((t) => t.id)), `the ${family} family`];
    } else if (file.startsWith('pages/')) {
      const dir = dirOfPath(file.slice('pages'.length));
      [hit, why] = dir ? [byDir(new Set([dir])), `pages under ${dir}/`] : [all, 'outside every site dir'];
    } else if (/^sites\/[\w-]+\.mjs$/.test(file)) {
      const served = siteDirs(file.slice('sites/'.length));
      [hit, why] = served.size ? [byDir(served), `serves ${[...served].join(', ')}`] : [all, 'serves no dir it names'];
    } else [hit, why] = [all, 'no rule maps it, so every task'];
    for (const id of hit) out.add(id);
    lines.push(`  ${file}: ${hit.size} task${hit.size === 1 ? '' : 's'} (${why})`);
  }
  return { ids: out, lines };
}

function recordedTimings() {
  try {
    return JSON.parse(readFileSync(TIMINGS_FILE, 'utf8')).ms ?? {};
  } catch {
    return {};
  }
}

// Recorded wall times order the queue longest-first, so the slowest driver
// (live-auction, about 70s) starts at once instead of last, when it alone
// would set the run's length. A task with no recorded time counts as median.
function longestFirst(ids) {
  const recorded = recordedTimings();
  const known = Object.values(recorded).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 0;
  return ids
    .map((id, i) => ({ id, i, ms: recorded[id] ?? median }))
    .sort((a, b) => b.ms - a.ms || a.i - b.i)
    .map((t) => t.id);
}

const allTasks = await loadTasks('http://placeholder');
if (AREAS) {
  const known = new Set(allTasks.flatMap((t) => t.areas));
  const unknown = AREAS.filter((a) => !known.has(a));
  if (unknown.length) {
    console.error(`--area: no task is tagged ${unknown.join(', ')}; known areas: ${[...known].sort().join(', ')}`);
    process.exit(1);
  }
}
let affected = null;
if (AFFECTED !== null) {
  const files = changedFiles(AFFECTED || null);
  affected = affectedTasks(files, allTasks);
  console.log(`--affected: ${files.length} changed file${files.length === 1 ? '' : 's'}, ${affected.ids.size} task${affected.ids.size === 1 ? '' : 's'}`);
  for (const line of affected.lines) console.log(line);
  if (!affected.ids.size) {
    console.log('no task can change, and the fixture checks above passed');
    process.exit(0);
  }
  console.log('');
}
let queue = [];
for (const task of allTasks) {
  if (!selected(task.id)) continue;
  if (AREAS && !task.areas.some((a) => AREAS.includes(a))) continue;
  if (affected && !affected.ids.has(task.id)) continue;
  if (!DRIVERS[task.id]) {
    skipped++;
    continue;
  }
  queue.push(task.id);
}

if ((patterns || AREAS) && !queue.length) {
  console.error(`the selection matched no task with a driver: ${[...(patterns ?? []), ...(AREAS ?? [])].join(', ')}`);
  process.exit(1);
}
queue = longestFirst(queue);
if (args.includes('--dry-run')) {
  const recorded = recordedTimings();
  console.log(`${queue.length} task${queue.length === 1 ? '' : 's'} would run, in this order:`);
  for (const id of queue) console.log(`  ${id}${recorded[id] ? `  (${(recorded[id] / 1000).toFixed(1)}s recorded)` : ''}`);
  process.exit(0);
}

const workers = [];
let firefoxVersion = null;
let toolList = null;
let next = 0;
try {
  const count = Math.min(JOBS, Math.max(1, queue.length));
  // Grid sized to the workers that will actually exist, not to --jobs: a
  // two-task run asked for eight ways still tiles into two cells.
  const grid = HEADED ? windowGrid(count, detectScreen(flag('screen', null))) : null;
  for (let i = 0; i < count; i++) workers.push(await makeWorker(grid, i));
  if (TELEMETRY) {
    toolList = (await workers[0].listTools()).tools;
    const ua = await workers[0].helpers.evaluate(() => navigator.userAgent).catch(() => '');
    firefoxVersion = String(ua).match(/Firefox\/([\d.]+)/)?.[1] ?? null;
  }
  await Promise.all(
    workers.map(async (_, slot) => {
      while (next < queue.length) {
        const outcome = await runOne(workers[slot], queue[next++]);
        if (!outcome?.restart || next >= queue.length) continue;
        await workers[slot].close().catch(() => {});
        workers[slot] = null;
        try {
          workers[slot] = await makeWorker(grid, slot);
          restarts++;
          console.log(`      worker ${slot} restarted`);
        } catch (error) {
          console.log(`worker ${slot} could not restart, and stops here: ${error.message}`);
          return;
        }
      }
    })
  );
} finally {
  for (const worker of workers) await worker?.close();
}
for (const id of queue.slice(next)) {
  fail++;
  failures.push(`${id}: never ran, because every worker died`);
}

console.log(
  `\n${pass} ok, ${fail} failed, ${skipped} without a golden path` +
    `${SERVING === 'single-origin' ? '' : ` (${SERVING === 'origins' ? 'origin' : 'vhost'} mode)`}` +
    `${restarts ? `, ${restarts} worker restart${restarts === 1 ? '' : 's'} after a transport error` : ''}`
);
console.log(
  `cases exercised: ${exercised.wrongFields} wrongFields and ${exercised.wrongState} wrongState ` +
    `(must fail), ${exercised.alsoCorrectFields} alsoCorrectFields and ` +
    `${exercised.alsoCorrectState} alsoCorrectState (must pass), ` +
    `${exercised.neverAnswered} never-answered shapes (must fail), ` +
    `${exercised.mutantsKilled}/${exercised.mutantsRun} mutants killed (empty, fresh; must fail), ` +
    `${exercised.shadowsIgnored}/${exercised.shadowsRun} shadow sessions ignored (must pass)`
);
if (staticTruth.length) {
  console.log(`static truth, exempt from mutants: ${staticTruth.sort().join(', ')}`);
}
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
if (TELEMETRY) {
  const telemetry = telemetryReport();
  mkdirSync(dirname(resolve(TELEMETRY)), { recursive: true });
  writeFileSync(resolve(TELEMETRY), JSON.stringify(telemetry, null, 1) + '\n');
  const { driver, final } = telemetry.totals.reach;
  const excluded = Object.keys(telemetry.totals.excluded).length;
  console.log(
    `\ntelemetry: ${resolve(TELEMETRY)}\n` +
      `  over ${telemetry.totals.tasks} ok task${telemetry.totals.tasks === 1 ? '' : 's'}${excluded ? ` (${excluded} not ok, excluded)` : ''}, ` +
      `graded values in a driver's snapshot: ${driver.seen}/${driver.values} seen, ${driver.truncated} truncated; ` +
      `in the final full-window snapshot: ${final.seen}/${final.values} seen, ${final.truncated} truncated`
  );
  if (COMPARE) printTelemetryDiff(JSON.parse(readFileSync(COMPARE, 'utf8')), telemetry);
}
if (RECORD_TIMINGS) {
  const ms = recordedTimings();
  for (const t of taskTimings) if (t.ok) ms[t.task] = t.ms;
  const sorted = Object.fromEntries(Object.entries(ms).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    TIMINGS_FILE,
    JSON.stringify(
      {
        measured: {
          at: new Date().toISOString().slice(0, 10),
          jobs: JOBS,
          devtools: devtoolsMcpInfo().version,
          serving: SERVING,
        },
        ms: sorted,
      },
      null,
      1
    ) + '\n'
  );
  console.log(`\ntimings: ${taskTimings.filter((t) => t.ok).length} tasks recorded in ${relative(process.cwd(), TIMINGS_FILE)}`);
}
process.exitCode = fail ? 1 : 0;
