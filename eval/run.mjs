// Browser tool-surface eval: run the same deterministic browser tasks through an
// agent backend against one or more MCP browser servers, and compare success,
// tokens, cost and duration. Identical tasks over identical fixtures mean a
// difference between two conditions comes from the surface, not the pages.
//
//   node run.mjs [options] — see --help for the full flag list.
//
// Suites: 'basic' = tiny smoke pages, 'web' = simulated sites; both are
// served locally from pages/ (no live web), every site on its own loopback
// port unless --single-origin. --headed shows Firefox.
// Two conditions ship by default: 'firefox-devtools-mcp' and 'playwright-mcp'
// (the vendored @playwright/mcp). --mcp-command replaces the former with any
// stdio MCP server, --devtools-build adds one firefox-devtools-mcp@<label>
// condition per build of the tool, and --conditions selects which run.
// Results land in results/ (gitignored) as JSON plus a shareable
// markdown report.
//
// Common runs:
//   node run.mjs
//     quick smoke: basic suite, both conditions, sequential
//   node run.mjs --suite web --parallel --parallel-tasks 2
//     the default sweep: both conditions (headless)
//   node run.mjs --suite web --backend all --conditions firefox-devtools-mcp,playwright-mcp --parallel --parallel-tasks 4 --headed
//     full demo matrix, both backends, tiled windows
//   node run.mjs --suite web --task <ids> --repeat 3 --parallel --parallel-tasks 4
//     repeats give medians and an instability flag, and parallelism keeps it to
//     minutes. Output tokens are contention-free, so the primary metric is
//     unaffected; read the wall column as indicative only
//   node run.mjs --suite web --repeat 3
//     fully sequential: only for numbers you plan to publish. Even then wall is
//     noisy (a task can take 94.9s on one repeat and 27.9s on another with an
//     identical turn count), so sequential de-noises it rather than fixing it
//   node run.mjs --suite web --task cart-math,coupon-stack --parallel
//     just the tasks you care about (comma list, * wildcards, --list-tasks
//     to preview the selection)
//   node run.mjs --rerun-failed results/run-<stamp>
//     top up a run that hit flaky failures, without repeating the passes
//   node scripts/transcript.mjs [run-dir] [--task <id>]
//     inspect what the agents actually did
//
// Runaway protection is a per-task wall-clock tier (quick/standard/long/epic,
// see WALL_TIERS; --max-wall overrides all of them) plus --max-output. There is
// deliberately no turn limit, and turns compare only between runs whose backend
// counts a turn the same way (see markdownReport's note).
//
// Every attempt is isolated: a fresh working directory that is removed
// afterwards and receives the browser's downloads, an allowlisted environment
// (agent-env.mjs), and a pinned tool policy per backend that each run's meta
// records. Every condition's browser runs with the same locale, time zone,
// viewport and colour scheme (BROWSER_PINS in mcp-stdio.mjs).

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  appendFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPagesServer } from '../server.mjs';
import { ORIGINS, originUrls } from '../manifest.mjs';
import { FORGE_DEFECT_KEYS } from '../sites/forge.mjs';
import { basicTasks } from './tasks/basic.mjs';
import { webTasks } from './tasks/web.mjs';
import { devtoolsTasks } from './tasks/devtools.mjs';
import {
  agentEnv, attemptDownloads, makeTempDir, removeAllTempDirs, removeTempDir, serverDirName, SHIMMED_COMMANDS,
  shimmedPath, TEMP_PREFIX, writeStateFile,
} from './agent-env.mjs';
import { extractFields, extractorInfo, isSentinel } from './extract.mjs';
import {
  BROWSER_PINS, DEVTOOLS_FIREFOX_VAR, DEVTOOLS_SERVER_ENV, PINNED_PREFS, devtoolsFirefox, devtoolsFirefoxLaunch,
  devtoolsFirefoxPolicy, devtoolsMcpEntry, devtoolsMcpInfo, devtoolsWindowSize, downloadPrefs, firefoxBuild, playwrightFirefox, prefArgs, sha256File,
  startMcpServer,
} from './mcp-stdio.mjs';
import {
  blameToolErrors, contentText, createCallRecorder, ensureTapExit, instructionsInfo, readTapLog, serverExit, tapSpec,
  tapSurfaceCalls, tapToolStats, toolsListInfo,
} from './mcp-tap.mjs';
import { envDrift, markdownReport, totalsByCondition } from './report.mjs';
import { renderHtmlReport } from './scripts/html-report.mjs';
import { readRun, transcriptName } from './run-files.mjs';
import {
  foreignBrowser, OVERLAP_MS, SHELL_AFTER_MS, SURFACE_AFTER_MS, SURFACE_BEFORE_MS, SURFACE_SLACK_MS, tapWindows,
} from './scripts/foreign-browser.mjs';
import { findBuild, taskInfo } from './scripts/identity.mjs';
import { shellAssisted } from './scripts/row-evidence.mjs';
import { healthLine, PRICE_TABLE, runHealth } from './scripts/run-health.mjs';
import { createReachRecorder, gradedValues, truthValues } from './surface-reach.mjs';
import { detectScreen, windowGrid } from './window-grid.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// A bad flag is the user's typo, not a harness fault: one line, no stack.
function usage(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
// Each flag below looks up its own name, so an argument none of them names (a
// typo, --backend=scripted, several flags in one quoted string) would be
// ignored and leave the run on its paid defaults. A new flag goes in one of these.
const VALUE_FLAGS = new Set([
  'ab', 'backend', 'compare', 'conditions', 'control', 'devtools-build', 'devtools-firefox', 'effort', 'max-output', 'max-wall',
  'mcp-command', 'mode', 'model', 'parallel-tasks', 'repeat', 'report-from', 'rerun-failed', 'retries', 'screen',
  'seed', 'suite', 'task',
]);
const SWITCHES = new Set(['headed', 'help', 'interleave', 'list-tasks', 'no-tap', 'parallel', 'record-video', 'single-origin', 'vhosts']);
for (let i = 0; i < args.length; i++) {
  const name = args[i].startsWith('--') ? args[i].slice(2) : null;
  if (VALUE_FLAGS.has(name)) i++;
  else if (!SWITCHES.has(name) && args[i] !== 'help') usage(`unknown argument "${args[i]}" (see --help)`);
}
// --seed <string>: deterministic difficulty draws across every site that
// mints one (auction rungs, forge variant and pads, schedule week, cabins
// calendar, depot shard and rejects, boxoffice plan, kanban board, calc
// defect, maze layout, metrics target, roles desk). Scope counters reset per
// task, so paired conditions and repeat runs face the same shapes.
// Identifier mints (codes, refs, nonces) stay on randomBytes regardless - a
// seeded run is reproducible, never forgeable.
// Every run is seeded: without --seed the seed is the run's own stamp, so the
// arms of a run always face the same draws, and `--seed none` opts out.
// Unseeded arms draw different puzzles (a seat-picker plan, a pr-review
// defect), which widens every paired difference.
const seedIdx = args.indexOf('--seed');
const SEED_ARG = seedIdx !== -1 ? args[seedIdx + 1] ?? null : undefined;
if (seedIdx !== -1 && (!SEED_ARG || SEED_ARG.startsWith('--'))) {
  usage('--seed requires a value');
}
// Set in main(), once the run stamp exists; null only under `--seed none`.
let RUN_SEED = null;

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    usage(`--${name} requires a value`);
  }
  return value;
};
// `ok` judges the parsed number; `want` names the accepted range in the error.
const numberFlag = (name, fallback, ok, want) => {
  const raw = flag(name, null);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (raw.trim() === '' || !ok(n)) usage(`--${name} must be ${want}, got "${raw}"`);
  return n;
};
// --rerun-failed <run-dir> selects exactly the tasks that did not pass in an
// earlier run (failures, errored rows, and tasks it never finished), so a flaky
// or interrupted run can be topped up without re-running everything or
// hand-copying ids out of a log. The top-up's rows are read together with that
// run's, so they have to come from the same agent on the same tools: each flag
// that says what ran (backend, models, effort, conditions and their builds,
// --mcp-command, --mode, --seed, serving, --no-tap, --max-wall, --max-output)
// takes that run's value when the top-up leaves it out, and is refused when it
// names another. --repeat, --retries and the scheduling flags decide how many
// attempts run and when, not what an attempt measures, so they are the
// top-up's own. The earlier run's suite is the default too, since its ids match
// nothing in another suite.
const RERUN_FAILED = flag('rerun-failed', null);
let PRIOR = null;
if (RERUN_FAILED) {
  try {
    PRIOR = readRun(RERUN_FAILED);
  } catch (error) {
    usage(`--rerun-failed: cannot read ${RERUN_FAILED}: ${error.message}`);
  }
}
const PRIOR_META = PRIOR ? (PRIOR.meta ?? {}) : null;
const shown = (value) => (value == null ? 'none' : JSON.stringify(value));
// `impliedBy` names the flag whose default `given` is, where no flag gave it.
function refuseTopUp(name, recorded, given, impliedBy = null) {
  usage(
    `--rerun-failed: ${RERUN_FAILED} ran with ${name} ${shown(recorded)}, not ${shown(given)}` +
      `${impliedBy ? `, which ${impliedBy} implies` : ''}. A top-up is read together with the run it tops up, ` +
      'so drop that flag, or select the tasks with --task instead.'
  );
}
// A flag's value under --rerun-failed: the earlier run's `recorded` value when
// the top-up gives none, else `given`, which has to match it under `same`.
// `recorded` is undefined where that run recorded nothing, which leaves the
// flag to its own default.
function rerunValue(name, given, recorded, { same = (x, y) => x === y, impliedBy = null } = {}) {
  if (!PRIOR_META || recorded === undefined) return given;
  if (given == null) return recorded;
  if (!same(given, recorded)) refuseTopUp(name, recorded, given, impliedBy);
  return given;
}
const sameSet = (x, y) => [...x].sort().join(',') === [...y].sort().join(',');
const listOf = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);

// --mode key=value (repeatable): default server modes for every pages server
// in the run, e.g. --mode forgeDefect=cache-key --mode auctionDraw=decline to
// pin per-session draws for comparable repeats. A key no site reads, or a value
// its site ignores, would leave the draw random while meta.modes said it was
// pinned, so SERVER_MODES names the keys sites read and the values each acts
// on. pick.<scope> forces one ctx.pick draw (server.mjs pick). Its scopes and
// options live in each site's call, so a misspelled scope pins nothing, and a
// value naming no option throws at the first request that draws it.
const SERVER_MODES = {
  // sites/auction.mjs
  auctionDraw: ['decline', 'win'],
  forgeDefect: FORGE_DEFECT_KEYS,
  // sites/shop.mjs, which reads it as a boolean
  gadgetronDown: ['true', 'false'],
};
const GIVEN_MODES = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--mode') continue;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) usage('--mode requires <key>=<value>');
  const eq = value.indexOf('=');
  const key = eq > 0 ? value.slice(0, eq) : '';
  const raw = eq > 0 ? value.slice(eq + 1) : '';
  if (!key || !raw) usage(`--mode takes <key>=<value>, got "${value}"`);
  if (!Object.hasOwn(SERVER_MODES, key) && !/^pick\.\S+$/.test(key)) {
    usage(`unknown --mode key "${key}" (known: ${Object.keys(SERVER_MODES).join(', ')}, or pick.<scope>)`);
  }
  const values = SERVER_MODES[key];
  if (values && !values.includes(raw)) usage(`--mode ${key} takes ${values.join('|')}, got "${raw}"`);
  if (Object.hasOwn(GIVEN_MODES, key)) usage(`--mode ${key} is given twice`);
  GIVEN_MODES[key] = key === 'gadgetronDown' ? raw === 'true' : raw;
}
// A top-up's modes as its sites read the earlier run's: shop.mjs tests
// gadgetronDown for truth, so a run that recorded the string "false" ran with
// the store down, and its top-up does too.
const RUN_MODES = Object.fromEntries(
  Object.entries(PRIOR_META?.modes ?? {}).map(([key, value]) => [key, key === 'gadgetronDown' ? Boolean(value) : value])
);
for (const [key, value] of Object.entries(GIVEN_MODES)) {
  RUN_MODES[key] = rerunValue(`--mode ${key}`, value, PRIOR_META ? (RUN_MODES[key] ?? null) : undefined, {
    same: (x, y) => String(x) === String(y),
  });
}

// --compare pins one axis so a run is attributable. Varying the browser tool
// surface AND the agent harness at once yields a 2x2 whose differences cannot be
// assigned to either, which is the easiest mistake to make here.
const COMPARE = flag('compare', null);
if (COMPARE && !['surfaces', 'backends'].includes(COMPARE)) {
  usage(`--compare must be surfaces or backends, got "${COMPARE}"`);
}
// 'all' means every agent backend; scripted runs no agent, so only naming it
// selects it.
const AGENT_BACKENDS = ['anthropic', 'codex'];
const KNOWN_BACKENDS = [...AGENT_BACKENDS, 'scripted'];
const backendList = (value) => (value === 'all' ? AGENT_BACKENDS : listOf(value));
const BACKEND_ARG =
  rerunValue('--backend', flag('backend', COMPARE === 'backends' ? 'all' : null), PRIOR_META?.backend, {
    same: (x, y) => sameSet(backendList(x), backendList(y)),
    impliedBy: flag('backend', null) ? null : '--compare backends',
  }) ?? 'anthropic';
const BACKEND_NAMES = backendList(BACKEND_ARG);
if (!BACKEND_NAMES.length) usage(`--backend names no backend (known: ${KNOWN_BACKENDS.join(', ')}, or all)`);
for (const name of BACKEND_NAMES) {
  if (!KNOWN_BACKENDS.includes(name)) {
    usage(`unknown backend "${name}" (known: ${KNOWN_BACKENDS.join(', ')}, or all)`);
  }
}
// A scripted row is a golden path, not an agent's run, so a run mixing it with
// an agent backend would report the two side by side as if they were comparable.
if (BACKEND_NAMES.includes('scripted') && BACKEND_NAMES.length > 1) {
  usage('--backend scripted runs no agent, so it cannot share a run with an agent backend');
}
const BACKENDS = Object.fromEntries(
  await Promise.all(
    BACKEND_NAMES.map(async (name) => [name, await import(`./backends/${name}.mjs`)])
  )
);
// The package each backend drives, for the run's recorded versions.
const SDK_PACKAGES = {
  anthropic: '@anthropic-ai/claude-agent-sdk',
  codex: '@openai/codex-sdk',
  scripted: '@modelcontextprotocol/sdk',
};
// --model takes either a bare id, which pins the run's single backend, or
// <backend>=<id> (repeatable) to pin one model per backend, e.g.
//   --model codex=gpt-5.6-luna --model anthropic=claude-sonnet-5
// Mixing the forms, or naming a backend the run does not include, is rejected:
// a typo that silently left a backend on its default would misattribute every
// number in the report to a model that never ran.
const MODEL_BY_BACKEND = {};
let MODEL_ALL = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--model') continue;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    usage('--model requires a value');
  }
  const eq = value.indexOf('=');
  if (eq <= 0) {
    if (MODEL_ALL) usage('--model was given twice without a backend prefix');
    MODEL_ALL = value;
    continue;
  }
  const name = value.slice(0, eq);
  const id = value.slice(eq + 1);
  if (!id) usage(`--model ${value} names no model`);
  if (!BACKEND_NAMES.includes(name)) {
    usage(`--model ${value}: "${name}" is not a backend in this run (${BACKEND_NAMES.join(', ')})`);
  }
  if (MODEL_BY_BACKEND[name]) {
    usage(`--model set twice for backend "${name}"`);
  }
  MODEL_BY_BACKEND[name] = id;
}
if (MODEL_ALL && Object.keys(MODEL_BY_BACKEND).length) {
  usage('--model takes either one id or <backend>=<id> per backend, not both forms in one run');
}
if (MODEL_ALL && BACKEND_NAMES.length > 1) {
  usage(
    'a bare --model cannot be combined with multiple backends; pin each one with ' +
      `--model <backend>=<id> (${BACKEND_NAMES.join(', ')})`
  );
}
if (PRIOR_META) {
  const recorded = PRIOR_META.models ?? (PRIOR_META.model ? { [PRIOR_META.backend ?? 'anthropic']: PRIOR_META.model } : {});
  for (const name of BACKEND_NAMES) {
    if (!recorded[name] || recorded[name] === '(backend default)') continue;
    const given = MODEL_BY_BACKEND[name] ?? MODEL_ALL;
    MODEL_BY_BACKEND[name] = rerunValue(BACKEND_NAMES.length > 1 ? `--model ${name}=` : '--model', given, recorded[name]);
  }
}
const modelFor = (name) => MODEL_BY_BACKEND[name] ?? MODEL_ALL ?? BACKENDS[name].DEFAULT_MODEL;
for (const name of BACKEND_NAMES) {
  const models = BACKENDS[name].MODELS;
  if (models && !models.includes(modelFor(name))) {
    usage(`--model ${modelFor(name)} is not a model ${name} has (${models.join(', ')})`);
  }
}
// A backend whose model owns its fields answers with fields of its own
// (scripted), so a run of only such backends never calls the extractor.
const EXTRACTOR_USED = !BACKEND_NAMES.every((name) => BACKENDS[name].ownsFields?.(modelFor(name)));
// The stub extractor grades only scripted answers, and a scripted answer never
// reaches a paid extractor.
if (EXTRACTOR_USED && BACKEND_NAMES.includes('scripted') && extractorInfo().extractor !== 'scripted') {
  usage(`--model ${modelFor('scripted')} hands its answers to the extractor; set EVAL_EXTRACTOR=scripted so its stub grades them, not a paid model`);
}
if (EXTRACTOR_USED && !BACKEND_NAMES.includes('scripted') && extractorInfo().extractor === 'scripted') {
  usage('EVAL_EXTRACTOR=scripted grades only the scripted backend\'s answers, not an agent\'s');
}
// Pin reasoning effort symmetrically across backends (Agent SDK `effort`,
// codex `model_reasoning_effort`); 'default' leaves each backend's own default.
// The backends accept different ladders, so a level must suit every backend in
// the run: codex has no 'max', the Agent SDK no 'minimal'.
const EFFORT = rerunValue('--effort', flag('effort', null), PRIOR_META?.effort) ?? 'medium';
if (EFFORT !== 'default') {
  for (const name of BACKEND_NAMES) {
    const levels = BACKENDS[name].EFFORT_LEVELS;
    if (!levels.includes(EFFORT)) {
      usage(`--effort ${EFFORT} is not a level ${name} accepts (${levels.join('|')}, or default)`);
    }
  }
}
const REPEAT = numberFlag('repeat', 1, (n) => Number.isInteger(n) && n >= 1, 'a positive integer');
// The tasks, suite, serving and seed a --rerun-failed top-up takes from the
// run it tops up.
let RERUN_IDS = null;
let RERUN_SUITE = null;
let RERUN_SERVING = null;
let RERUN_SEED;
if (PRIOR) {
  RERUN_SUITE = PRIOR_META.suite ?? null;
  // A run that records no serving mode predates per-origin serving.
  RERUN_SERVING = PRIOR_META.serving ?? 'single-origin';
  // The same seed gives the top-up the same draws as the rows it joins, and a
  // run recorded under --seed none (seed: null) is topped up unseeded. A run
  // without the key predates default seeding, so its top-up gets its own stamp.
  if (typeof PRIOR_META.seed === 'string' || PRIOR_META.seed === null) {
    RERUN_SEED = PRIOR_META.seed;
    if (SEED_ARG !== undefined) rerunValue('--seed', SEED_ARG, RERUN_SEED ?? 'none');
  }
  // An invalid row passed or failed without measuring the surface, so it is
  // rerun like a failure.
  const failed = PRIOR.results.filter((r) => !r.success || r.invalid).map((r) => r.task);
  // A run that was interrupted, crashed, or lost a whole condition has no row at
  // all for some tasks, and a missing row cannot fail. meta.tasks names every
  // task the run selected, so a task short of one row per cell is selected too.
  const incomplete =
    PRIOR_META.interrupted || PRIOR_META.failed || PRIOR.results.some((r) => r.task === '(condition)');
  if (incomplete && !PRIOR_META.tasks) {
    usage(
      `--rerun-failed: ${RERUN_FAILED} did not finish every task, and it predates the ` +
        'record of which tasks it selected, so the unfinished ones cannot be named. ' +
        'Rerun them with --task.'
    );
  }
  const cells =
    (PRIOR_META.backend?.split(',').length ?? 1) *
    (PRIOR_META.conditions?.split(',').length ?? 1) *
    (PRIOR_META.repeat ?? 1);
  const rowsPerTask = new Map();
  for (const r of PRIOR.results) rowsPerTask.set(r.task, (rowsPerTask.get(r.task) ?? 0) + 1);
  const unfinished = (PRIOR_META.tasks ?? []).filter((id) => (rowsPerTask.get(id) ?? 0) < cells);
  RERUN_IDS = [...new Set([...failed, ...unfinished])].filter((id) => id && id !== '(condition)');
  if (!RERUN_IDS.length) {
    console.log(`--rerun-failed: every task passed in ${RERUN_FAILED}, nothing to do`);
    process.exit(0);
  }
  console.log(
    `--rerun-failed: ${RERUN_IDS.length} task(s) from ${RERUN_FAILED}: ${RERUN_IDS.join(', ')}` +
      (unfinished.length ? ` (${unfinished.length} never finished)` : '')
  );
}
const SUITE = flag('suite', RERUN_SUITE ?? 'basic');
// 'origins' serves every site on its own port with its directory at '/', the
// container's shape. 'single-origin' serves every site under its pages/
// directory on one port, so every URL an agent sees names that directory
// (/flaky/slow.html, /maze/), and it is how every run before 2026-09-19 was
// served. 'vhosts' serves every site on one port under its own host name,
// <key>.localhost, so sites differ by host rather than by port. A rerun keeps
// the serving of the run it tops up, since a top-up is read together with that
// run.
if (args.includes('--single-origin') && args.includes('--vhosts')) {
  usage('--single-origin and --vhosts are two serving modes; pick one');
}
const SERVING =
  rerunValue(
    'serving',
    args.includes('--single-origin') ? 'single-origin' : args.includes('--vhosts') ? 'vhosts' : null,
    RERUN_SERVING ?? undefined
  ) ?? 'origins';
// --task takes a comma list of ids, each optionally using * as a wildcard, so a
// few tasks can be run without the whole suite:
//   --task ledger-sum                     one task
//   --task cart-math,coupon-stack         several
//   --task 'ledger-*,crm-join'            wildcard plus an exact id
const ONLY_TASK = flag('task', null);
const TASK_PATTERNS = RERUN_IDS
  ? RERUN_IDS
  : ONLY_TASK
    ? ONLY_TASK.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
const LIST_TASKS = args.includes('--list-tasks');
// Re-render report.md from a finished run's results.json, so a reporting change
// can be applied to runs that already cost money to produce.
const REPORT_FROM = flag('report-from', null);
// --ab A,B adds eval/ab.mjs's paired comparison of two of that run's
// conditions, and --control A2,B an A/A pair, A2 a second label of B's build,
// whose spread is the noise floor the A/B is read against.
const pairFlag = (name) => {
  const raw = flag(name, null);
  if (raw === null) return null;
  const pair = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (pair.length !== 2 || pair[0] === pair[1]) {
    usage(`--${name} takes two different conditions, <A>,<B>; got "${raw}"`);
  }
  return pair;
};
const AB = pairFlag('ab');
const CONTROL = pairFlag('control');
if ((AB || CONTROL) && !REPORT_FROM) usage('--ab and --control apply only with --report-from <dir>');
if (CONTROL && !AB) usage('--control is the noise floor for an --ab comparison, so it needs --ab');
// Wall-clock budget tiers. Real work is not uniformly sized: a smoke page is
// seconds, a rate-limited or embargoed flow has an unavoidable floor, and a
// fog-of-war maze is long-horizon by design. A task declares `tier` and gets
// that cap; --max-wall overrides every tier when you want one number.
const WALL_TIERS = { quick: 180, standard: 600, long: 1800, epic: 5400 };
const DEFAULT_TIER = 'standard';
// A limit decides which attempts fail, so a top-up keeps the earlier run's. A
// run that recorded its wall tiers recorded its limits too, and one it left out
// was off; `|| null` reads a 0 as off.
const priorLimit = (key) => (PRIOR_META && 'wallTiers' in PRIOR_META ? (PRIOR_META[key] || null) : undefined);
const sameLimit = { same: (x, y) => (x || null) === (y || null) };
const MAX_WALL_OVERRIDE =
  rerunValue(
    '--max-wall',
    numberFlag('max-wall', null, (n) => Number.isFinite(n) && n > 0, 'a positive number of seconds'),
    priorLimit('maxWall'),
    sameLimit
  ) || 0;
const wallCapFor = (task) =>
  MAX_WALL_OVERRIDE || WALL_TIERS[task?.tier ?? DEFAULT_TIER];
const MAX_OUTPUT =
  rerunValue(
    '--max-output',
    numberFlag('max-output', null, (n) => Number.isInteger(n) && n >= 0, 'a non-negative integer (0 = off)'),
    priorLimit('maxOutput'),
    sameLimit
  ) || 0;
const RETRIES = numberFlag('retries', 2, (n) => Number.isInteger(n) && n >= 0, 'a non-negative integer');
// How long an interrupt waits for the attempts it stopped to report their spend.
const INTERRUPT_GRACE_MS = 10000;
// API/infrastructure hiccups (dropped connections, overload, 5xx) otherwise land
// as ERROR rows that look like task failures and poison a whole run's numbers.
// Retries re-run the task from scratch against freshly reset server state.
const TRANSIENT = /connection closed|connection error|econnreset|epipe|etimedout|socket hang up|overloaded|rate.?limit|too many requests|\b(429|500|502|503|504|529)\b|internal server error|service unavailable/i;
// Whether a failed attempt is retried, and whether a row it ends is `infra`.
// A harness stop is judged by the harness alone: TRANSIENT's status codes would
// otherwise read "output-token limit 500" as a server error.
function classify(error) {
  const message = String(error?.message ?? '');
  if (error?.harnessStop) {
    // An interrupt is the operator's doing, so the agent is not charged for it.
    if (/interrupted by/.test(message)) return { retry: false, infra: true };
    // A wall-limit stop is usually infra slowness, so it is worth retrying; an
    // output-token stop means the agent itself ran away, so it is not.
    return { retry: /wall limit/i.test(message), infra: false };
  }
  const transient = TRANSIENT.test(message);
  return { retry: transient, infra: transient };
}
function patternMatches(p, id) {
  return p.includes('*')
    ? new RegExp(
        '^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
      ).test(id)
    : id === p;
}

function taskSelected(id) {
  if (!TASK_PATTERNS) return true;
  return TASK_PATTERNS.some((p) => patternMatches(p, id));
}
if (args.includes('--help') || args.includes('help')) {
  console.log(`eval harness — run agents against local simulated websites through
different browser tool surfaces and compare them. Default comparison is
firefox-devtools-mcp vs the vendored @playwright/mcp ('playwright-mcp').

Usage: node run.mjs [options]

Selecting what to run:
  --suite <name>          basic|web|devtools|all (default: basic, or the earlier
                          run's suite under --rerun-failed; web = the
                          simulated-site agent flows; devtools = the
                          console/network/debugger surface, kept separate)
  --task <ids>            comma list of task ids; * wildcards allowed. Examples:
                            --task cart-math
                            --task cart-math,coupon-stack,oos-substitute
                            --task 'ledger-*'
                          An id that matches nothing errors and prints the
                          available ids for the suite.
  --list-tasks            print the selected ids with their wall-clock tier and
                          cap, then exit without running anything. Combine with
                          --suite/--task to preview a subset for free.
  --rerun-failed <dir>    select exactly the tasks that failed, errored or never
                          finished in an earlier run dir (reads its
                          results.json, or the meta.json and rows.jsonl of a
                          killed run; overrides --task) — for topping up a
                          run that hit flaky errors or was interrupted. Runs
                          what that run recorded: its backend, models, effort,
                          conditions and their builds, --mcp-command, --mode
                          pins, seed, serving, --no-tap, --max-wall and
                          --max-output. A flag left out takes that run's
                          value, and one that names another is refused. Its
                          suite is the default, and a suite without its tasks
                          selects nothing. It cannot keep that run's browser
                          environment, tool build contents, SDK versions or
                          task definitions, so report.md notes where the two
                          differ

Serving:
  --single-origin         serve every site under its pages/ directory on one
                          port, as every run before 2026-09-19 was. Default:
                          every site on its own loopback port with its
                          directory at '/', so no task prompt names a
                          directory. The modes are separate measurement
                          epochs; meta records which one a run used
  --vhosts                serve every site on one port under its own host
                          name, http://<key>.localhost:<port>

Reporting:
  --report-from <dir>     rewrite report.md and report.html from a run's results.json, or from
                          the meta.json and rows.jsonl of a killed run, print
                          the transcript judge's standing questions for it,
                          and exit; runs no agents, so reporting changes can be
                          applied to runs you already paid for
  --ab <A>,<B>            with --report-from: also write ab--<A>--<B>.md, the
                          paired comparison of conditions A and B (eval/ab.mjs)
  --control <A2>,<B>      with --ab: an A/A pair of that run, A2 a second label
                          of B's build and B the same B as --ab's, whose
                          spread is the noise floor

Limits and reliability:
  --retries <n>           retry a task on transient API/infra errors
                          (default: 2; an --max-output stop is never retried)
  --max-wall <s>          override every task's wall cap with s seconds.
                          Omit to use per-task tiers: quick 180s, standard 600s
                          (default), long 1800s, epic 5400s. A wall stop is
                          retried, since infra slowness is the usual cause
  --max-output <n>        fail a task that spends more than n output tokens
                          (0 = off), stopping it at the cap. Codex reports
                          usage only when a run ends, so a codex run is failed
                          then instead of stopped
  --repeat <n>            run each task n times; the report gains a per-task
                          median (min-max) table and flags tasks whose output
                          tokens vary by more than 2x between repeats

Conditions and models:
  --model <id>            model for the run's backend; with several backends
                          use <backend>=<id> instead, repeatable, e.g.
                            --model codex=gpt-5.6-luna
                            --model codex=gpt-5.6-luna --model anthropic=claude-sonnet-5
                          A backend left unnamed keeps its own default.
  --effort <level>        reasoning effort for every backend (default: medium;
                          'default' = leave backend defaults). anthropic takes
                          low|medium|high|xhigh|max, codex minimal|low|medium|
                          high|xhigh; a level must suit every backend in the run
  --backend <names>       anthropic (default), codex, comma list, or 'all'
                          (both agents). 'scripted' runs no agent and costs
                          nothing: each task's golden-path driver
                          (verify-drivers/) answers through the condition's
                          server, firefox-devtools-mcp conditions only, and
                          its fields are graded without the extractor. Its
                          --model wrong-fields answers with the driver's
                          wrongFields, so every row has to FAIL. Under
                          EVAL_EXTRACTOR=scripted, --model extracted,
                          misquoted and extractor-down answer with text
                          alone, graded through a free stub extractor:
                          extracted has to PASS, the other two FAIL. codex
                          offers its tools in the mode EVAL_CODEX_TOOL_MODE
                          names: code_mode_only (the default, as codex ships
                          gpt-5.6-*), code_mode or direct; its extractor
                          keeps the default
  --headed                visible Firefox windows, tiled into a screen-sized
                          grid (one cell per browser; wraps with a cascade
                          offset past capacity)
  --screen <WxH>          screen size for the headed grid (default: detected
                          on macOS, else 1920x1080)
  --compare surfaces|backends
                          pin one axis so results are attributable.
                          'surfaces' (default): one agent harness, every
                          condition — how the browser tool surface affects the
                          run. 'backends': one tool surface
                          (firefox-devtools-mcp), every harness — how the agent
                          harness affects it.
                          Warns if you vary both axes at once.
  --conditions <list>     comma list of firefox-devtools-mcp, playwright-mcp
                          and any firefox-devtools-mcp@<label> (default: both —
                          @mozilla/firefox-devtools-mcp and the vendored
                          @playwright/mcp, both over stdio driving their own
                          Firefox. --mcp-command replaces the former; with
                          --devtools-build, the default is every build)
  --devtools-build <label>=<root|dep>
                          add condition firefox-devtools-mcp@<label>, which
                          runs the build at <root> (a built checkout's repo
                          root) or, for dep, the @mozilla/firefox-devtools-mcp
                          dependency. Repeatable; the same root under two
                          labels is an A/A pair, e.g.
                            --devtools-build base=dep --devtools-build aa=dep
                            --devtools-build caps=../firefox-devtools-mcp
                          meta.builds records each build's version, hashes and
                          tool list
  --devtools-firefox [<label>=]<path|playwright>
                          the Firefox every built-in firefox-devtools-mcp
                          condition launches (its --firefox-path), or with
                          <label>= that --devtools-build label's, repeatable.
                          playwright names the build playwright-mcp launches,
                          so both tools run one browser; a path names a
                          firefox executable or a macOS .app. Default:
                          ${DEVTOOLS_FIREFOX_VAR}, else the installed Firefox.
                          A pref that build's playwright.cfg overrides
                          (pdfjs.disabled) is set back by a policy. meta
                          records each condition's binary, e.g.
                            --devtools-firefox playwright
                            --devtools-build rel=dep --devtools-build pw=dep
                            --devtools-firefox pw=playwright
  --mode <key=value>      pin a server mode for every task in the run
                          (repeatable), e.g. --mode forgeDefect=cache-key
                          --mode auctionDraw=decline for comparable repeats.
                          Keys: ${Object.keys(SERVER_MODES).join(', ')}, or
                          pick.<scope> to force one draw
  --seed <string>|none    deterministic difficulty draws (auction rungs, forge
                          variant and pads, schedule week): paired conditions
                          and repeats face the same shapes. Default: the run's
                          own stamp, so every run is seeded; 'none' draws at
                          random. Codes and refs stay random - seeded runs are
                          never forgeable
  --mcp-command "<cmd>"   custom stdio MCP server for the firefox-devtools-mcp
                          condition, e.g.
                          "npx @playwright/mcp@latest --browser firefox";
                          replaces the built-in firefox-devtools-mcp server.
                          It launches as given: the time zone reaches it
                          through its environment, but the other browser pins
                          and the download directory do not, and a file it
                          saves in your home the agent cannot read

Execution:
  --parallel              run conditions concurrently
  --parallel-tasks <n>    run up to n tasks concurrently within each condition
                          (each worker gets its own browser + pages server;
                          wall timings gain contention noise)
  --interleave            one queue for every condition instead of one per
                          condition: a block per (task, repeat), every
                          condition in the block in a seeded order, so the
                          arms of a comparison run side by side in time.
                          Workers: --parallel-tasks, times the conditions
                          under --parallel
  --no-tap                run each MCP server without mcp-tap.mjs, the
                          passthrough that logs per-call latency and sizes;
                          rows then carry no latency. The check for a browser
                          the surface did not start still runs by user agent
                          on every condition whose browser tag verified; only
                          an untagged condition's timing rules read the tap,
                          so under --no-tap its rows go unchecked
  --record-video          record each scripted attempt under the run's videos/;
                          requires --backend scripted --no-tap (free pilot)
  --help                  show this help

Before any paid work, each condition's MCP server is started once, must list
its tools, and loads a loopback page that records its browser's Firefox
version, user agent, Accept-Language, locale, time zone, viewport, colour
scheme and PDF viewer into meta.env; the run aborts if one cannot. Every
condition is pinned to locale ${BROWSER_PINS.locale}, time zone ${BROWSER_PINS.timeZone}, a ${BROWSER_PINS.viewport.width}x${BROWSER_PINS.viewport.height} viewport, the
${BROWSER_PINS.colorScheme} colour scheme and pdf.js on, and report.md flags whatever still differs.
Each attempt's browser saves downloads into downloads/ in the attempt's
directory (playwright-output/, beside its own files, under playwright-mcp).
The backend's sandbox lets the agent read that directory but not write it,
and the row records what the browser saved as downloads [{name, bytes, sha256}].

Results land in results/run-<timestamp>/ (gitignored): results.json,
report.md and report.html (shareable), transcripts/*.jsonl (full agent message streams,
one per attempt), tool-calls/*.jsonl (the tap's per-call log, one per
attempt), and states/*.json.gz (the server state each row was graded on, for
regrading; it holds the minted answers, so never share it). A row that never
called its own browser server is marked invalid and left out of the pass
rates and totals. An interrupt (Ctrl-C, SIGTERM) stops the agents, waits up to
${INTERRUPT_GRACE_MS / 1000}s for the rows of the attempts it stopped, and writes every row that
finished; a second interrupt exits at once.
Render transcripts with: node scripts/transcript.mjs [run-dir] [--task <id>] [--md]

Compare on OUTPUT TOKENS. Turns compare only between runs whose backend counts a
turn the same way, and a surface that chains several browser commands per call
does not count them the same way. Cost compares within one run and never between
two, because cache-creation volume swings between runs. Wall time is indicative
only under --parallel.`);
  process.exit(0);
}

const HEADED = args.includes('--headed');
const PARALLEL = args.includes('--parallel');
const INTERLEAVE = args.includes('--interleave');
// A switch can only be given, so a top-up of a --no-tap run is untapped by
// omission, and --no-tap on a top-up of a tapped run is refused.
const TAP =
  (rerunValue(
    'the tap',
    args.includes('--no-tap') ? 'off' : null,
    PRIOR_META && 'tap' in PRIOR_META ? (PRIOR_META.tap === false ? 'off' : 'on') : undefined
  ) ?? 'on') === 'on';
const RECORD_VIDEO = args.includes('--record-video');
if (RECORD_VIDEO && (BACKEND_NAMES.length !== 1 || BACKEND_NAMES[0] !== 'scripted' || TAP)) {
  usage('--record-video currently requires --backend scripted --no-tap');
}
// Tasks-within-a-condition concurrency; each worker gets an isolated env (own
// pages server and state dir), and every agent launches its own browser through
// its own MCP server.
const PARALLEL_TASKS = numberFlag(
  'parallel-tasks', 1, (n) => Number.isInteger(n) && n >= 1, 'a positive integer'
);
// Swap in any stdio MCP server (e.g. a different build) as the
// firefox-devtools-mcp condition.
// Naive whitespace split; quote-free commands only.
const MCP_COMMAND = rerunValue(
  '--mcp-command', flag('mcp-command', null), PRIOR_META ? (PRIOR_META.mcpCommand ?? null) : undefined
);
const CUSTOM_MCP = MCP_COMMAND ? MCP_COMMAND.trim().split(/\s+/) : null;

// Named conditions. 'playwright-mcp' spawns the vendored @playwright/mcp over
// stdio (registered under the same 'firefox' server name) driving Playwright's
// own Firefox build.
//
// --devtools-build <label>=<root|dep> (repeatable): label -> the checkout root,
// or null for the dependency. Labels become part of transcript names, which
// split on '--', so a label is one word of letters, digits, '.', '_' and single
// hyphens.
const DEVTOOLS = 'firefox-devtools-mcp';
const DEVTOOLS_BUILDS = new Map();
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--devtools-build') continue;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) usage('--devtools-build requires <label>=<root|dep>');
  const eq = value.indexOf('=');
  const label = eq > 0 ? value.slice(0, eq) : '';
  const where = eq > 0 ? value.slice(eq + 1) : '';
  if (!label || !where) usage(`--devtools-build takes <label>=<root|dep>, got "${value}"`);
  if (!/^[A-Za-z0-9._]+(?:-[A-Za-z0-9._]+)*$/.test(label)) {
    usage(`--devtools-build label "${label}" must be letters, digits, '.', '_' and single hyphens`);
  }
  if (DEVTOOLS_BUILDS.has(label)) usage(`--devtools-build label "${label}" is given twice`);
  const root = where === 'dep' ? null : resolve(where);
  try {
    devtoolsMcpEntry(root);
  } catch (error) {
    usage(`--devtools-build ${value}: ${error.message}`);
  }
  DEVTOOLS_BUILDS.set(label, root);
}
const GIVEN_BUILDS = DEVTOOLS_BUILDS.size;
// A top-up runs each build condition of the run it tops up from the root that
// run recorded (meta.surfaces, else meta.builds), so an A/B is topped up on its
// own builds, and it cannot top up one whose root no longer resolves.
if (PRIOR_META) {
  const shownRoot = (root) => (root === null ? 'dep' : root);
  const priorBuilds = listOf(PRIOR_META.conditions ?? '').filter((c) => c.startsWith(`${DEVTOOLS}@`));
  for (const label of DEVTOOLS_BUILDS.keys()) {
    if (!priorBuilds.includes(`${DEVTOOLS}@${label}`)) {
      usage(`--rerun-failed: ${RERUN_FAILED} ran no ${DEVTOOLS}@${label}, so --devtools-build ${label} cannot top it up`);
    }
  }
  for (const c of priorBuilds) {
    const label = c.slice(DEVTOOLS.length + 1);
    const surface = PRIOR_META.surfaces?.[c];
    const recorded =
      surface?.source === 'dependency' ? null : (surface?.path ?? findBuild(PRIOR_META, c)?.root);
    if (recorded === undefined) {
      usage(`--rerun-failed: ${RERUN_FAILED} recorded no root for ${c}, so its top-up cannot run that build`);
    }
    if (DEVTOOLS_BUILDS.has(label)) {
      if (DEVTOOLS_BUILDS.get(label) !== recorded) {
        refuseTopUp(`--devtools-build ${label}`, shownRoot(recorded), shownRoot(DEVTOOLS_BUILDS.get(label)));
      }
      continue;
    }
    try {
      devtoolsMcpEntry(recorded);
    } catch (error) {
      usage(
        `--rerun-failed: ${RERUN_FAILED} ran ${c} from ${shownRoot(recorded)}, which no longer resolves, so its ` +
          `top-up cannot run that build: ${error.message}`
      );
    }
    DEVTOOLS_BUILDS.set(label, recorded);
  }
}
const BUILD_CONDITIONS = [...DEVTOOLS_BUILDS.keys()].map((label) => `${DEVTOOLS}@${label}`);
const isDevtools = (c) => c === DEVTOOLS || c.startsWith(`${DEVTOOLS}@`);
// A firefox-devtools-mcp condition that runs a build of that server, not a
// --mcp-command one.
const builtInDevtools = (c) => isDevtools(c) && !(c === DEVTOOLS && CUSTOM_MCP);
// A build condition's root; undefined for plain firefox-devtools-mcp, which
// resolves FIREFOX_DEVTOOLS_MCP or the dependency.
const devtoolsRootFor = (c) => (c === DEVTOOLS ? undefined : DEVTOOLS_BUILDS.get(c.slice(DEVTOOLS.length + 1)));

const KNOWN_CONDITIONS = [DEVTOOLS, 'playwright-mcp', ...BUILD_CONDITIONS];
const CONDITIONS = listOf(
  rerunValue(
    '--conditions',
    flag('conditions', COMPARE === 'backends' && !GIVEN_BUILDS ? DEVTOOLS : null),
    PRIOR_META?.conditions,
    { same: (x, y) => sameSet(listOf(x), listOf(y)), impliedBy: flag('conditions', null) ? null : '--compare backends' }
  ) ?? (BUILD_CONDITIONS.length ? BUILD_CONDITIONS.join(',') : `${DEVTOOLS},playwright-mcp`)
);
for (const c of CONDITIONS) {
  if (!KNOWN_CONDITIONS.includes(c)) {
    usage(
      `unknown condition "${c}" (known: ${KNOWN_CONDITIONS.join(', ')}` +
        (c.startsWith(`${DEVTOOLS}@`) ? `; add it with --devtools-build ${c.slice(DEVTOOLS.length + 1)}=<root|dep>` : '') +
        ')'
    );
  }
}
if (new Set(CONDITIONS).size !== CONDITIONS.length) usage('--conditions names a condition twice');
// Plain firefox-devtools-mcp takes its build from FIREFOX_DEVTOOLS_MCP, which
// no flag records, so a top-up has to see the checkout that run did.
const priorPlain = PRIOR_META?.surfaces?.[DEVTOOLS];
if (CONDITIONS.includes(DEVTOOLS) && !CUSTOM_MCP && priorPlain && priorPlain.source !== '--mcp-command') {
  const then = priorPlain.source === 'FIREFOX_DEVTOOLS_MCP' ? resolve(priorPlain.path) : null;
  const now = process.env.FIREFOX_DEVTOOLS_MCP ? resolve(process.env.FIREFOX_DEVTOOLS_MCP) : null;
  if (then !== now) {
    const from = (root) => (root ? `the checkout FIREFOX_DEVTOOLS_MCP=${root}` : 'the dependency');
    usage(
      `--rerun-failed: ${RERUN_FAILED} ran ${DEVTOOLS} from ${from(then)}, and this top-up would run it from ${from(now)}. ` +
        `${then ? `Set FIREFOX_DEVTOOLS_MCP=${then}` : 'Unset FIREFOX_DEVTOOLS_MCP'} to top it up.`
    );
  }
}
// --devtools-firefox [<label>=]<path|playwright> (repeatable): the Firefox a
// built-in firefox-devtools-mcp condition launches, as its --firefox-path.
// Bare, it pins every such condition, and <label>= pins that --devtools-build
// label over it; with neither, EVAL_DEVTOOLS_FIREFOX pins every such
// condition, and unset each launches the installed Firefox. 'playwright' names
// the build playwright-mcp launches, so the two tools can run one browser. A
// top-up runs each condition on the binary the run it tops up recorded, the
// installed Firefox for a run that predates the flag, and refuses another.
const FIREFOX_BY_LABEL = new Map();
let FIREFOX_ALL = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--devtools-firefox') continue;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) usage('--devtools-firefox requires [<label>=]<path|playwright>');
  const m = /^([A-Za-z0-9._]+(?:-[A-Za-z0-9._]+)*)=(.+)$/s.exec(value);
  if (m && !DEVTOOLS_BUILDS.has(m[1])) usage(`--devtools-firefox ${value}: no --devtools-build names the label "${m[1]}"`);
  if (m ? FIREFOX_BY_LABEL.has(m[1]) : FIREFOX_ALL != null) {
    usage(`--devtools-firefox ${m ? `${m[1]}=<...>` : '<path|playwright>'} is given twice`);
  }
  if (m) FIREFOX_BY_LABEL.set(m[1], m[2]);
  else FIREFOX_ALL = value;
}
const FIREFOX_CONDITIONS = CONDITIONS.filter(builtInDevtools);
if ((FIREFOX_ALL != null || FIREFOX_BY_LABEL.size) && !FIREFOX_CONDITIONS.length) {
  usage(`--devtools-firefox pins a firefox-devtools-mcp build, and this run launches none${MCP_COMMAND ? ' (--mcp-command launches as given)' : ''}`);
}
for (const label of FIREFOX_BY_LABEL.keys()) {
  if (!CONDITIONS.includes(`${DEVTOOLS}@${label}`)) usage(`--devtools-firefox ${label}=: the run leaves ${DEVTOOLS}@${label} out of --conditions`);
}
// condition -> { spec, binary, source } for a pinned browser, or null for the
// installed Firefox.
const DEVTOOLS_FIREFOX = new Map();
for (const c of FIREFOX_CONDITIONS) {
  const label = c === DEVTOOLS ? null : c.slice(DEVTOOLS.length + 1);
  const named = (label && FIREFOX_BY_LABEL.get(label)) ?? FIREFOX_ALL;
  const envSpec = process.env[DEVTOOLS_FIREFOX_VAR] || null;
  let choice = named != null ? { spec: named, source: '--devtools-firefox' } : envSpec ? { spec: envSpec, source: DEVTOOLS_FIREFOX_VAR } : null;
  // The pin as it was given, for an error that names it.
  const givenAs = () =>
    choice.source === DEVTOOLS_FIREFOX_VAR
      ? `${DEVTOOLS_FIREFOX_VAR}=${choice.spec}`
      : `--devtools-firefox ${label && FIREFOX_BY_LABEL.has(label) ? `${label}=` : ''}${choice.spec}`;
  if (PRIOR_META) {
    const recorded = PRIOR_META.devtoolsFirefox?.[c]?.binary ?? null;
    if (!choice && recorded) choice = { spec: recorded, source: '--rerun-failed' };
    let given = null;
    try {
      given = choice ? devtoolsFirefox(choice.spec).binary : null;
    } catch (error) {
      usage(
        choice.source === '--rerun-failed'
          ? `--rerun-failed: ${RERUN_FAILED} ran ${c} on ${recorded}, which this top-up cannot run: ${error.message}`
          : `${givenAs()}: ${error.message}`
      );
    }
    if (given !== recorded) {
      const show = (binary) => binary ?? 'the installed Firefox';
      refuseTopUp(`${c} on`, show(recorded), show(given), choice?.source === DEVTOOLS_FIREFOX_VAR ? DEVTOOLS_FIREFOX_VAR : null);
    }
  }
  try {
    DEVTOOLS_FIREFOX.set(c, choice ? { ...devtoolsFirefox(choice.spec), source: choice.source } : null);
  } catch (error) {
    usage(`${givenAs()}: ${error.message}`);
  }
}
for (const name of BACKEND_NAMES) {
  const unsupported = CONDITIONS.filter((c) => BACKENDS[name].supportsCondition?.(c) === false);
  if (unsupported.length) {
    usage(`backend ${name} cannot run ${unsupported.join(', ')}; pick conditions with --conditions`);
  }
}
if (BACKEND_NAMES.length > 1 && CONDITIONS.length > 1) {
  console.log(
    `warning: this run varies BOTH axes (${BACKEND_NAMES.length} harnesses x ` +
      `${CONDITIONS.length} tool surfaces). Differences cannot be attributed to ` +
      `either. Use --compare surfaces or --compare backends to pin one.\n`
  );
}
if (PRIOR_META) {
  const pins = [...DEVTOOLS_FIREFOX].filter(([, pin]) => pin).map(([c, pin]) => `${c} to ${pin.binary}`);
  const seed = SEED_ARG ?? (RERUN_SEED === undefined ? "the top-up's own stamp" : (RERUN_SEED ?? 'none'));
  console.log(
    `--rerun-failed: running as ${RERUN_FAILED} ran: ${BACKEND_NAMES.map((n) => `${n} ${modelFor(n)}`).join(', ')}, ` +
      `effort ${EFFORT}, ${CONDITIONS.join(', ')}${MCP_COMMAND ? ` (--mcp-command ${MCP_COMMAND})` : ''}, ` +
      (pins.length ? `Firefox pinned for ${pins.join(' and ')}, ` : '') +
      `serving ${SERVING}, seed ${seed}` +
      (Object.keys(RUN_MODES).length ? `, --mode ${Object.entries(RUN_MODES).map(([k, v]) => `${k}=${v}`).join(' ')}` : '') +
      (TAP ? '' : ', --no-tap') +
      (MAX_WALL_OVERRIDE ? `, --max-wall ${MAX_WALL_OVERRIDE}` : '') +
      (MAX_OUTPUT ? `, --max-output ${MAX_OUTPUT}` : '') +
      '\n'
  );
}

// A condition's rows carry this label; with several backends it names both.
const labelFor = (backendName, condition) =>
  BACKEND_NAMES.length > 1 ? `${backendName}/${condition}` : condition;

const requireHere = createRequire(import.meta.url);
const PLAYWRIGHT_MCP_CLI = join(
  dirname(requireHere.resolve('@playwright/mcp/package.json')),
  'cli.js'
);

// Which playwright-mcp a run measured, for its meta. Its cli.js only hands the
// command to playwright-core's two bundles, which hold every tool and require
// no other file of the package, so the bundles the package resolves are hashed
// too.
function playwrightMcpInfo() {
  const mcpRequire = createRequire(PLAYWRIGHT_MCP_CLI);
  let core = null;
  try {
    core = {
      version: JSON.parse(readFileSync(mcpRequire.resolve('playwright-core/package.json'), 'utf8')).version ?? null,
      coreBundle: sha256File(mcpRequire.resolve('playwright-core/lib/coreBundle')),
      utilsBundle: sha256File(mcpRequire.resolve('playwright-core/lib/utilsBundle')),
    };
  } catch {}
  return { source: 'dependency', version: packageVersion('@playwright/mcp'), sha256: sha256File(PLAYWRIGHT_MCP_CLI), core };
}

// Every condition gets a shell, so the only difference between conditions
// is how the browser is driven rather than whether a shell exists at all. It
// claims nothing about what the shell lacks: its PATH is the operator's behind
// a stub directory, and a stub cannot cover every way to start a browser.
const SHELL_NOTE = `You also have a shell (Bash) for anything else you find useful.
The MCP tools are how you drive the page.`;

// Identical for every condition: the comparison of interest is
// firefox-devtools-mcp vs playwright-mcp, so the prompt must not differ by so
// much as a word between them. It carries no strategy advice.
const MCP_INTRO = `You control a web browser via the connected "firefox" MCP tools.
${SHELL_NOTE}`;
// The name both backends register every condition's browser server under. A
// row's calls to it are its surface calls; a call to any other MCP server (a
// codex home that leaked the operator's servers, say) is foreign.
const SURFACE_SERVER = 'firefox';

function taskPrompt(task) {
  return `${MCP_INTRO}\n\nTask: ${task.ask}\nAnswer concisely with the requested information.`;
}

// Playwright drives its own Firefox build; download it (no-op when present)
// before any agent loop starts so install time never counts against a task.
function ensurePlaywrightFirefox() {
  return new Promise((resolve, reject) => {
    console.log('(checking Playwright Firefox is installed)');
    const child = spawn(
      process.execPath,
      [join(dirname(requireHere.resolve('playwright')), 'cli.js'), 'install', 'firefox'],
      { stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`playwright install firefox exited ${code}`))
    );
  });
}

// The time zone is the one pin a browser takes from its environment. Both
// backends start the MCP server with the agent's environment (codex forwards
// it by name), so the agent's shell runs in the same zone as its browser.
const PINNED_ENV = { TZ: BROWSER_PINS.timeZone };
// The scripted backend calls no API, so it gets the base set an MCP server gets.
const agentEnvFor = (backend) => ({ ...agentEnv(backend === 'scripted' ? null : backend), ...PINNED_ENV });
// The PATH an agent's shell gets. Only the shell's: a server that looks Firefox
// up on PATH (firefox-devtools-mcp on Linux) must still find the real one.
const shellPathFor = (backend) => (backend === 'scripted' ? undefined : shimmedPath(agentEnvFor(backend).PATH));

const VIEWPORT = `${BROWSER_PINS.viewport.width}x${BROWSER_PINS.viewport.height}`;
// A headed window takes its cell of the grid instead.
const DEVTOOLS_WINDOW = devtoolsWindowSize(BROWSER_PINS.viewport);
// playwright-mcp takes Firefox prefs and Playwright's own emulation only from a
// config file. Playwright emulates a colour scheme whatever the pref says.
const PLAYWRIGHT_CONFIG = {
  browser: {
    launchOptions: { firefoxUserPrefs: PINNED_PREFS },
    contextOptions: { colorScheme: BROWSER_PINS.colorScheme },
  },
};
// `userAgent`, when set, is the attempt's tagged user agent (see browserTag),
// so each attempt writes its own file into `dir`.
function playwrightConfigFile(dir, userAgent = null) {
  const path = join(dir, 'playwright-config.json');
  const config = userAgent
    ? { browser: { ...PLAYWRIGHT_CONFIG.browser, contextOptions: { ...PLAYWRIGHT_CONFIG.browser.contextOptions, userAgent } } }
    : PLAYWRIGHT_CONFIG;
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

// Every attempt's browser sends a user agent carrying a token of its own: the
// preflight's user agent plus a space and eight hex digits. A page request
// without the attempt's token came from some other browser, such as one the
// agent's shell started, which the server would otherwise count as the
// surface's (see foreignBrowser). Null when the preflight could not measure
// the condition's user agent, or its tagged launch did not send the token.
const TAG_MECHANISM = {
  [DEVTOOLS]: 'pref general.useragent.override',
  'playwright-mcp': 'contextOptions.userAgent',
};
const tagMechanismFor = (condition) =>
  condition === 'playwright-mcp' ? TAG_MECHANISM['playwright-mcp'] : builtInDevtools(condition) ? TAG_MECHANISM[DEVTOOLS] : null;
const PREFLIGHT_ENV = {};
const TAGGABLE = new Set();
function browserTag(condition) {
  const base = PREFLIGHT_ENV[condition]?.userAgent;
  if (!base || !TAGGABLE.has(condition)) return null;
  const token = randomBytes(4).toString('hex');
  return { token, userAgent: `${base} ${token}` };
}

// A headed Firefox is still writing its profile for a moment after its MCP
// server closes, and recreated a profile removed then. Every headed profile
// therefore lives under one directory that is removed when the run exits.
let gridProfiles = null;
function gridProfileDir() {
  gridProfiles ??= makeTempDir(TEMP_PREFIX.profiles);
  return mkdtempSync(join(gridProfiles, 'p-'));
}
// Before that removal, wait up to `ms` for every browser launched on one of
// those profiles to exit; each names its profile on its command line.
async function awaitGridBrowsers(ms = 15000) {
  if (!gridProfiles) return;
  for (const stop = Date.now() + ms; Date.now() < stop; ) {
    if (spawnSync('pgrep', ['-f', gridProfiles]).status !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// `downloadsDir` is where the browser saves downloads; `privateDir` a directory
// of the attempt's that its agent is never pointed at, for the server's own
// files; `profileDir` is a profile seeded with a headed window's grid cell;
// `userAgent` the attempt's tagged user agent; `tapLog`, when set, runs the
// server through mcp-tap.mjs logging there.
function mcpStdioFor(condition, { downloadsDir, privateDir, profileDir = null, userAgent = null, tapLog = null }) {
  const spec = serverSpecFor(condition, { downloadsDir, privateDir, profileDir, userAgent });
  return spec && tapLog ? tapSpec(spec, tapLog) : spec;
}

// firefox-devtools-mcp's saveTo root is ~/.firefox-devtools-mcp, so it runs
// with a HOME of the attempt's own; stored runs found that directory shared by
// every attempt and holding files from earlier days. Its WebDriver's driver
// cache stays the operator's, since an empty one downloads geckodriver, and
// DEVTOOLS_SERVER_ENV keeps a .env in its cwd from reconfiguring it.
const devtoolsHome = (privateDir) => join(privateDir, 'home');
function devtoolsServerEnv(privateDir) {
  const home = devtoolsHome(privateDir);
  mkdirSync(home, { recursive: true });
  const realHome = process.env.HOME || homedir();
  return { HOME: home, SE_CACHE_PATH: process.env.SE_CACHE_PATH || join(realHome, '.cache', 'selenium'), ...DEVTOOLS_SERVER_ENV };
}

// Where a condition's server saves files outside the attempt directory and
// names them in its replies, for the backend to let the agent read and not
// write: firefox-devtools-mcp saves under <its HOME>/.firefox-devtools-mcp,
// saveTo:true in its output/. An absolute saveTo lands anywhere inside that
// root on 0.9.15 and only inside output/ from 0.10.3, which also sends a
// set_download_behavior 'allowed' download to output/downloads; the root
// covers both builds. playwright-mcp saves inside the attempt directory, and
// a --mcp-command server keeps the operator's HOME, which the agent may not
// read.
const serverOutputDirsFor = (condition, privateDir) =>
  builtInDevtools(condition) ? [join(devtoolsHome(privateDir), '.firefox-devtools-mcp')] : [];
// The downloads a condition's own tool can send outside the attempt's
// downloads directory, by the label the row names them under
// (agent-env.mjs attemptDownloads).
const serverDownloadDirsFor = (condition, privateDir) =>
  builtInDevtools(condition)
    ? { '~/.firefox-devtools-mcp/output/downloads': join(devtoolsHome(privateDir), '.firefox-devtools-mcp', 'output', 'downloads') }
    : {};

function serverSpecFor(condition, { downloadsDir, privateDir, profileDir, userAgent }) {
  if (condition === 'playwright-mcp') {
    return {
      command: process.execPath,
      args: [
        PLAYWRIGHT_MCP_CLI,
        '--browser',
        'firefox',
        '--isolated',
        ...(HEADED ? [] : ['--headless']),
        '--viewport-size',
        VIEWPORT,
        '--config',
        playwrightConfigFile(privateDir, userAgent),
        // Its downloads land in its output directory, with no option to put
        // them elsewhere, beside its own snapshot and log files, which its
        // replies link to. Unset, that is .playwright-mcp/ in the cwd.
        '--output-dir',
        downloadsDir,
      ],
    };
  }
  if (isDevtools(condition)) {
    if (condition === DEVTOOLS && CUSTOM_MCP) return { command: CUSTOM_MCP[0], args: CUSTOM_MCP.slice(1) };
    const prefs = {
      ...PINNED_PREFS,
      ...downloadPrefs(downloadsDir),
      ...(userAgent ? { 'general.useragent.override': userAgent } : {}),
    };
    // --firefox-path, and the policy a pinned Playwright build needs to keep
    // these prefs, which lives with the server's other private files.
    const firefox = devtoolsFirefoxLaunch(DEVTOOLS_FIREFOX.get(condition) ?? null, prefs, privateDir);
    return {
      command: process.execPath,
      args: [
        // One resolver, shared with verify: a --devtools-build root, else
        // FIREFOX_DEVTOOLS_MCP for a local checkout, otherwise the
        // @mozilla/firefox-devtools-mcp dependency.
        devtoolsMcpEntry(devtoolsRootFor(condition)),
        '--enable-script',
        ...(HEADED ? [] : ['--headless', '--viewport', DEVTOOLS_WINDOW]),
        ...(profileDir ? ['--profile-path', profileDir] : []),
        ...firefox.args,
        ...prefArgs(prefs),
      ],
      env: { ...devtoolsServerEnv(privateDir), ...firefox.env },
    };
  }
  return null;
}

// The Firefox build each condition's server launches, read at every attempt so
// an auto-update between two attempts shows on the rows: firefox-devtools-mcp
// starts the binary --devtools-firefox pins (DEVTOOLS_FIREFOX), else the
// installed Firefox, and playwright-mcp the build `playwright install` put in
// its cache.
let playwrightBinary;
function browserBuildFor(condition) {
  if (condition === 'playwright-mcp') {
    playwrightBinary ??= playwrightFirefox();
    return firefoxBuild(playwrightBinary, 'playwright');
  }
  if (builtInDevtools(condition)) {
    const firefox = DEVTOOLS_FIREFOX.get(condition) ?? null;
    return firefoxBuild(firefox?.binary ?? null, devtoolsFirefoxPolicy(firefox, PINNED_PREFS));
  }
  return null;
}

// What the browser reports about itself, returned URI-encoded between markers
// because each server wraps a returned string in its own quoting.
const ENV_PROBE = `() => {
  const dt = Intl.DateTimeFormat().resolvedOptions();
  return 'ZOOENV' + encodeURIComponent(JSON.stringify({
    userAgent: navigator.userAgent,
    languages: navigator.languages,
    locale: dt.locale,
    timeZone: dt.timeZone,
    viewport: innerWidth + 'x' + innerHeight,
    screen: screen.width + 'x' + screen.height,
    devicePixelRatio,
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    pdfViewerEnabled: navigator.pdfViewerEnabled,
  })) + 'ZOOENV';
}`;
const ENV_TOOLS = [
  { navigate: 'navigate_page', evaluate: 'evaluate_script' },
  { navigate: 'browser_navigate', evaluate: 'browser_evaluate' },
];

// A loopback page for the preflight to load, which keeps the request headers a
// page cannot read about itself.
async function startProbeServer() {
  const seen = new Map();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://probe').pathname;
    if (!seen.has(path)) seen.set(path, req.headers);
    res.writeHead(path === '/favicon.ico' ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>preflight</title></head><body></body></html>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    headersAt: (path) => seen.get(path) ?? {},
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// A --mcp-command server whose tools go by other names is recorded unmeasured
// rather than failed: listing its tools already proved it starts.
async function measureEnv(server, tools, probe, path) {
  const names = new Set(tools.map((t) => t.name));
  const pair = ENV_TOOLS.find((p) => names.has(p.navigate) && names.has(p.evaluate));
  if (!pair) return { unmeasured: 'the server has no navigate/evaluate tool pair the harness knows' };
  const call = async (name, toolArgs) => {
    const r = await server.call(name, toolArgs);
    const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    return text;
  };
  await call(pair.navigate, { url: probe.url + path });
  const text = await call(pair.evaluate, { function: ENV_PROBE });
  const encoded = text.match(/ZOOENV([A-Za-z0-9\-_.!~*'()%]*)ZOOENV/)?.[1];
  if (encoded == null) throw new Error(`${pair.evaluate} returned no environment: ${text.slice(0, 300)}`);
  const page = JSON.parse(decodeURIComponent(encoded));
  return {
    firefox: page.userAgent.match(/Firefox\/([\d.]+)/)?.[1] ?? null,
    acceptLanguage: probe.headersAt(path)['accept-language'] ?? null,
    ...page,
  };
}

// One preflight server of `condition`, in a fresh directory, launched as an
// attempt's is. `userAgent` tags its browser.
async function preflightServer(condition, userAgent = null) {
  const dir = makeTempDir(TEMP_PREFIX.attempt);
  const privateDir = makeTempDir(TEMP_PREFIX.home);
  const downloadsDir = join(dir, serverDirName(condition));
  mkdirSync(downloadsDir);
  const profileDir =
    GRID && POSITIONABLE.includes(condition)
      ? GRID.seed(gridProfileDir(), slotFor(BACKEND_NAMES[0], condition, 0))
      : null;
  const tapLog = TAP ? join(privateDir, 'tap.jsonl') : null;
  const spec = mcpStdioFor(condition, { downloadsDir, privateDir, profileDir, userAgent, tapLog });
  const cleanup = () => {
    removeTempDir(dir);
    removeTempDir(privateDir);
  };
  try {
    const server = await startMcpServer({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      baseEnv: agentEnvFor(null),
      cwd: dir,
    });
    return { server, tapLog, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Whether a browser launched with a tagged user agent sends it: a launch that
// ignored the pref or the config would make every page request of every
// attempt look foreign.
async function verifyTag(condition, probe, tools) {
  const mechanism = tagMechanismFor(condition);
  const base = PREFLIGHT_ENV[condition]?.userAgent;
  const pair = ENV_TOOLS.find((p) => tools.names.includes(p.navigate));
  if (!mechanism || !base || !pair) return null;
  const token = randomBytes(4).toString('hex');
  const path = `/${condition}/tag-${token}`;
  let launched;
  try {
    launched = await preflightServer(condition, `${base} ${token}`);
    await launched.server.call(pair.navigate, { url: probe.url + path });
  } catch (error) {
    return { mechanism, verified: false, why: String(error?.message ?? error).slice(0, 200) };
  } finally {
    await launched?.server.close();
    launched?.cleanup();
  }
  const sent = probe.headersAt(path)['user-agent'] ?? null;
  const verified = sent === `${base} ${token}`;
  if (verified) TAGGABLE.add(condition);
  return { mechanism, verified, ...(verified ? {} : { sent }) };
}

// Free checks before any paid work. A crashing --mcp-command, or a server that
// needs a variable the environment allowlist drops, otherwise leaves every
// agent with only Bash, and the run grades that as the surface. The server gets
// the agents' environment, an empty cwd and the flags an attempt gets, and its
// browser loads one loopback page, so the environment it reports is the one
// every attempt of the condition runs in. The server runs through the tap as an
// attempt's does, so a tap that breaks a server fails here too. Returns that
// environment, and what identifies each condition's tool list, by condition.
async function preflight() {
  const env = {};
  const tools = {};
  const probe = await startProbeServer();
  try {
    for (const condition of CONDITIONS) {
      let launched;
      try {
        launched = await preflightServer(condition);
        const { server, tapLog } = launched;
        const listed = (await server.listTools()).tools;
        if (!listed?.length) throw new Error('the server listed no tools');
        // The server's instructions reach the model as its tool definitions
        // do, so an arm pays for both (mcp-tap.mjs instructionsInfo).
        tools[condition] = { ...toolsListInfo(listed), instructions: instructionsInfo(server.instructions()) };
        env[condition] = await measureEnv(server, listed, probe, `/${condition}`);
        const e = env[condition];
        // The tap writes each record before it hands the reply on, so the log
        // already holds the tools/list reply the client received.
        if (tapLog) {
          const wire = readTapLog(tapLog).find((r) => r.type === 'tools/list');
          if (!wire) throw new Error('mcp-tap.mjs logged no tools/list reply');
          if (JSON.stringify(toolsListInfo(wire.tools).names) !== JSON.stringify(tools[condition].names)) {
            throw new Error('the tools/list reply mcp-tap.mjs logged names other tools than the client received');
          }
          const init = readTapLog(tapLog).find((r) => r.type === 'initialize');
          if (init?.instructions?.sha256 !== tools[condition].instructions?.sha256) {
            throw new Error('the initialize reply mcp-tap.mjs logged carries other instructions than the client received');
          }
        }
        e.build = browserBuildFor(condition);
        const told = tools[condition].instructions;
        const pin = DEVTOOLS_FIREFOX.get(condition);
        console.log(
          `(preflight: ${condition} lists ${listed.length} tools, ${tools[condition].schemaChars} schema chars, ` +
            `${told ? `${told.chars} chars of server instructions` : 'no server instructions'}; ` +
            (e.unmeasured
              ? `environment unmeasured: ${e.unmeasured})`
              : `Firefox ${e.firefox}${pin ? ` (${pin.binary}, pinned by ${pin.source})` : ''}, ${e.locale}, ${e.timeZone}, ` +
                `${e.viewport}, ${e.colorScheme}, pdf.js ${e.pdfViewerEnabled == null ? '?' : e.pdfViewerEnabled ? 'on' : 'off'})`)
        );
        const { unpinned } = devtoolsFirefoxPolicy(pin ?? null, PINNED_PREFS);
        if (unpinned.length) {
          console.log(
            `(preflight: ${condition}'s Firefox keeps its playwright.cfg values of ${unpinned.join(', ')} over the pinned ones, ` +
              'and no policy can set them back, so report.md flags whatever that changes)'
          );
        }
      } catch (error) {
        throw new Error(
          `preflight: the ${condition} MCP server did not start, list its tools and ` +
            `load a page, so no agent ran:\n${error.message}`
        );
      } finally {
        await launched?.server.close();
        launched?.cleanup();
      }
      // e.build is read from the binary the server was told, or expected, to
      // launch, so the browser's own user agent has to name its major release: a
      // server that ignored --firefox-path, or found another Firefox, would
      // otherwise run under this one's name on every row.
      const e = env[condition];
      const major = (v) => String(v).split('.')[0];
      if (!e.unmeasured && e.firefox && e.build?.version && major(e.firefox) !== major(e.build.version)) {
        const pin = DEVTOOLS_FIREFOX.get(condition);
        throw new Error(
          `preflight: ${condition}'s browser reports Firefox ${e.firefox}, but ${e.build.binary}, the Firefox its server ` +
            `was ${pin ? `told to launch (${pin.source} ${pin.spec})` : 'expected to launch'}, is ${e.build.version}: ` +
            'the server launched another Firefox, and its rows would record the wrong build, so no agent ran'
        );
      }
      if (!env[condition].unmeasured) {
        PREFLIGHT_ENV[condition] = env[condition];
        env[condition].tag = await verifyTag(condition, probe, tools[condition]);
        if (env[condition].tag && !env[condition].tag.verified) {
          console.log(
            `(preflight: ${condition}'s browser did not send its tagged user agent ` +
              `(${env[condition].tag.why ?? `sent ${JSON.stringify(env[condition].tag.sent)}`}), so its rows ` +
              (TAP
                ? 'tell a foreign browser from their own by timing alone)'
                : 'go unchecked for a foreign browser: the timing rules read the tap log, which --no-tap drops)')
          );
        }
      }
    }
  } finally {
    await probe.close();
  }
  // The first codex home of a process reads the model catalog, which can fail,
  // so a codex extractor's is built here too rather than after the first paid
  // agent run.
  if (BACKENDS.codex || (EXTRACTOR_USED && extractorInfo().extractor === 'codex')) {
    const { isolatedCodexHome } = BACKENDS.codex ?? (await import('./backends/codex.mjs'));
    const home = await isolatedCodexHome(agentEnv('codex'));
    const hasLogin = home.hasLogin;
    home.close();
    if (!hasLogin) {
      throw new Error(
        'preflight: codex has no login to run with: no auth.json in CODEX_HOME ' +
          '(~/.codex) and no CODEX_API_KEY or OPENAI_API_KEY'
      );
    }
  }
  if (BACKENDS.codex) {
    try {
      await BACKENDS.codex.preflightIsolation(agentEnvFor('codex'), shellPathFor('codex'));
    } catch (error) {
      throw new Error(`preflight: ${error.message}, so no agent ran`);
    }
  }
  return { env, tools };
}

// Every running attempt's stop function, so an interrupt can end the agents.
const ACTIVE_STOPS = new Set();

// What a row records about its tool calls. The message stream says which
// server each call went to and what the results meant; the tap's log, when the
// server ran through one, supplies the tools map, because only the wire has
// latency, and the surface call count, because only the wire shows which calls
// reached the server: the Claude CLI answers a call to a tool the server lacks
// itself. A row that never called its own browser server measured nothing
// about the surface, whatever its grade, so it is marked invalid. Returns the
// row's fields, and the surface's errors for blameToolErrors once the graded
// values are known.
function callTelemetry(recorder, tapLog) {
  const s = recorder.summary();
  const records = tapLog ? readTapLog(tapLog) : null;
  const tapped = records ? tapSurfaceCalls(records) : null;
  const surfaceCalls = tapped ? tapped.length : s.surface_calls;
  const exited = records ? serverExit(records) : null;
  return {
    telemetry: {
      surface_calls: surfaceCalls,
      ...(exited ? { server_exit: exited } : {}),
      foreign_tools: s.foreign_tools,
      ...(s.foreign_tools ? { foreign_servers: s.foreign_servers } : {}),
      ...(surfaceCalls === 0 ? { invalid: 'no-surface-calls' } : {}),
      tools: tapped ? tapToolStats(tapped) : s.tools,
      // A call the agent saw start but the tap never saw answered (an aborted
      // attempt), or the reverse, which would mean the two disagree.
      ...(tapped && tapped.length !== s.surface_calls
        ? { tap_mismatch: { tap: tapped.length, stream: s.surface_calls } }
        : {}),
      snapshot: s.snapshot,
      friction: s.friction,
    },
    toolErrors: s.tool_errors,
    shellWindows: s.shell_windows,
  };
}

// The `filename` arguments of a message's MCP tool calls, from either backend's
// stream, resolved as playwright-mcp resolves them: against the agent's cwd.
// It writes a snapshot, screenshot, log or response body there, which is no
// download even when the name points into its output directory. A string
// saveTo is firefox-devtools-mcp's, resolved against the same directory, its
// server's cwd. A saveTo naming a directory, or true, writes a file of the
// server's naming, which its reply gives ("saved to: <path>"), so the paths
// the replies give count too.
const SAVED_TO = /\bsaved to:?\s+(\S+)/gi;
const mcpInputsOf = (message) =>
  message?.type === 'assistant' && Array.isArray(message.message?.content)
    ? message.message.content.filter((b) => b?.type === 'tool_use' && /^mcp__/.test(b.name ?? '')).map((b) => b.input)
    : message?.item?.type === 'mcp_tool_call'
      ? [message.item.arguments]
      : [];
const repliesOf = (message) =>
  message?.type === 'user' && Array.isArray(message.message?.content)
    ? message.message.content.filter((b) => b?.type === 'tool_result').map((b) => contentText(b.content))
    : message?.type === 'item.completed' && message.item?.type === 'mcp_tool_call'
      ? [contentText(message.item.result?.content)]
      : [];
function filesNamedIn(message, cwd) {
  return [
    ...mcpInputsOf(message).flatMap((i) => [i?.filename, i?.saveTo]),
    ...repliesOf(message).flatMap((text) => [...text.matchAll(SAVED_TO)].map((m) => m[1])),
  ]
    .filter((f) => typeof f === 'string' && f)
    .map((f) => resolve(cwd, f));
}
// The folder firefox-devtools-mcp 0.10.3's set_download_behavior 'allowed'
// sent later downloads to, as its reply names it, resolved: its own
// output/downloads, or the downloadFolder the call gave.
const DOWNLOAD_FOLDER = /Download behavior set to 'allowed' \(folder='([^'\n]+)'\)/g;
function downloadFoldersIn(message, cwd) {
  return repliesOf(message).flatMap((text) => [...text.matchAll(DOWNLOAD_FOLDER)].map((m) => resolve(cwd, m[1])));
}

async function runTask(backendName, condition, label, task, ctx, rep = 1, attempt = 0) {
  const backend = BACKENDS[backendName];
  // A fresh working directory per attempt: stored runs showed two parallel
  // agents writing the same file in one shared dir, and repeats reusing the
  // scripts an earlier task left there. Downloads land inside it, where the
  // agent's shell can read them and cannot write (agent-env.mjs serverDirs).
  const attemptDir = makeTempDir(TEMP_PREFIX.attempt);
  const downloadsDir = join(attemptDir, serverDirName(condition));
  mkdirSync(downloadsDir);
  // The attempt's files that are not the agent's: the server's HOME and config.
  const privateDir = makeTempDir(TEMP_PREFIX.home);
  const transcript = transcriptName({
    label,
    task: task.id,
    rep: REPEAT > 1 ? rep : null,
    attempt: attempt + 1,
  });
  // The tap logs into the run directory rather than the attempt's, which is
  // the agent's cwd, so tapped and untapped agents see the same directory.
  const tapLog = ctx.toolCallsDir ? join(ctx.toolCallsDir, transcript) : null;
  // A headed window's profile is seeded per attempt, outside the agent's cwd:
  // a profile kept per worker would hand one task's cookies and storage to the
  // next.
  const profileRoot = ctx.gridSlot != null ? gridProfileDir() : null;
  const tag = browserTag(condition);
  const browser = { ...(browserBuildFor(condition) ?? {}), tag: tag?.token ?? null };
  const mcpStdio = mcpStdioFor(condition, {
    downloadsDir,
    privateDir,
    profileDir: profileRoot ? GRID.seed(profileRoot, ctx.gridSlot) : null,
    userAgent: tag?.userAgent ?? null,
    tapLog,
  });
  const rollout = ctx.rolloutsDir ? join(ctx.rolloutsDir, transcript) : null;
  const spec = {
    prompt: taskPrompt(task),
    model: modelFor(backendName),
    effort: EFFORT === 'default' ? null : EFFORT,
    condition,
    cwd: attemptDir,
    mcpStdio,
    env: agentEnvFor(backendName),
    shellPath: shellPathFor(backendName),
    serverOutputDirs: serverOutputDirsFor(condition, privateDir),
    // Where a backend that keeps its own session record (codex) copies it.
    rolloutPath: rollout,
    // For the scripted backend, which runs the task's driver against this pages
    // server; an agent backend reads only the prompt.
    task,
    pages: ctx.pages,
    videoPath: ctx.videosDir ? join(ctx.videosDir, transcript.replace(/\.jsonl$/, '.webm')) : null,
  };
  // Stream the raw agent transcript (thinking, tool calls, results) to disk
  // as it happens rather than buffering.
  let transcriptStream = null;
  if (ctx.transcriptsDir) {
    transcriptStream = createWriteStream(join(ctx.transcriptsDir, transcript));
    transcriptStream.on('error', (error) =>
      console.error(`transcript write failed: ${error.message}`)
    );
  }
  // Which graded values actually reached the agent. Runs whether or not
  // transcripts are being written, because the answer belongs in the result row.
  const reach = createReachRecorder();
  const calls = createCallRecorder(SURFACE_SERVER);
  const namedFiles = new Set();
  const downloadFolders = new Set();
  spec.onMessage = (message) => {
    reach.observe(message);
    calls.observe(message, Date.now());
    for (const path of filesNamedIn(message, attemptDir)) namedFiles.add(path);
    for (const dir of downloadFoldersIn(message, attemptDir)) downloadFolders.add(dir);
    if (transcriptStream) transcriptStream.write(JSON.stringify(message) + '\n');
  };
  // Runaway guards. There is deliberately no turn limit: a "turn" means
  // different things per backend (codex counts its model requests from the
  // rollout, once the run has ended), so turns are neither a fair metric nor a
  // usable safety net. Wall time and output tokens are.
  const abortController = new AbortController();
  spec.abortController = abortController;
  let spent = 0;
  let limitHit = null;
  const stopFor = (reason) => {
    if (limitHit) return;
    limitHit = reason;
    abortController.abort(reason);
  };
  ACTIVE_STOPS.add(stopFor);
  const capS = wallCapFor(task);
  const wallTimer = capS
    ? setTimeout(() => stopFor(`wall limit ${capS}s (tier ${task.tier ?? DEFAULT_TIER})`), capS * 1000)
    : null;
  // The backend counts its own output (the message shapes differ). One that
  // counts only when a run ends is held to the cap after it, below.
  spec.onOutputTokens = (n) => {
    spent = n;
    if (MAX_OUTPUT && spent > MAX_OUTPUT) {
      stopFor(`output-token limit ${MAX_OUTPUT} (spent ${spent})`);
    }
  };

  const startedAt = new Date();
  const wallStart = startedAt.getTime();
  let r;
  let wallEnd;
  let failed = null;
  let downloads = [];
  let telemetry = null;
  let toolErrors = [];
  let shellWindows = [];
  let provenance = null;
  let foreign = null;
  try {
    r = await backend.run(spec);
  } catch (error) {
    // A discarded attempt still cost real tokens: the backend hangs what it
    // could measure on the throw as `spend`, so the retry loop records it
    // instead of losing it from every total.
    const spend = error?.spend ?? { unknown: true };
    failed = limitHit
      ? new Error(`stopped by harness ${limitHit}`)
      : error instanceof Error
        ? error
        : new Error(String(error));
    if (limitHit) failed.harnessStop = true;
    failed.spend = spend;
    failed.transcript = transcript;
    throw failed;
  } finally {
    wallEnd = Date.now();
    clearTimeout(wallTimer);
    ACTIVE_STOPS.delete(stopFor);
    transcriptStream?.end();
    await ensureTapExit(tapLog);
    // Never allowed to cost the attempt its row: telemetry is not the grade.
    try {
      ({ telemetry, toolErrors, shellWindows } = callTelemetry(calls, tapLog));
    } catch (error) {
      telemetry = { telemetry_error: String(error?.message ?? error) };
    }
    // Hashing a large download stays out of the attempt's wall time. A folder
    // the agent sent downloads to is read too, by its path in the attempt
    // directory or under the server's HOME; a file the agent's shell wrote
    // into one inside the attempt directory reads as a download.
    const elsewhere = serverDownloadDirsFor(condition, privateDir);
    for (const dir of downloadFolders) {
      if (dir === downloadsDir || Object.values(elsewhere).includes(dir)) continue;
      const label = dir.startsWith(attemptDir + sep)
        ? relative(attemptDir, dir)
        : dir.startsWith(devtoolsHome(privateDir) + sep)
          ? `~/${relative(devtoolsHome(privateDir), dir)}`
          : dir;
      elsewhere[label] = dir;
    }
    downloads = await attemptDownloads(downloadsDir, namedFiles, elsewhere);
    provenance = {
      prompt: spec.prompt,
      browser,
      ...(rollout && existsSync(rollout) ? { rollout: `rollouts/${transcript}` } : {}),
    };
    try {
      foreign = foreignBrowser(ctx.pages?.state?.ledger, { windows: tapWindows(tapLog), shell: shellWindows, token: tag?.token });
    } catch (error) {
      foreign = { error: String(error?.message ?? error) };
    }
    if (failed) Object.assign(failed, { downloads, telemetry, startedAt, provenance, foreign });
    // What the agent's shell left running outlives the agent: a sandboxed
    // Firefox the probes started crashed and left its crash reporter up for half
    // an hour. The directory names are random, so this matches the attempt's own.
    for (const dir of [attemptDir, privateDir]) spawnSync('pkill', ['-f', dir]);
    removeTempDir(attemptDir);
    removeTempDir(privateDir);
    if (profileRoot) {
      // Whatever this misses goes with the parent directory at exit.
      try {
        rmSync(profileRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch {}
    }
  }
  const wallMs = wallEnd - wallStart;
  const discard = (message, extra = {}) =>
    Object.assign(new Error(message), {
      spend: {
        input_tokens: r.input_tokens,
        cache_creation: r.cache_creation,
        cache_read: r.cache_read,
        output_tokens: r.output_tokens,
        cost_usd: r.cost_usd,
      },
      transcript,
      downloads,
      telemetry,
      startedAt,
      provenance,
      foreign,
      ...extra,
    });
  // A run that finished past the cap fails like one stopped at it. Codex
  // reports usage only when a run ends, so for codex this is the only check.
  if (MAX_OUTPUT && r.output_tokens > MAX_OUTPUT) {
    throw discard(`stopped by harness output-token limit ${MAX_OUTPUT} (spent ${r.output_tokens})`, {
      harnessStop: true,
    });
  }
  // Structured answer extraction (docs/grading-design.md): condition-
  // blind, post-hoc, quote-gated. Usage is recorded on the row but NEVER summed
  // into the per-condition metrics; wall_s already brackets only backend.run.
  // A sentinel answer skips the call: all-null fields must fail, not a model's
  // reading of an error marker.
  let fields = null;
  let extraction = null;
  // The extractor's pairs before the quote gate, so a quote-gate fix can be
  // re-applied to a stored row.
  let extractionRaw = null;
  let extractionFailed = null;
  // A backend that answers with fields of its own (scripted) is graded on
  // those, and the paid extractor never runs.
  if (r.fields !== undefined) {
    fields = r.fields;
    extraction = { extractor: 'backend', model: modelFor(backendName), output_tokens: 0, cost_usd: 0 };
  } else if (task.answerSchema && !isSentinel(r.text)) {
    let lastError;
    for (let attempt = 0; attempt < 3 && !extraction; attempt++) {
      try {
        ({ fields, extraction, raw: extractionRaw } = await extractFields({
          ask: task.ask,
          answer: r.text,
          schema: task.answerSchema,
        }));
      } catch (error) {
        lastError = error;
      }
    }
    if (!extraction) {
      // The agent run is already paid for; never discard it over a grader
      // hiccup. Grade with null fields (the sentinel path every validator
      // tolerates) and flag the row so the report reader knows the fail - if
      // it fails - is the extractor's, not the agent's.
      extractionFailed = String(lastError?.message ?? 'unknown extraction error');
      fields = null;
    }
  }
  // The expect path is a bare prose regex (the three smoke tasks), so it needs
  // the emphasis strip docs/authoring-fixtures.md mandates before any such
  // regex: an agent that bolds the value it was asked to report - "Hello,
  // **Marmalade**" against /Hello, Marmalade/ - was graded a failure. Emphasis
  // only, not normalise(): these regexes are case-sensitive by design.
  // A validator that throws must not discard the paid run with it: the row
  // keeps its spend and names the harness defect instead.
  let verdict;
  let validatorError = null;
  try {
    verdict = task.validate
      ? task.validate(r.text, ctx, fields)
      : { pass: task.expect.test(r.text.replace(/[*_~`]+/g, '')) };
  } catch (error) {
    validatorError = String(error?.message ?? error);
    console.error(`[${label}] ${task.id}: VALIDATOR ERROR ${error?.stack ?? validatorError}`);
    verdict = { pass: false, detail: `VALIDATOR ERROR: ${validatorError}` };
  }
  // What the surface actually delivered. Two sources, because neither alone is
  // enough: the values the agent reported say whether its answer came off the
  // page, and the truth (the values the task names, else the codes the server
  // minted) says whether it was ever shown at all. Only the shortfalls are
  // recorded - a row listing everything the agent could see would dwarf the
  // row itself - and an answer's own arithmetic and prose are not shortfalls.
  const named = truthValues(ctx.pages?.state ?? {}, task);
  const truth = [...gradedValues(fields ?? {}), ...named];
  const surface = (() => {
    const states = reach.reach(truth, { truth: named, state: ctx.pages?.state ?? null });
    const truncated = Object.keys(states).filter((v) => states[v] === 'truncated');
    const absent = Object.keys(states).filter((v) => states[v] === 'absent');
    // Absent from every reply's text while an image reply may have shown it,
    // one after its page loaded where the state names that page
    // (surface-reach.mjs pageLoadsOf).
    const imageOnly = Object.keys(states).filter((v) => states[v] === 'image-only');
    if (!truncated.length && !absent.length && !imageOnly.length) return null;
    const clip = (list) => list.slice(0, 8).map((v) => v.slice(0, 80));
    return {
      ...(truncated.length ? { truncated: clip(truncated) } : {}),
      ...(absent.length ? { absent: clip(absent) } : {}),
      ...(imageOnly.length ? { image_only: clip(imageOnly) } : {}),
    };
  })();
  const tenth = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);
  // Triage charges a failure to the tool only through these (triage.mjs), so a
  // passing row records none: reused-row's speculative accept_dialog, sent after
  // a click that opened no confirm(), read as an unrecovered tool error on a
  // row that passed. Triage re-reads a row regraded to a failure from its
  // transcript. Only the attempt's truth marks an error as being about the
  // graded value; a value the answer claimed can be the agent's own mistake.
  const blamed = toolErrors.length && !verdict.pass ? blameToolErrors(toolErrors, named) : null;
  const { invalid, ...measured } = telemetry;
  const invalidWhy =
    invalid ?? (foreign?.sessions ? 'foreign-browser' : r.codex_isolation ? 'codex-isolation' : null);
  return {
    backend: backendName,
    condition: label,
    task: task.id,
    ...(REPEAT > 1 ? { rep } : {}),
    ...taskTags(task),
    model: modelFor(backendName) || '(backend default)',
    success: verdict.pass,
    detail: verdict.detail,
    ...(validatorError ? { validator_error: validatorError } : {}),
    // Absent alone is ambiguous (a derived total was never printed either), but
    // truncated is not: it means the page rendered the value and the surface cut it.
    ...(surface ? { surface } : {}),
    ...(invalidWhy ? { invalid: invalidWhy } : {}),
    ...measured,
    ...(toolErrors.length ? { tool_errors: { errors: toolErrors.length, ...(blamed ? { blamed } : {}) } } : {}),
    ...(foreign ? { foreign_browser: foreign } : {}),
    ...provenance,
    started_at: startedAt.toISOString(),
    answer: r.text.slice(0, 160).replace(/\n/g, ' '),
    turns: r.turns,
    input_tokens: r.input_tokens,
    cache_creation: r.cache_creation,
    cache_read: r.cache_read,
    output_tokens: r.output_tokens,
    cost_usd: r.cost_usd,
    duration_s: tenth(r.duration_ms),
    api_s: tenth(r.api_duration_ms),
    wall_s: tenth(wallMs),
    // >1 when the agent used a background task, so the run arrived as several
    // SDK result segments whose usage had to be summed (see backends/anthropic.mjs).
    ...(r.segments > 1 ? { segments: r.segments } : {}),
    // The SDK's cost per model, the agent's and the CLI's own calls to others,
    // which cost_usd sums (backends/anthropic.mjs).
    ...(r.model_usage ? { model_usage: r.model_usage } : {}),
    ...(r.stream_errors ? { stream_errors: r.stream_errors } : {}),
    // How the backend offered the MCP tools, what codex's rollout says code mode
    // did, and where its session departed from the isolation it was set up
    // with (see backends/codex.mjs codeModeStats and isolationProblems).
    ...(r.tool_mode ? { tool_mode: r.tool_mode } : {}),
    ...(r.code_mode ? { code_mode: r.code_mode } : {}),
    ...(r.codex_isolation ? { codex_isolation: r.codex_isolation } : {}),
    // Grading evidence for schema tasks; excluded from every condition total.
    // The verbatim answer rides along on every row so regrade.mjs never grades
    // the preview: fields are what graded, answer_full is what the agent said.
    ...(task.answerSchema
      ? { grading: 'fields', fields, extraction, extraction_raw: extractionRaw, answer_full: r.text }
      : { answer_full: r.text }),
    ...(extractionFailed ? { extraction_failed: extractionFailed } : {}),
    ...(downloads.length ? { downloads } : {}),
    ...(ctx.transcriptsDir ? { transcript } : {}),
  };
}

// The devtools suite (T120-T124): same task shape as webTasks, graded against
// the same fixture server. Kept out of 'web' (see below); 'all' includes it.
// `origins` maps each manifest key to its origin URL; left undefined, the
// factories map every key onto its path prefix under `base`.
async function buildTasks(base, origins = undefined) {
  let tasks = [];
  if (SUITE === 'basic' || SUITE === 'all') {
    tasks.push(...basicTasks(base, origins));
  }
  if (SUITE === 'web' || SUITE === 'all') {
    tasks.push(...(await webTasks(base, origins)));
  }
  // Devtools-surface tasks live in their OWN suite by owner decision: the
  // primary comparison is web-agent flows, and a console/network task mixed
  // into the web sweep would skew its totals. 'all' includes them.
  if (SUITE === 'devtools' || SUITE === 'all') {
    tasks.push(...(await devtoolsTasks(base, origins)));
  }
  for (const t of tasks) {
    if (t.tier && !(t.tier in WALL_TIERS)) {
      throw new Error(
        `task "${t.id}" has unknown tier "${t.tier}" (known: ${Object.keys(WALL_TIERS).join(', ')})`
      );
    }
  }
  const ids = new Set();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate task id "${t.id}" in the suite`);
    ids.add(t.id);
  }
  if (TASK_PATTERNS) {
    const unmatched = TASK_PATTERNS.filter(
      (p) => !tasks.some((t) => patternMatches(p, t.id))
    );
    if (unmatched.length) {
      throw new Error(
        `--task matched nothing for: ${unmatched.join(', ')}\n` +
          `available in suite '${SUITE}': ${tasks.map((t) => t.id).join(', ')}`
      );
    }
    tasks = tasks.filter((t) => taskSelected(t.id));
  }
  return tasks;
}

// --- headed window grid ---------------------------------------------------
// Conditions whose windows we can position via a seeded profile (see
// window-grid.mjs; playwright-mcp has no window-position knob).
const POSITIONABLE = CONDITIONS.filter(isDevtools);
// Under --interleave one queue feeds every worker and a worker runs every
// condition, so a worker owns one grid cell whatever it runs.
const INTERLEAVE_WORKERS = PARALLEL_TASKS * (PARALLEL ? BACKEND_NAMES.length * CONDITIONS.length : 1);
const TOTAL_SLOTS = INTERLEAVE
  ? INTERLEAVE_WORKERS
  : BACKEND_NAMES.length * POSITIONABLE.length * PARALLEL_TASKS;
let GRID = null;

// Deterministic slot per (backend, condition, worker) keeps a condition's
// workers adjacent in the grid.
function slotFor(backendName, condition, workerIndex) {
  const runIdx =
    BACKEND_NAMES.indexOf(backendName) * POSITIONABLE.length +
    POSITIONABLE.indexOf(condition);
  return runIdx * PARALLEL_TASKS + workerIndex;
}

// The row for a task (or a whole condition) that never produced a graded run.
function errorRow({ backend, label, task, rep, error, ...extra }) {
  return {
    backend,
    condition: label,
    task,
    ...(REPEAT > 1 && rep != null ? { rep } : {}),
    success: false,
    error: String(error?.message ?? error),
    ...extra,
  };
}

// The task's family module and capability areas, for per-family and per-area
// breakdowns. Null on a task that declares neither.
const taskTags = (task) => ({ family: task.family ?? null, areas: task.areas ?? null });

// A request ledger reduced to what a row can carry. `documents` are page and
// frame loads, `scripted` are a page's own fetch/XHR/beacon calls, and
// `non_browser` are requests without the browser's Fetch Metadata, which on
// these loopback origins only a client outside the page sends (a shell's
// curl). The server's own `route` and `client` readings are used where a row
// has them, and Sec-Fetch-Dest otherwise. Every entry since the attempt's reset
// is the attempt's, because each worker's pages server serves one attempt at a
// time. `byStatus` counts a request still in flight as 'none'.
const DOCUMENT_DESTS = new Set(['document', 'iframe', 'frame']);
function ledgerSummary(ledger) {
  const byStatus = {};
  const nonBrowserByStatus = {};
  const sids = new Set();
  let documents = 0;
  let scripted = 0;
  let nonBrowser = 0;
  for (const e of ledger) {
    const status = String(e.status ?? 'none');
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (e.route ? e.route === 'document' || e.route === 'frame' : DOCUMENT_DESTS.has(e.dest)) documents++;
    else if (e.route ? e.route === 'fetch' : e.dest === 'empty') scripted++;
    if (e.client ? e.client !== 'browser' : !e.dest) {
      nonBrowser++;
      nonBrowserByStatus[status] = (nonBrowserByStatus[status] ?? 0) + 1;
    }
    if (e.sid) sids.add(e.sid);
  }
  return {
    requests: ledger.length, documents, scripted, non_browser: nonBrowser, sessions: sids.size, byStatus,
    ...(nonBrowser ? { non_browser_by_status: nonBrowserByStatus } : {}),
  };
}

// What the server saw during a row's attempt, read before the next reset() wipes
// it: the ledger summary, the difficulty draws, and a copy of the whole state
// for regrading. A server without a ledger or a draw log (one older than them)
// leaves those null rather than absent, so every row has the same keys.
function serverRecord(env, transcript, statesDir, backendName) {
  const state = env.pages.state;
  let draws = null;
  if (Array.isArray(state.draws)) {
    try {
      draws = structuredClone(Array.from(state.draws));
    } catch {
      draws = JSON.parse(JSON.stringify(Array.from(state.draws)));
    }
  }
  const out = {
    ledger: Array.isArray(state.ledger) ? ledgerSummary(state.ledger) : null,
    // The shell requests a graded route answered (scripts/row-evidence.mjs),
    // null when there were none: the reports keep such a row out of the
    // comparisons between conditions.
    shell_assisted: shellAssisted(state.ledger, { backend: backendName }),
    draws,
    state_file: null,
  };
  if (statesDir && transcript) {
    const name = `${transcript.replace(/\.jsonl$/, '')}.json.gz`;
    try {
      writeStateFile(join(statesDir, name), state, { base: env.pages.url, origins: env.origins ?? null });
      out.state_file = `states/${name}`;
    } catch (error) {
      out.state_file_error = String(error?.message ?? error);
    }
  }
  return out;
}

// One isolated execution environment: a pages server and its state. Sequential
// runs use one env per condition; --parallel-tasks uses one per worker. Every
// live env is tracked so an interrupt closes its listeners instead of leaking
// them (agents spawn their own MCP servers as children, which die with us).
const ACTIVE_ENVS = new Set();
// The run in progress, so an interrupt or a crash can still write every row
// that finished.
const LIVE = { runDir: null, meta: null, rows: [] };
// Every row still being produced, so an interrupt can wait for the rows of the
// attempts it stopped: they carry what those attempts spent.
const SETTLING = new Set();
let interrupting = false;

// The task definitions the report's triage reads a task's named truth from
// (surface-reach.mjs truthValues): this run's, or every task's for a re-render.
let REPORT_TASKS = null;

// The run's health (scripts/run-health.mjs) is read from the files just
// written. report.md's header sums it up, so its own check is left out.
function writeRun(runDir, meta, results) {
  const totals = totalsByCondition(results);
  const run = { meta, results, totals };
  const jsonPath = join(runDir, 'results.json');
  const mdPath = join(runDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify(run, null, 2));
  const health = runHealth(runDir, { run, skip: ['report'] });
  writeFileSync(mdPath, markdownReport({ meta, results, totals, runDir, tasks: REPORT_TASKS, health: healthLine(health, { dir: runDir }) }));
  const htmlPath = join(runDir, 'report.html');
  if (results.length) writeFileSync(htmlPath, renderHtmlReport(run, basename(runDir)));
  return { totals, jsonPath, mdPath, htmlPath, health };
}

// Stops the agents, waits for their rows, writes what finished, then closes
// the environments. A second signal exits at once.
function onSignal(signal) {
  const code = signal === 'SIGINT' ? 130 : 143;
  if (interrupting) process.exit(code);
  interrupting = true;
  console.error(
    `\n${signal}: stopping agents (up to ${INTERRUPT_GRACE_MS / 1000}s, interrupt again to exit ` +
      'at once), writing finished rows, closing environments...'
  );
  for (const stop of ACTIVE_STOPS) stop(`interrupted by ${signal}`);
  const grace = new Promise((resolve) => setTimeout(resolve, INTERRUPT_GRACE_MS));
  Promise.race([Promise.allSettled([...SETTLING]), grace]).then(() => {
    if (LIVE.runDir) {
      const meta = {
        ...LIVE.meta,
        interrupted: signal,
        ...(SETTLING.size ? { unsettled: SETTLING.size } : {}),
      };
      try {
        const { mdPath } = writeRun(LIVE.runDir, meta, LIVE.rows);
        console.error(`${LIVE.rows.length} row(s) written: ${mdPath}`);
      } catch (error) {
        console.error(`could not write partial results: ${error.message}`);
      }
    }
    return Promise.allSettled([...ACTIVE_ENVS].map((env) => env.close()));
  }).finally(() => process.exit(code));
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('exit', removeAllTempDirs);

// A server.mjs that predates host routing ignores `vhosts` and would serve
// single-origin while every ask named an origin it never bound.
const routesByHost = (pages) =>
  Boolean(pages.origins?.length) && pages.origins.every((o) => /^http:\/\/[a-z0-9-]+\.localhost:\d+$/.test(o.url));
const NO_VHOSTS = '--vhosts: this server.mjs does not route by host (startPagesServer returned no <key>.localhost origins)';

// `gridSlot` is the grid cell this env's headed windows tile into (stdio MCP
// servers launch their own Firefox and get the geometry via --profile-path).
async function makeEnv(gridSlot = null) {
  // Each env gets its own pages server so validator state (sessions/beacons)
  // never mixes across concurrent agents.
  const pages = await startPagesServer({
    modes: RUN_MODES,
    seed: RUN_SEED,
    ...(SERVING === 'origins' ? { origins: ORIGINS } : SERVING === 'vhosts' ? { vhosts: true } : {}),
  });
  if (SERVING === 'vhosts' && !routesByHost(pages)) {
    await pages.close();
    throw new Error(NO_VHOSTS);
  }
  const env = {
    pages,
    origins: SERVING === 'single-origin' ? undefined : originUrls(pages.url, pages.origins),
    gridSlot,
    async close() {
      ACTIVE_ENVS.delete(env);
      await pages.close();
    },
  };
  ACTIVE_ENVS.add(env);
  return env;
}

// One arm of the run, as the queues hand it around.
const armOf = (backendName, condition) => ({ backendName, condition, label: labelFor(backendName, condition) });

async function runOne({ backendName, condition, label }, env, item, shared) {
  // Task asks embed the env's pages URLs, so rebuild against this env.
  const task = (await buildTasks(env.pages.url, env.origins)).find((t) => t.id === item.id);
  const tag = REPEAT > 1 ? `${item.id} (r${item.rep})` : item.id;
  // Every failed attempt's spend. `unknown` counts attempts whose backend
  // could not say what they spent (a codex attempt whose rollout shows no
  // completed request).
  const discarded = { cost_usd: 0, output_tokens: 0, attempts: 0, unknown: 0 };
  const discardedFields = () =>
    discarded.attempts
      ? {
          discarded_attempts: discarded.attempts,
          discarded_cost_usd: Math.round(discarded.cost_usd * 10000) / 10000,
          discarded_output_tokens: discarded.output_tokens,
          ...(discarded.unknown ? { discarded_unknown: discarded.unknown } : {}),
        }
      : {};
  for (let attempt = 0; ; attempt++) {
    // Fresh server state per attempt, so a retry is graded on its own run.
    env.pages.state.reset();
    // Per-task page-serving modes (mirror-reroute takes the gadgetron store
    // offline for its own run only). reset() above restored the server's
    // defaults, so a mode can never leak into the next task in this process.
    Object.assign(env.pages.state.modes, task.serverModes ?? {});
    try {
      const ctx = {
        ...shared,
        pages: env.pages,
        gridSlot: POSITIONABLE.includes(condition) ? env.gridSlot : null,
      };
      const r = await runTask(backendName, condition, label, task, ctx, item.rep, attempt);
      console.log(
        `[${label}] ${tag}: ${r.success ? 'PASS' : 'FAIL'} turns=${r.turns} ` +
          `in=${r.input_tokens} cacheW=${r.cache_creation} cacheR=${r.cache_read} ` +
          `out=${r.output_tokens} $${r.cost_usd?.toFixed?.(4) ?? '?'} ` +
          `wall=${r.wall_s}s api=${r.api_s ?? '?'}s` +
          (r.invalid ? ` INVALID (${r.invalid})` : '') +
          (r.detail ? ` (${r.detail})` : '') +
          (attempt ? ` [after ${attempt} retry]` : '')
      );
      return {
        ...r,
        ...(attempt ? { retries: attempt } : {}),
        ...discardedFields(),
        ...serverRecord(env, r.transcript, shared.statesDir, backendName),
      };
    } catch (error) {
      const spend = error?.spend;
      if (spend) {
        discarded.attempts += 1;
        discarded.cost_usd += spend.cost_usd ?? 0;
        discarded.output_tokens += spend.output_tokens ?? 0;
        if (spend.unknown || spend.cost_usd == null) discarded.unknown += 1;
      }
      const { retry, infra } = classify(error);
      if (retry && attempt < RETRIES && !interrupting) {
        console.log(
          `[${label}] ${tag}: transient error, retrying ` +
            `(${attempt + 1}/${RETRIES}): ${String(error?.message).slice(0, 90)}`
        );
        continue;
      }
      console.log(`[${label}] ${tag}: ERROR ${error?.message}`);
      // An infra row already sits outside the pass rate, in its own column; an
      // API error before the first tool call is not a contaminated row.
      const { invalid: noSurface, ...telemetry } = error?.telemetry ?? {};
      const invalid = noSurface ?? (error?.foreign?.sessions ? 'foreign-browser' : undefined);
      // `infra` separates "we never got a graded attempt" from "the agent
      // failed the task", and is deliberately NARROWER than a retry: what
      // is worth retrying is not the same as what is worth excusing. An API or
      // transport error is the former. A harness limit stop is the latter even
      // though we retry it, because an agent that exhausts every retry on the
      // wall clock really was too slow, and excusing that inflates the pass
      // rate. A backend that exits non-zero also stays a failure, since we
      // cannot show it was not the agent's doing.
      return errorRow({
        backend: backendName,
        label,
        task: item.id,
        rep: item.rep,
        error,
        ...taskTags(task),
        ...(infra ? { infra: true } : {}),
        ...(attempt ? { retries: attempt } : {}),
        ...discardedFields(),
        ...(error?.downloads?.length ? { downloads: error.downloads } : {}),
        ...(error?.transcript ? { transcript: error.transcript } : {}),
        ...telemetry,
        ...(invalid && !infra ? { invalid } : {}),
        ...(error?.foreign ? { foreign_browser: error.foreign } : {}),
        ...(error?.provenance ?? {}),
        ...(error?.startedAt ? { started_at: error.startedAt.toISOString() } : {}),
        ...serverRecord(env, error?.transcript, shared.statesDir, backendName),
      });
    }
  }
}

// Runs one item and hands its row to `onRow` as soon as it exists, for the
// partial results an interrupt writes.
function settle(arm, env, item, shared, onRow) {
  const settled = (async () => {
    let row;
    try {
      row = await runOne(arm, env, item, shared);
    } catch (error) {
      row = errorRow({ backend: arm.backendName, label: arm.label, task: item.id, rep: item.rep, error });
    }
    onRow(row);
    return row;
  })();
  SETTLING.add(settled);
  settled.finally(() => SETTLING.delete(settled));
  return settled;
}

// Workers pulling `queue` in order until it is empty, each on its own env. A
// worker that cannot start or a task that escapes runOne must not sink the
// pool: completed rows stay, and every item left once no worker could take it
// becomes an error row. Returns the rows in the order the items finished.
async function drainQueue(queue, workerCount, gridSlotFor, shared, onRow, name = null) {
  const rows = [];
  const startErrors = [];
  await Promise.all(
    Array.from({ length: Math.min(workerCount, queue.length) }, async (_, workerIndex) => {
      let env;
      try {
        env = await makeEnv(gridSlotFor(workerIndex));
      } catch (error) {
        console.error(`${name ? `[${name}] ` : ''}worker ${workerIndex} could not start: ${error.message}`);
        startErrors.push(error);
        return;
      }
      try {
        while (queue.length && !interrupting) {
          const item = queue.shift();
          rows.push(await settle(item.arm, env, item, shared, onRow));
        }
      } finally {
        await env.close().catch(() => {});
      }
    })
  );
  // A task an interrupt kept from starting gets no row, as in a sequential run.
  if (!interrupting) {
    for (const item of queue.splice(0)) {
      const why = startErrors[0]?.message ?? 'unknown';
      const row = errorRow({
        backend: item.arm.backendName, label: item.arm.label, task: item.id, rep: item.rep,
        error: `no worker started: ${why}`,
      });
      onRow(row);
      rows.push(row);
    }
  }
  return rows;
}

// The (task, repeat) items of one arm, in suite order.
async function suiteItems(arm) {
  return (await buildTasks('http://placeholder')).flatMap((t) =>
    Array.from({ length: REPEAT }, (_, i) => ({ arm, id: t.id, rep: i + 1 }))
  );
}
const itemKey = (item) => `${item.arm.label}|${item.id}#${item.rep}`;
const rowKey = (row) => `${row.condition}|${row.task}#${row.rep ?? 1}`;

// Every row in suite order, from one condition's own pool or env.
async function runCondition(backendName, condition, shared, onRow) {
  const arm = armOf(backendName, condition);
  console.log(`[${arm.label}] starting (model: ${modelFor(backendName) || '(backend default)'})`);
  const items = await suiteItems(arm);
  const slot = (workerIndex) =>
    GRID && POSITIONABLE.includes(condition) ? slotFor(backendName, condition, workerIndex) : null;
  if (PARALLEL_TASKS > 1) {
    const rows = new Map(
      (await drainQueue([...items], PARALLEL_TASKS, slot, shared, onRow, arm.label)).map((row) => [rowKey(row), row])
    );
    return items.map((item) => rows.get(itemKey(item))).filter(Boolean);
  }
  const env = await makeEnv(slot(0));
  try {
    const results = [];
    for (const item of items) {
      if (interrupting) break;
      results.push(await settle(arm, env, item, shared, onRow));
    }
    return results;
  } finally {
    await env.close().catch(() => {});
  }
}

// `n` indices in an order drawn from `key`: a seeded run's order is fixed by
// its seed, and an unseeded run's is random.
function drawnOrder(n, key) {
  const order = Array.from({ length: n }, (_, i) => i);
  const bytes = key == null ? randomBytes(4 * n) : Buffer.alloc(0);
  for (let i = n - 1; i > 0; i--) {
    const word =
      key == null
        ? bytes.readUInt32BE(4 * i)
        : createHash('sha256').update(`${key}:${i}`).digest().readUInt32BE(0);
    const j = word % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// --interleave: one queue of blocks, one block per (task, repeat), each holding
// every arm in a drawn order. Repeat r of every task comes before repeat r+1,
// so a task's repeats spread across the run rather than sitting together, and
// the arms of a block run side by side in time. Every row in the same order a
// per-condition run gives.
async function runInterleaved(runs, shared, onRow) {
  const arms = runs.map(([b, c]) => armOf(b, c));
  for (const arm of arms) {
    console.log(`[${arm.label}] queued (model: ${modelFor(arm.backendName) || '(backend default)'})`);
  }
  const perArm = await Promise.all(arms.map(suiteItems));
  const byKey = new Map(perArm.flat().map((item) => [itemKey(item), item]));
  const tasks = perArm[0].filter((item) => item.rep === 1).map((item) => item.id);
  const queue = [];
  for (let rep = 1; rep <= REPEAT; rep++) {
    for (const id of tasks) {
      const order = drawnOrder(arms.length, RUN_SEED == null ? null : `${RUN_SEED}:interleave:${id}:r${rep}`);
      for (const i of order) queue.push(byKey.get(itemKey({ arm: arms[i], id, rep })));
    }
  }
  console.log(
    `(interleaved: ${queue.length} items in ${tasks.length * REPEAT} blocks of ${arms.length}, ` +
      `${Math.min(INTERLEAVE_WORKERS, queue.length)} worker(s))\n`
  );
  const rows = new Map(
    (await drainQueue(queue, INTERLEAVE_WORKERS, (w) => (GRID ? w : null), shared, onRow)).map((row) => [
      rowKey(row),
      row,
    ])
  );
  return perArm.flat().map((item) => rows.get(itemKey(item))).filter(Boolean);
}

// The paths of the repository whose edits change what a run serves, drives or
// grades.
const EVAL_PATHS = ['eval', 'sites', 'pages', 'server.mjs', 'serve.mjs', 'manifest.mjs'];

// The commit and dirty flag of a git work tree, read now rather than whenever
// the run is later bundled. The flag alone left a stored run's edits unknown,
// so a dirty tree also records its dirty files as `git status` codes and
// paths, and a sha256 over the files under EVAL_PATHS that differ from HEAD,
// untracked ones included: each path, then its bytes' sha256, a link's target,
// or "deleted". Contents rather than diff text, whose prefixes and textconv
// follow the operator's git config. Two runs of one commit with the same hash
// ran the same eval code. The hash is null when no file under EVAL_PATHS
// differs, and `diffError` says so when git could not list them.
function gitState(dir) {
  const git = (gitArgs) => {
    const r = spawnSync('git', ['-C', dir, ...gitArgs], { maxBuffer: 1 << 30 });
    return r.status === 0 ? r.stdout.toString('utf8') : null;
  };
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all']);
  const commit = git(['rev-parse', 'HEAD'])?.trim() ?? null;
  if (!status) return { commit, dirty: status == null ? null : false };
  // -z entries are "XY path", and a rename or copy is followed by its source.
  const dirtyFiles = [];
  const entries = status.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    dirtyFiles.push(/[RC]/.test(code) ? `${code} ${entries[++i]} -> ${path}` : `${code} ${path}`);
  }
  const state = { commit, dirty: true, dirtyFiles, diffPaths: EVAL_PATHS, diffSha256: null };
  const changed = git(['diff', 'HEAD', '--name-only', '--no-renames', '--no-relative', '-z', '--', ...EVAL_PATHS]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...EVAL_PATHS]);
  if (changed == null || untracked == null) {
    return { ...state, diffError: `git ${changed == null ? 'diff' : 'ls-files'} failed` };
  }
  const paths = [...new Set(`${changed}\0${untracked}`.split('\0').filter(Boolean))].sort();
  if (!paths.length) return state;
  const hash = createHash('sha256');
  for (const path of paths) {
    const full = join(dir, path);
    let content;
    try {
      content = lstatSync(full).isSymbolicLink() ? `link ${readlinkSync(full)}` : (sha256File(full) ?? 'unreadable');
    } catch {
      content = 'deleted';
    }
    hash.update(`${path}\0${content}\0`);
  }
  return { ...state, diffSha256: hash.digest('hex') };
}

// Walks up node_modules the way Node resolves a package, because neither SDK
// exports its package.json.
function packageVersion(name) {
  for (let dir = here; ; dir = dirname(dir)) {
    const path = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')).version ?? null;
    if (dirname(dir) === dir) return null;
  }
}

// Everything needed to reproduce the run: the flags that change what ran, the
// code and tool versions it ran on, and the isolation it ran under. Variable
// NAMES only, never values.
// `env` is what each condition's browser reported in the preflight, `tools`
// what identifies each condition's tool list there, and `taskHashes` each
// selected task's identity.mjs taskHash.
function buildMeta(startedAt, selected, env, tools, taskHashes) {
  const custom = (c) => c === DEVTOOLS && MCP_COMMAND;
  const surfaces = Object.fromEntries(
    CONDITIONS.map((c) => [
      c,
      {
        ...(c === 'playwright-mcp'
          ? playwrightMcpInfo()
          : custom(c)
            ? { source: '--mcp-command', command: MCP_COMMAND }
            : devtoolsMcpInfo(devtoolsRootFor(c))),
        tools: tools[c] ?? null,
      },
    ])
  );
  // Each firefox-devtools-mcp build the run measured, identified by content
  // rather than by name, so two runs of "the same" build can be told apart.
  const builds = CONDITIONS.filter((c) => isDevtools(c) && !custom(c)).map((c) => {
    const { version, sha256, walkerSha256, commit, dirty } = surfaces[c];
    const browser = env[c]?.build;
    return {
      label: c === DEVTOOLS ? null : c.slice(DEVTOOLS.length + 1),
      condition: c,
      root: resolve(devtoolsMcpEntry(devtoolsRootFor(c)), '..', '..'),
      version,
      sha256,
      walkerSha256,
      ...(commit !== undefined ? { commit, dirty } : {}),
      tools: tools[c] ?? null,
      // The browser the build drove, which is not the build: identity.mjs
      // browserKey reads it apart from buildKey.
      firefox: {
        binary: browser?.binary ?? null,
        version: browser?.version ?? null,
        buildID: browser?.buildID ?? null,
        pinned: DEVTOOLS_FIREFOX.get(c)?.spec ?? null,
      },
    };
  });
  return {
    date: startedAt.toISOString(),
    backend: BACKEND_NAMES.join(','),
    models: Object.fromEntries(
      BACKEND_NAMES.map((n) => [n, modelFor(n) || '(backend default)'])
    ),
    effort: EFFORT,
    suite: SUITE,
    // A run without this key predates per-origin serving and was single-origin.
    serving: SERVING,
    env,
    envPins: {
      ...BROWSER_PINS,
      viewport: VIEWPORT,
      devtoolsWindow: HEADED ? 'the headed grid cell' : DEVTOOLS_WINDOW,
      pdfViewerEnabled: 'pdfjs.disabled' in PINNED_PREFS ? !PINNED_PREFS['pdfjs.disabled'] : null,
      prefs: PINNED_PREFS,
      playwrightConfig: PLAYWRIGHT_CONFIG,
    },
    task: ONLY_TASK ?? undefined,
    // What --rerun-failed needs to name the tasks an interrupt left unfinished.
    tasks: selected.map((t) => t.id),
    // What regrade.mjs compares against the task definitions of its own day,
    // to tell a task edit from a validator flip, and history.mjs keys a task's
    // entries on.
    taskHashes,
    rerunFailed: RERUN_FAILED ?? undefined,
    repeat: REPEAT > 1 ? REPEAT : undefined,
    conditions: CONDITIONS.join(','),
    // What each built-in firefox-devtools-mcp condition was told to launch: a
    // pinned binary with the flag or variable that pinned it, or null for the
    // installed Firefox. A run without the key launched the installed one.
    devtoolsFirefox: Object.fromEntries(
      FIREFOX_CONDITIONS.map((c) => {
        const pin = DEVTOOLS_FIREFOX.get(c);
        return [c, pin ? { spec: pin.spec, binary: pin.binary, source: pin.source } : null];
      })
    ),
    mcpCommand: MCP_COMMAND ?? undefined,
    parallel: PARALLEL || undefined,
    parallelTasks: PARALLEL_TASKS > 1 ? PARALLEL_TASKS : undefined,
    interleave: INTERLEAVE || undefined,
    // Null only under --seed none. A run without the key predates default
    // seeding, and was seeded only if it said so.
    seed: RUN_SEED,
    seedSource:
      SEED_ARG === 'none' ? 'none' : SEED_ARG ? '--seed' : RERUN_SEED !== undefined ? '--rerun-failed' : 'run stamp',
    modes: Object.keys(RUN_MODES).length ? RUN_MODES : undefined,
    retries: RETRIES,
    maxWall: MAX_WALL_OVERRIDE || undefined,
    wallTiers: WALL_TIERS,
    maxOutput: MAX_OUTPUT || undefined,
    extractor: EXTRACTOR_USED
      ? extractorInfo()
      : { extractor: 'backend', model: BACKEND_NAMES.map(modelFor).join(',') },
    git: gitState(join(here, '..')),
    surfaces,
    builds,
    // Whether each MCP server ran through mcp-tap.mjs, the only source of the
    // rows' per-tool latency.
    tap: TAP,
    sdks: Object.fromEntries(BACKEND_NAMES.map((n) => [n, packageVersion(SDK_PACKAGES[n])])),
    // The table pricing.mjs prices codex rows and aborted attempts with.
    priceTable: { package: PRICE_TABLE, version: packageVersion(PRICE_TABLE) },
    isolation: {
      scratch: 'fresh directory per attempt',
      downloads:
        '<attempt dir>/downloads, or playwright-mcp\'s --output-dir <attempt dir>/playwright-output; the agent\'s ' +
        'sandbox denies it writes to either (agent-env.mjs serverDirs); recorded on the row without the servers\' ' +
        'own files, a file the agent named in a tool call or a reply said it saved, with what firefox-devtools-mcp\'s ' +
        'set_download_behavior sent to <its HOME>/.firefox-devtools-mcp/output/downloads or the folder its reply named ' +
        '(0.10.3), each named under its folder',
      ...(HEADED ? { browserProfile: 'seeded per attempt with its grid cell' } : {}),
      env: Object.fromEntries(BACKEND_NAMES.map((n) => [n, Object.keys(agentEnvFor(n)).sort()])),
      toolPolicy: Object.fromEntries(BACKEND_NAMES.map((n) => [n, BACKENDS[n].TOOL_POLICY])),
      // Stubs first on every agent shell's PATH, never on an MCP server's.
      shellStubs: SHIMMED_COMMANDS,
      devtoolsHome:
        'fresh per attempt, outside the agent\'s directory; SE_CACHE_PATH keeps the WebDriver cache; its ' +
        '.firefox-devtools-mcp, where saveTo saves (output/ on 0.10.3), is the backend\'s serverOutputDirs, readable ' +
        'and not writable by the agent',
      browserTag: {
        how: 'each attempt\'s browser sends the preflight user agent plus a space and 8 hex digits',
        mechanism: Object.fromEntries(CONDITIONS.map((c) => [c, tagMechanismFor(c)])),
        verified: Object.fromEntries(CONDITIONS.map((c) => [c, TAGGABLE.has(c)])),
      },
      // scripts/foreign-browser.mjs. A foreign session makes the row invalid.
      foreignBrowser: {
        rule: Object.fromEntries(
          CONDITIONS.map((c) => [c, TAGGABLE.has(c) ? 'user agent' : TAP ? 'timing and session count' : 'off'])
        ),
        userAgent:
          "where the condition's browser tag verified: a browser session, or a browser request without one, whose " +
          "requests name user agents and none of them the attempt's token. It reads the ledger alone, so --no-tap " +
          'leaves it on',
        timingAndCount:
          'where the tag did not verify, and read from the tap log, so off under --no-tap: a browser session whose first ' +
          `request came outside every surface call (${SURFACE_BEFORE_MS}ms before to ${SURFACE_SLACK_MS}ms after) and during a shell ` +
          `command (until ${SHELL_AFTER_MS}ms after it, for good once backgrounded) or over ${SURFACE_AFTER_MS}ms after any surface call; ` +
          'or a second session loading a site top-level that first did so inside the same surface call as the one before it, or while that one ' +
          `still sent requests (over ${OVERLAP_MS}ms after). Missed: a session that starts inside a later surface call while the one before ` +
          'it on that site sends nothing more',
      },
    },
    node: process.version,
  };
}

// What a --rerun-failed top-up ran that no flag pins to the run it tops up:
// each condition's server build, the agent SDKs, the price table, the
// extractor, codex's tool mode, the wall tiers and the task definitions. Like
// its browsers (report.mjs
// envDrift), they cannot be restored, so each is recorded where it differs.
// Only what that run recorded is compared.
function rerunBuildDrift(prior, meta) {
  const out = [];
  const SURFACE_FIELDS = ['source', 'path', 'command', 'version', 'commit', 'dirty', 'sha256', 'walkerSha256', 'core'];
  const short = (value) => (value == null ? '?' : String(value).slice(0, 12));
  const fmt = (key, value) =>
    value == null
      ? 'none'
      : key === 'core'
        ? `playwright-core ${value.version ?? '?'} (bundles ${short(value.coreBundle)} ${short(value.utilsBundle)})`
        : /sha256|commit/i.test(key) ? short(value) : String(value);
  for (const c of CONDITIONS) {
    const then = prior.surfaces?.[c];
    const now = meta.surfaces[c] ?? {};
    if (!then) continue;
    const moved = SURFACE_FIELDS.filter(
      (k) => k in then && JSON.stringify(then[k] ?? null) !== JSON.stringify(now[k] ?? null)
    );
    const show = (s) => moved.map((k) => `${k} ${fmt(k, s[k])}`).join(', ');
    if (moved.length) out.push(`${c} server build was ${show(then)}, now ${show(now)}`);
  }
  for (const n of BACKEND_NAMES) {
    const then = prior.sdks?.[n];
    if (then !== undefined && then !== meta.sdks[n]) out.push(`${n} ${SDK_PACKAGES[n]} was ${then}, now ${meta.sdks[n]}`);
  }
  if (prior.priceTable && prior.priceTable.version !== meta.priceTable.version) {
    out.push(`the price table ${PRICE_TABLE} was ${prior.priceTable.version}, now ${meta.priceTable.version}`);
  }
  const extractor = (e) => `${e?.extractor ?? '?'} ${e?.model ?? '?'}`;
  if (prior.extractor && extractor(prior.extractor) !== extractor(meta.extractor)) {
    out.push(`the extractor was ${extractor(prior.extractor)}, now ${extractor(meta.extractor)}`);
  }
  const toolMode = (m) => m.isolation?.toolPolicy?.codex?.toolMode;
  if (BACKEND_NAMES.includes('codex') && toolMode(prior) !== undefined && toolMode(prior) !== toolMode(meta)) {
    out.push(`codex tool mode was ${toolMode(prior)}, now ${toolMode(meta)}`);
  }
  const tiers = (t) => Object.entries(t).map(([k, s]) => `${k} ${s}s`).join(', ');
  if (!MAX_WALL_OVERRIDE && prior.wallTiers && tiers(prior.wallTiers) !== tiers(meta.wallTiers)) {
    out.push(`the wall tiers were ${tiers(prior.wallTiers)}, now ${tiers(meta.wallTiers)}`);
  }
  const edited = Object.keys(meta.taskHashes).filter(
    (id) => prior.taskHashes?.[id] && meta.taskHashes[id] && prior.taskHashes[id] !== meta.taskHashes[id]
  );
  if (edited.length) out.push(`task definitions changed since that run: ${edited.join(', ')}`);
  return out;
}

// --ab on --report-from: eval/ab.mjs renders the comparison, written beside the
// run's report.md. The bootstrap is seeded so a re-render reproduces its
// intervals: from --seed, else the run's own seed.
async function checkAbConditions(dir, prior) {
  const present = [...new Set(prior.results.map((r) => r.condition))];
  for (const c of [...AB, ...(CONTROL ?? [])]) {
    if (!present.includes(c)) usage(`--ab/--control: ${dir} has no condition "${c}" (it has ${present.join(', ')})`);
  }
  // Checked before report.md is rewritten, so a control that cannot pair with
  // B refuses the whole command instead of leaving a half-written render.
  const { orientControl } = await import('./ab.mjs');
  try {
    orientControl(CONTROL, AB[0], AB[1]);
  } catch (error) {
    usage(error.message);
  }
}

async function writeAbReport(dir, prior) {
  let abReport;
  try {
    ({ abReport } = await import('./ab.mjs'));
  } catch (error) {
    usage(`--ab needs eval/ab.mjs: ${error.message}`);
  }
  const [a, b] = AB;
  const markdown = abReport(prior.results, {
    a,
    b,
    control: CONTROL,
    seed: SEED_ARG === 'none' ? null : SEED_ARG ?? prior.meta?.seed ?? null,
    meta: prior.meta,
    // Rows older than the telemetry fields are read from their transcripts.
    runDir: dir,
    taskInfo: REPORT_TASKS,
  });
  const name = `ab--${a}--${b}.md`.replaceAll('/', '--');
  writeFileSync(join(dir, name), markdown);
  console.log(`wrote ${join(dir, name)}`);
}

async function main() {
  if (REPORT_FROM) {
    const dir = REPORT_FROM.replace(/\/results\.json$/, '');
    const prior = readRun(dir);
    if (AB) await checkAbConditions(dir, prior);
    const totals = totalsByCondition(prior.results);
    const path = join(dir, 'report.md');
    REPORT_TASKS = await taskInfo();
    const health = runHealth(dir, { run: prior, skip: ['report'] });
    writeFileSync(path, markdownReport({ ...prior, totals, runDir: dir, tasks: REPORT_TASKS, health: healthLine(health, { dir }) }));
    console.log(`rewrote ${path} (${prior.results.length} rows)\n${healthLine(health, { dir })}`);
    if (prior.results.length) {
      const htmlPath = join(dir, 'report.html');
      writeFileSync(htmlPath, renderHtmlReport({ ...prior, totals }, basename(dir)));
      console.log(`rewrote ${htmlPath}`);
    }
    if (AB) await writeAbReport(dir, prior);
    const { judgeCommands } = await import('./scripts/judge.mjs');
    const conditions = [...new Set(prior.results.map((r) => r.condition))];
    console.log(`\n${judgeCommands(dir, { ab: AB, conditions, meta: prior.meta }).join('\n')}`);
    return;
  }
  const selected = await buildTasks('http://placeholder');
  if (!selected.length) {
    throw new Error(`no tasks selected (suite=${SUITE}, task=${ONLY_TASK})`);
  }
  REPORT_TASKS = new Map(selected.map((t) => [t.id, t]));
  for (const name of BACKEND_NAMES) {
    const unsupported = selected.filter((t) => BACKENDS[name].supportsTask?.(t) === false).map((t) => t.id);
    if (unsupported.length) usage(`backend ${name} cannot run ${unsupported.join(', ')}; pick others with --suite or --task`);
  }
  if (LIST_TASKS) {
    console.log(
      selected
        .map((t) => `${t.id}  [${t.tier ?? DEFAULT_TIER}, cap ${wallCapFor(t)}s]`)
        .join('\n')
    );
    console.log(
      `\n${selected.length} task(s) selected from suite '${SUITE}', served ` +
        (SERVING === 'origins'
          ? 'one origin per site'
          : SERVING === 'vhosts'
            ? 'one host name per site on one port'
            : 'single-origin')
    );
    return;
  }
  if (MAX_OUTPUT && BACKENDS.codex) {
    console.log(
      'note: codex reports output tokens only when a run ends, so --max-output ' +
        'fails an over-cap codex run then instead of stopping it\n'
    );
  }

  if (SERVING === 'vhosts') {
    const pages = await startPagesServer({ vhosts: true });
    const ok = routesByHost(pages);
    await pages.close();
    if (!ok) throw new Error(NO_VHOSTS);
  }
  // The preflight loads a page in every condition's browser, so Playwright's
  // Firefox has to be installed and the headed grid laid out before it.
  if (CONDITIONS.includes('playwright-mcp')) {
    await ensurePlaywrightFirefox();
  }
  if (HEADED) {
    GRID = windowGrid(TOTAL_SLOTS, detectScreen(flag('screen', null)));
  }
  for (const name of BACKEND_NAMES) {
    try {
      BACKENDS[name].preflightCheck?.(agentEnvFor(name));
    } catch (error) {
      throw new Error(`preflight: ${error.message}, so no agent ran`);
    }
  }
  const { env, tools } = await preflight();
  if (!TAP) {
    const unchecked = CONDITIONS.filter((c) => !TAGGABLE.has(c));
    console.log(
      'note: --no-tap drops per-call latency from the rows. The check for a browser the surface did not start ' +
        'still runs by user agent' +
        (unchecked.length
          ? `, except on ${unchecked.join(', ')}, whose browser${unchecked.length > 1 ? 's are' : ' is'} untagged, ` +
            `so ${unchecked.length > 1 ? 'their' : 'its'} rows go unchecked`
          : '') +
        '\n'
    );
  }
  // Against PLACEHOLDER_BASE, as regrade.mjs builds the current definitions,
  // so a hash names the task rather than the port this run happened to get.
  const hashes = await taskInfo();
  const taskHashes = Object.fromEntries(selected.map((t) => [t.id, hashes.get(t.id)?.hash ?? null]));

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  RUN_SEED = SEED_ARG === 'none' ? null : SEED_ARG ?? (RERUN_SEED === undefined ? stamp : RERUN_SEED);
  const runDir = join(here, 'results', `run-${stamp}`);
  const transcriptsDir = join(runDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const toolCallsDir = TAP ? join(runDir, 'tool-calls') : null;
  if (toolCallsDir) mkdirSync(toolCallsDir);
  const videosDir = RECORD_VIDEO ? join(runDir, 'videos') : null;
  if (videosDir) mkdirSync(videosDir);
  const meta = buildMeta(startedAt, selected, env, tools, taskHashes);
  if (PRIOR_META) {
    meta.rerunEnvDrift = envDrift(PRIOR_META, meta);
    meta.rerunBuildDrift = rerunBuildDrift(PRIOR_META, meta);
    for (const [what, drift] of [['browsers', meta.rerunEnvDrift], ['builds', meta.rerunBuildDrift]]) {
      if (drift.length) {
        console.log(`note: the ${what} differ from those of ${RERUN_FAILED}, and report.md says so:\n  ${drift.join('\n  ')}\n`);
      }
    }
  }
  Object.assign(LIVE, { runDir, meta, rows: [] });
  // Written as the run goes, so a run killed before it can write results.json
  // (SIGKILL, an out-of-memory stop) still has its meta and every finished row.
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
  const shared = {
    transcriptsDir,
    statesDir: join(runDir, 'states'),
    toolCallsDir,
    videosDir,
    rolloutsDir: BACKENDS.codex ? join(runDir, 'rollouts') : null,
  };
  const onRow = (row) => {
    LIVE.rows.push(row);
    appendFileSync(join(runDir, 'rows.jsonl'), JSON.stringify(row) + '\n');
  };

  const runs = BACKEND_NAMES.flatMap((backendName) =>
    CONDITIONS.map((condition) => [backendName, condition])
  );
  if (!RUN_SEED && runs.length > 1) {
    console.log(
      'warning: --seed none with several arms: each arm draws its own difficulty ' +
        '(layouts, variants, weeks), so paired differences include the draws\n'
    );
  }
  // One condition's failure (a pages server or env that would not start) must
  // not discard the rows every other condition produced.
  const conditionFailed = (b, c, reason) => {
    console.error(`[${labelFor(b, c)}] condition failed: ${reason?.message ?? reason}`);
    const row = errorRow({ backend: b, label: labelFor(b, c), task: '(condition)', error: reason });
    onRow(row);
    return row;
  };
  let results = [];
  if (INTERLEAVE) {
    try {
      results = await runInterleaved(runs, shared, onRow);
    } catch (error) {
      results = runs.map(([b, c]) => conditionFailed(b, c, error));
    }
  } else if (PARALLEL) {
    console.log('(parallel mode: runs execute side by side; wall timings may include contention)\n');
    // allSettled so one condition's failure still lets the others finish and
    // tear down their instances/servers.
    const settled = await Promise.allSettled(
      runs.map(([b, c]) => runCondition(b, c, shared, onRow))
    );
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        results.push(conditionFailed(...runs[i], outcome.reason));
      }
    }
  } else {
    for (const [b, c] of runs) {
      try {
        results.push(...(await runCondition(b, c, shared, onRow)));
      } catch (error) {
        results.push(conditionFailed(b, c, error));
      }
    }
  }
  // An interrupt writes its own partial results and exits.
  if (interrupting) return;

  const { totals, mdPath, htmlPath, health } = writeRun(runDir, meta, results);
  LIVE.runDir = null;
  console.log('\n=== totals per condition ===');
  console.table(totals);
  const invalid = results.filter((r) => r.invalid);
  if (invalid.length) {
    console.log(`\n${invalid.length} invalid row(s), left out of the pass rates and sums above:`);
    for (const r of invalid) {
      console.log(
        `  ${r.condition}/${r.task}${r.rep ? ` (r${r.rep})` : ''}: ${r.invalid}` +
          (r.foreign_tools ? `, ${r.foreign_tools} call(s) to ${Object.keys(r.foreign_servers ?? {}).join(', ')}` : '')
      );
    }
  }
  console.log(`\n${healthLine(health, { dir: runDir })}`);
  for (const c of health.checks.filter((x) => x.status === 'FAIL')) console.log(`  FAIL ${c.id}: ${c.summary}`);
  console.log(`\nrun dir: ${runDir}\nreport:  ${mdPath}\nHTML:    ${htmlPath}`);

  const failed = results.filter((r) => !r.success || r.invalid).length;
  process.exitCode = failed ? 1 : 0;
  await awaitGridBrowsers();
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  if (LIVE.runDir && LIVE.rows.length) {
    try {
      writeRun(LIVE.runDir, { ...LIVE.meta, failed: error.message }, LIVE.rows);
      console.error(`${LIVE.rows.length} finished row(s) written to ${LIVE.runDir}`);
    } catch (writeError) {
      console.error(
        `could not write partial results: ${writeError.message}; rows.jsonl in ${LIVE.runDir} holds every finished row`
      );
    }
  }
  process.exit(1);
});
