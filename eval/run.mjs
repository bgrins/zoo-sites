// Browser tool-surface eval: run the same deterministic browser tasks through an
// agent backend against one or more MCP browser servers, and compare success,
// tokens, cost and duration. Identical tasks over identical fixtures mean a
// difference between two conditions comes from the surface, not the pages.
//
//   node run.mjs [options] — see --help for the full flag list.
//
// Suites: 'basic' = tiny smoke pages, 'web' = simulated sites; both are
// served locally from pages/ (no live web). --headed shows Firefox.
// Two conditions ship by default: 'firefox-devtools-mcp' and 'playwright-mcp'
// (the vendored @playwright/mcp). --mcp-command replaces the former with any
// stdio MCP server, and --conditions selects which run.
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
// afterwards, an allowlisted environment (agent-env.mjs), and a pinned tool
// policy per backend that each run's meta records.

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPagesServer } from '../server.mjs';
import { basicTasks } from './tasks/basic.mjs';
import { webTasks } from './tasks/web.mjs';
import { devtoolsTasks } from './tasks/devtools.mjs';
import { agentEnv, makeTempDir, removeAllTempDirs, removeTempDir } from './agent-env.mjs';
import { extractFields, extractorInfo, isSentinel } from './extract.mjs';
import { devtoolsMcpEntry, devtoolsMcpInfo, startMcpServer } from './mcp-stdio.mjs';
import { markdownReport, totalsByCondition } from './report.mjs';
import { transcriptName } from './run-files.mjs';
import { createReachRecorder, gradedValues, mintedValues } from './surface-reach.mjs';
import { detectScreen, windowGrid } from './window-grid.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// A bad flag is the user's typo, not a harness fault: one line, no stack.
function usage(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
// --mode key=value (repeatable): default server modes for every pages server
// in the run, e.g. --mode forgeDefect=cache-key --mode auctionDraw=decline to
// pin per-session draws for comparable repeats.
const RUN_MODES = {};
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === '--mode') {
    const eq = args[i + 1].indexOf('=');
    if (eq > 0) RUN_MODES[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
  }
}
// --seed <string>: deterministic difficulty draws across every site that
// mints one (auction rungs, forge variant and pads, schedule week, cabins
// calendar, depot shard and rejects, boxoffice plan, kanban board, calc
// defect, maze layout, metrics target, roles desk). Scope counters reset per
// task, so paired conditions and repeat runs face the same shapes.
// Identifier mints (codes, refs, nonces) stay on randomBytes regardless - a
// seeded run is reproducible, never forgeable.
const seedIdx = args.indexOf('--seed');
const RUN_SEED = seedIdx !== -1 ? args[seedIdx + 1] ?? null : null;
if (seedIdx !== -1 && (!RUN_SEED || RUN_SEED.startsWith('--'))) {
  usage('--seed requires a value');
}

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
const KNOWN_BACKENDS = ['anthropic', 'codex'];
const BACKEND_ARG = flag('backend', args.includes('--compare') && flag('compare', null) === 'backends' ? 'all' : 'anthropic');
const BACKEND_NAMES =
  BACKEND_ARG === 'all'
    ? KNOWN_BACKENDS
    : BACKEND_ARG.split(',').map((s) => s.trim()).filter(Boolean);
if (!BACKEND_NAMES.length) usage(`--backend names no backend (known: ${KNOWN_BACKENDS.join(', ')}, or all)`);
for (const name of BACKEND_NAMES) {
  if (!KNOWN_BACKENDS.includes(name)) {
    usage(`unknown backend "${name}" (known: ${KNOWN_BACKENDS.join(', ')}, or all)`);
  }
}
const BACKENDS = Object.fromEntries(
  await Promise.all(
    BACKEND_NAMES.map(async (name) => [name, await import(`./backends/${name}.mjs`)])
  )
);
// The package each backend drives, for the run's recorded versions.
const SDK_PACKAGES = { anthropic: '@anthropic-ai/claude-agent-sdk', codex: '@openai/codex-sdk' };
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
const modelFor = (name) => MODEL_BY_BACKEND[name] ?? MODEL_ALL ?? BACKENDS[name].DEFAULT_MODEL;
// Pin reasoning effort symmetrically across backends (Agent SDK `effort`,
// codex `model_reasoning_effort`); 'default' leaves each backend's own default.
// The backends accept different ladders, so a level must suit every backend in
// the run: codex has no 'max', the Agent SDK no 'minimal'.
const EFFORT = flag('effort', 'medium');
if (EFFORT !== 'default') {
  for (const name of BACKEND_NAMES) {
    const levels = BACKENDS[name].EFFORT_LEVELS;
    if (!levels.includes(EFFORT)) {
      usage(`--effort ${EFFORT} is not a level ${name} accepts (${levels.join('|')}, or default)`);
    }
  }
}
const REPEAT = numberFlag('repeat', 1, (n) => Number.isInteger(n) && n >= 1, 'a positive integer');
// --rerun-failed <run-dir> selects exactly the tasks that did not pass in an
// earlier run (failures AND errored rows), so a flaky run can be topped up
// without re-running everything or hand-copying ids out of a log. The earlier
// run's suite is the default, since its ids match nothing in another suite.
const RERUN_FAILED = flag('rerun-failed', null);
let RERUN_IDS = null;
let RERUN_SUITE = null;
if (RERUN_FAILED) {
  const priorPath = join(RERUN_FAILED.replace(/\/results\.json$/, ''), 'results.json');
  let prior;
  try {
    prior = JSON.parse(readFileSync(priorPath, 'utf8'));
  } catch (error) {
    usage(`--rerun-failed: cannot read ${priorPath}: ${error.message}`);
  }
  RERUN_SUITE = prior.meta?.suite ?? null;
  RERUN_IDS = [...new Set(prior.results.filter((r) => !r.success).map((r) => r.task))]
    .filter((id) => id && id !== '(condition)');
  if (!RERUN_IDS.length) {
    console.log(`--rerun-failed: every task passed in ${RERUN_FAILED}, nothing to do`);
    process.exit(0);
  }
  console.log(`--rerun-failed: ${RERUN_IDS.length} task(s) from ${RERUN_FAILED}: ${RERUN_IDS.join(', ')}`);
}
const SUITE = flag('suite', RERUN_SUITE ?? 'basic');
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
// Wall-clock budget tiers. Real work is not uniformly sized: a smoke page is
// seconds, a rate-limited or embargoed flow has an unavoidable floor, and a
// fog-of-war maze is long-horizon by design. A task declares `tier` and gets
// that cap; --max-wall overrides every tier when you want one number.
const WALL_TIERS = { quick: 180, standard: 600, long: 1800, epic: 5400 };
const DEFAULT_TIER = 'standard';
const MAX_WALL_OVERRIDE = numberFlag(
  'max-wall', 0, (n) => Number.isFinite(n) && n > 0, 'a positive number of seconds'
);
const wallCapFor = (task) =>
  MAX_WALL_OVERRIDE || WALL_TIERS[task?.tier ?? DEFAULT_TIER];
const MAX_OUTPUT = numberFlag(
  'max-output', 0, (n) => Number.isInteger(n) && n >= 0, 'a non-negative integer (0 = off)'
);
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
  --rerun-failed <dir>    select exactly the tasks that failed or errored in an
                          earlier run dir (reads its results.json; overrides
                          --task) — for topping up a run that hit flaky errors

Reporting:
  --report-from <dir>     rewrite report.md from a finished run's results.json
                          and exit; runs no agents, so reporting changes can be
                          applied to runs you already paid for

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
                          (default: both — @mozilla/firefox-devtools-mcp and
                          the vendored @playwright/mcp, both over stdio driving
                          their own Firefox. --mcp-command replaces the former)
  --mode <key=value>      pin a server mode for every task in the run
                          (repeatable), e.g. --mode forgeDefect=cache-key
                          --mode auctionDraw=decline for comparable repeats
  --seed <string>         deterministic difficulty draws (auction rungs, forge
                          variant and pads, schedule week): paired conditions
                          and repeats face the same shapes. Codes and refs
                          stay random - seeded runs are never forgeable
  --mcp-command "<cmd>"   custom stdio MCP server for the firefox-devtools-mcp
                          condition, e.g.
                          "npx @playwright/mcp@latest --browser firefox";
                          replaces the built-in firefox-devtools-mcp server

Execution:
  --parallel              run conditions concurrently
  --parallel-tasks <n>    run up to n tasks concurrently within each condition
                          (each worker gets its own browser + pages server;
                          wall timings gain contention noise)
  --help                  show this help

Before any paid work, each condition's MCP server is started once and must list
its tools; the run aborts if one cannot.

Results land in results/run-<timestamp>/ (gitignored): results.json,
report.md (shareable), and transcripts/*.jsonl (full agent message streams,
one per attempt). An interrupt (Ctrl-C, SIGTERM) stops the agents, waits up to
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
// Tasks-within-a-condition concurrency; each worker gets an isolated env (own
// pages server and state dir), and every agent launches its own browser through
// its own MCP server.
const PARALLEL_TASKS = numberFlag(
  'parallel-tasks', 1, (n) => Number.isInteger(n) && n >= 1, 'a positive integer'
);
// Swap in any stdio MCP server (e.g. a different build) as the
// firefox-devtools-mcp condition.
// Naive whitespace split; quote-free commands only.
const MCP_COMMAND = flag('mcp-command', null);
const CUSTOM_MCP = MCP_COMMAND ? MCP_COMMAND.trim().split(/\s+/) : null;

// Named conditions. 'playwright-mcp' spawns the vendored @playwright/mcp over
// stdio (registered under the same 'firefox' server name) driving Playwright's
// own Firefox build.
// --compare pins one axis so a run is attributable. Varying the browser tool
// surface AND the agent harness at once yields a 2x2 whose differences cannot be
// assigned to either, which is the easiest mistake to make here.
const COMPARE = flag('compare', null);
if (COMPARE && !['surfaces', 'backends'].includes(COMPARE)) {
  usage(`--compare must be surfaces or backends, got "${COMPARE}"`);
}

const KNOWN_CONDITIONS = ['firefox-devtools-mcp', 'playwright-mcp'];
const CONDITIONS = flag(
  'conditions',
  COMPARE === 'backends' ? 'firefox-devtools-mcp' : 'firefox-devtools-mcp,playwright-mcp'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const c of CONDITIONS) {
  if (!KNOWN_CONDITIONS.includes(c)) {
    usage(`unknown condition "${c}" (known: ${KNOWN_CONDITIONS.join(', ')})`);
  }
}
if (BACKEND_NAMES.length > 1 && CONDITIONS.length > 1) {
  console.log(
    `warning: this run varies BOTH axes (${BACKEND_NAMES.length} harnesses x ` +
      `${CONDITIONS.length} tool surfaces). Differences cannot be attributed to ` +
      `either. Use --compare surfaces or --compare backends to pin one.\n`
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

// Every condition gets a shell, so the only difference between conditions
// is how the browser is driven rather than whether a shell exists at all.
const SHELL_NOTE = `You also have a shell (Bash) for anything else you find useful.
It has no browser-automation command in it — the MCP tools are how you drive the page.`;

// Identical for every condition: the comparison of interest is
// firefox-devtools-mcp vs playwright-mcp, so the prompt must not differ by so
// much as a word between them. It carries no strategy advice.
const MCP_INTRO = `You control a web browser via the connected "firefox" MCP tools.
${SHELL_NOTE}`;

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

function mcpStdioFor(condition, ctx) {
  if (condition === 'playwright-mcp') {
    return {
      command: process.execPath,
      args: [
        PLAYWRIGHT_MCP_CLI,
        '--browser',
        'firefox',
        '--isolated',
        ...(HEADED ? [] : ['--headless']),
      ],
    };
  }
  if (condition === 'firefox-devtools-mcp') {
    return CUSTOM_MCP
      ? { command: CUSTOM_MCP[0], args: CUSTOM_MCP.slice(1) }
      : {
          command: process.execPath,
          args: [
            // One resolver, shared with verify: FIREFOX_DEVTOOLS_MCP for a local
            // checkout, otherwise the @mozilla/firefox-devtools-mcp dependency.
            devtoolsMcpEntry(),
            '--enable-script',
            ...(HEADED ? [] : ['--headless']),
            ...(ctx.stdioProfile ? ['--profile-path', ctx.stdioProfile] : []),
          ],
        };
  }
  return null;
}

// Free checks before any paid work. A crashing --mcp-command, or a server that
// needs a variable the environment allowlist drops, otherwise leaves every
// agent with only Bash, and the run grades that as the surface. The server gets
// the agents' environment and an empty cwd; listing tools launches no browser.
async function preflight() {
  for (const condition of CONDITIONS) {
    const dir = makeTempDir('zoo-eval-preflight-');
    let server;
    try {
      const spec = mcpStdioFor(condition, {});
      server = await startMcpServer({
        command: spec.command,
        args: spec.args,
        baseEnv: agentEnv(null),
        cwd: dir,
      });
      const { tools } = await server.listTools();
      if (!tools?.length) throw new Error('the server listed no tools');
      console.log(`(preflight: ${condition} lists ${tools.length} tools)`);
    } catch (error) {
      throw new Error(
        `preflight: the ${condition} MCP server did not start and list its tools, ` +
          `so no agent ran:\n${error.message}`
      );
    } finally {
      await server?.close();
      removeTempDir(dir);
    }
  }
  if (BACKENDS.codex) {
    const home = BACKENDS.codex.isolatedCodexHome(agentEnv('codex'));
    const hasLogin = home.hasLogin;
    home.close();
    if (!hasLogin) {
      throw new Error(
        'preflight: codex has no login to run with: no auth.json in CODEX_HOME ' +
          '(~/.codex) and no CODEX_API_KEY or OPENAI_API_KEY'
      );
    }
  }
}

// Every running attempt's stop function, so an interrupt can end the agents.
const ACTIVE_STOPS = new Set();

async function runTask(backendName, condition, label, task, ctx, rep = 1, attempt = 0) {
  const backend = BACKENDS[backendName];
  const mcpStdio = mcpStdioFor(condition, ctx);
  // A fresh working directory per attempt: stored runs showed two parallel
  // agents writing the same file in one shared dir, and repeats reusing the
  // scripts an earlier task left there.
  const attemptDir = makeTempDir('zoo-eval-attempt-');
  const spec = {
    prompt: taskPrompt(task),
    model: modelFor(backendName),
    effort: EFFORT === 'default' ? null : EFFORT,
    condition,
    cwd: attemptDir,
    mcpStdio,
    env: agentEnv(backendName),
  };
  // Stream the raw agent transcript (thinking, tool calls, results) to disk
  // as it happens rather than buffering.
  const transcript = transcriptName({
    label,
    task: task.id,
    rep: REPEAT > 1 ? rep : null,
    attempt: attempt + 1,
  });
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
  spec.onMessage = (message) => {
    reach.observe(message);
    if (transcriptStream) transcriptStream.write(JSON.stringify(message) + '\n');
  };
  // Runaway guards. There is deliberately no turn limit: a "turn" means
  // different things per backend (codex only approximates one), so turns are
  // neither a fair metric nor a usable safety net. Wall time and output
  // tokens are.
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

  const wallStart = Date.now();
  let r;
  try {
    r = await backend.run(spec);
  } catch (error) {
    // A discarded attempt still cost real tokens: the backend hangs what it
    // could measure on the throw as `spend`, so the retry loop records it
    // instead of losing it from every total.
    const spend = error?.spend ?? { unknown: true };
    const failed = limitHit
      ? new Error(`stopped by harness ${limitHit}`)
      : error instanceof Error
        ? error
        : new Error(String(error));
    if (limitHit) failed.harnessStop = true;
    failed.spend = spend;
    failed.transcript = transcript;
    throw failed;
  } finally {
    clearTimeout(wallTimer);
    ACTIVE_STOPS.delete(stopFor);
    transcriptStream?.end();
    removeTempDir(attemptDir);
  }
  const wallMs = Date.now() - wallStart;
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
      ...extra,
    });
  // A run that finished past the cap fails like one stopped at it. Codex
  // reports usage only when a run ends, so for codex this is the only check.
  if (MAX_OUTPUT && r.output_tokens > MAX_OUTPUT) {
    throw discard(`stopped by harness output-token limit ${MAX_OUTPUT} (spent ${r.output_tokens})`, {
      harnessStop: true,
    });
  }
  // An API failure ("API Error: 529 ...") arrives as a result whose text is the
  // error. A transient one is thrown, so the retry loop reruns it and marks it
  // infra when it persists; any other stays the agent's graded answer.
  if (r.result_error && TRANSIENT.test(r.result_error)) throw discard(r.result_error);
  // Structured answer extraction (docs/grading-design.md): condition-
  // blind, post-hoc, quote-gated. Usage is recorded on the row but NEVER summed
  // into the per-condition metrics; wall_s already brackets only backend.run.
  // A sentinel answer skips the call: all-null fields must fail, not a model's
  // reading of an error marker.
  let fields = null;
  let extraction = null;
  let extractionFailed = null;
  if (task.answerSchema && !isSentinel(r.text)) {
    let lastError;
    for (let attempt = 0; attempt < 3 && !extraction; attempt++) {
      try {
        ({ fields, extraction } = await extractFields({
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
  // page, and the codes the server minted say whether the truth was ever shown
  // at all. Only the shortfalls are recorded - a row listing everything the
  // agent could see would dwarf the row itself.
  const surface = (() => {
    const states = reach.reach([
      ...gradedValues(fields ?? {}),
      ...mintedValues(ctx.pages?.state ?? {}),
    ]);
    const truncated = Object.keys(states).filter((v) => states[v] === 'truncated');
    const absent = Object.keys(states).filter((v) => states[v] === 'absent');
    if (!truncated.length && !absent.length) return null;
    const clip = (list) => list.slice(0, 8).map((v) => v.slice(0, 80));
    return {
      ...(truncated.length ? { truncated: clip(truncated) } : {}),
      ...(absent.length ? { absent: clip(absent) } : {}),
    };
  })();
  const tenth = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);
  return {
    backend: backendName,
    condition: label,
    task: task.id,
    ...(REPEAT > 1 ? { rep } : {}),
    model: modelFor(backendName) || '(backend default)',
    success: verdict.pass,
    detail: verdict.detail,
    ...(validatorError ? { validator_error: validatorError } : {}),
    // Absent alone is ambiguous (a derived total was never printed either), but
    // truncated is not: it means the page rendered the value and the surface cut it.
    ...(surface ? { surface } : {}),
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
    // Grading evidence for schema tasks; excluded from every condition total.
    // The verbatim answer rides along so the row is self-contained: fields are
    // what graded, answer_full is what the agent actually said.
    ...(task.answerSchema
      ? { grading: 'fields', fields, extraction, answer_full: r.text }
      : {}),
    ...(extractionFailed ? { extraction_failed: extractionFailed } : {}),
    ...(ctx.transcriptsDir ? { transcript } : {}),
  };
}

// The devtools suite (T120-T124): same task shape as webTasks, graded against
// the same fixture server. Kept out of 'web' (see below); 'all' includes it.
async function buildTasks(base) {
  let tasks = [];
  if (SUITE === 'basic' || SUITE === 'all') {
    tasks.push(...basicTasks(base));
  }
  if (SUITE === 'web' || SUITE === 'all') {
    tasks.push(...(await webTasks(base)));
  }
  // Devtools-surface tasks live in their OWN suite by owner decision: the
  // primary comparison is web-agent flows, and a console/network task mixed
  // into the web sweep would skew its totals. 'all' includes them.
  if (SUITE === 'devtools' || SUITE === 'all') {
    tasks.push(...(await devtoolsTasks(base)));
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
const POSITIONABLE = CONDITIONS.filter((c) => c === 'firefox-devtools-mcp');
const TOTAL_SLOTS = BACKEND_NAMES.length * POSITIONABLE.length * PARALLEL_TASKS;
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

// One isolated execution environment: pages server + state dir. Sequential
// runs use one env per condition; --parallel-tasks uses one per worker. Every
// live env is tracked so an interrupt removes temp dirs instead of leaking
// them (agents spawn their own MCP servers as children, which die with us).
const ACTIVE_ENVS = new Set();
// The run in progress, so an interrupt or a crash can still write every row
// that finished.
const LIVE = { runDir: null, meta: null, rows: [] };
// Every row still being produced, so an interrupt can wait for the rows of the
// attempts it stopped: they carry what those attempts spent.
const SETTLING = new Set();
let interrupting = false;

function writeRun(runDir, meta, results) {
  const totals = totalsByCondition(results);
  const jsonPath = join(runDir, 'results.json');
  const mdPath = join(runDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify({ meta, results, totals }, null, 2));
  writeFileSync(mdPath, markdownReport({ meta, results, totals }));
  return { totals, jsonPath, mdPath };
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

async function makeEnv(backendName, condition, label, workerIndex = 0) {
  // Each env gets its own pages server so validator state (sessions/beacons)
  // never mixes across concurrent agents.
  const pages = await startPagesServer({ modes: RUN_MODES, seed: RUN_SEED });
  const stateDir = makeTempDir(`zoo-eval-${condition}-`);
  // Seed window geometry so headed windows tile into their grid cell
  // (stdio MCP servers launch their own Firefox and get it via --profile-path).
  const stdioProfile =
    GRID && POSITIONABLE.includes(condition)
      ? GRID.seed(stateDir, slotFor(backendName, condition, workerIndex))
      : null;
  const env = {
    pages,
    stateDir,
    stdioProfile,
    async close() {
      ACTIVE_ENVS.delete(env);
      await pages.close();
      removeTempDir(stateDir);
    },
  };
  ACTIVE_ENVS.add(env);
  return env;
}

// `onRow` sees each row as it finishes, for the partial results an interrupt
// writes; the return value is every row in suite order.
async function runCondition(backendName, condition, shared, onRow) {
  const label = labelFor(backendName, condition);
  console.log(`[${label}] starting (model: ${modelFor(backendName) || '(backend default)'})`);

  async function runOne(env, item) {
    // Task asks embed the env's pages URL, so rebuild against this env.
    const task = (await buildTasks(env.pages.url)).find((t) => t.id === item.id);
    const tag = REPEAT > 1 ? `${item.id} (r${item.rep})` : item.id;
    // Every failed attempt's spend. `unknown` counts attempts whose backend
    // could not say what they spent (codex reports usage only at turn end).
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
          stateDir: env.stateDir,
          pages: env.pages,
          stdioProfile: env.stdioProfile,
        };
        const r = await runTask(backendName, condition, label, task, ctx, item.rep, attempt);
        console.log(
          `[${label}] ${tag}: ${r.success ? 'PASS' : 'FAIL'} turns=${r.turns} ` +
            `in=${r.input_tokens} cacheW=${r.cache_creation} cacheR=${r.cache_read} ` +
            `out=${r.output_tokens} $${r.cost_usd?.toFixed?.(4) ?? '?'} ` +
            `wall=${r.wall_s}s api=${r.api_s ?? '?'}s` +
            (r.detail ? ` (${r.detail})` : '') +
            (attempt ? ` [after ${attempt} retry]` : '')
        );
        return { ...r, ...(attempt ? { retries: attempt } : {}), ...discardedFields() };
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
          ...(infra ? { infra: true } : {}),
          ...(attempt ? { retries: attempt } : {}),
          ...discardedFields(),
          ...(error?.transcript ? { transcript: error.transcript } : {}),
        });
      }
    }
  }
  const settle = (env, item) => {
    const settled = (async () => {
      let row;
      try {
        row = await runOne(env, item);
      } catch (error) {
        row = errorRow({ backend: backendName, label, task: item.id, rep: item.rep, error });
      }
      onRow(row);
      return row;
    })();
    SETTLING.add(settled);
    settled.finally(() => SETTLING.delete(settled));
    return settled;
  };

  const items = (await buildTasks('http://placeholder')).flatMap((t) =>
    Array.from({ length: REPEAT }, (_, i) => ({ id: t.id, rep: i + 1 }))
  );
  if (PARALLEL_TASKS > 1) {
    const queue = [...items];
    const done = new Map();
    const keyOf = (item) => `${item.id}#${item.rep}`;
    const workerCount = Math.min(PARALLEL_TASKS, queue.length);
    const startErrors = [];
    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerIndex) => {
        // A worker that cannot start or a task that escapes runOne must not
        // sink the pool: completed rows stay, the failure becomes its row.
        let env;
        try {
          env = await makeEnv(backendName, condition, label, workerIndex);
        } catch (error) {
          console.error(`[${label}] worker ${workerIndex} could not start: ${error.message}`);
          startErrors.push(error);
          return;
        }
        try {
          while (queue.length && !interrupting) {
            const item = queue.shift();
            done.set(keyOf(item), await settle(env, item));
          }
        } finally {
          await env.close().catch(() => {});
        }
      })
    );
    // A task an interrupt kept from starting gets no row, as in a sequential run.
    if (!interrupting) {
      for (const item of queue) {
        const why = startErrors[0]?.message ?? 'unknown';
        const row = errorRow({
          backend: backendName, label, task: item.id, rep: item.rep, error: `no worker started: ${why}`,
        });
        onRow(row);
        done.set(keyOf(item), row);
      }
    }
    return items.map((item) => done.get(keyOf(item))).filter(Boolean);
  }

  const env = await makeEnv(backendName, condition, label);
  try {
    const results = [];
    for (const item of items) {
      if (interrupting) break;
      results.push(await settle(env, item));
    }
    return results;
  } finally {
    await env.close().catch(() => {});
  }
}

// The commit and dirty flag of a git work tree, read now rather than whenever
// the run is later bundled.
function gitState(dir) {
  const git = (gitArgs) => {
    const r = spawnSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const status = git(['status', '--porcelain']);
  return { commit: git(['rev-parse', 'HEAD']), dirty: status == null ? null : status !== '' };
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
function buildMeta(startedAt) {
  return {
    date: startedAt.toISOString(),
    backend: BACKEND_NAMES.join(','),
    models: Object.fromEntries(
      BACKEND_NAMES.map((n) => [n, modelFor(n) || '(backend default)'])
    ),
    effort: EFFORT,
    suite: SUITE,
    task: ONLY_TASK ?? undefined,
    rerunFailed: RERUN_FAILED ?? undefined,
    repeat: REPEAT > 1 ? REPEAT : undefined,
    conditions: CONDITIONS.join(','),
    mcpCommand: MCP_COMMAND ?? undefined,
    parallel: PARALLEL || undefined,
    parallelTasks: PARALLEL_TASKS > 1 ? PARALLEL_TASKS : undefined,
    seed: RUN_SEED ?? undefined,
    modes: Object.keys(RUN_MODES).length ? RUN_MODES : undefined,
    retries: RETRIES,
    maxWall: MAX_WALL_OVERRIDE || undefined,
    wallTiers: WALL_TIERS,
    maxOutput: MAX_OUTPUT || undefined,
    extractor: extractorInfo(),
    git: gitState(join(here, '..')),
    surfaces: Object.fromEntries(
      CONDITIONS.map((c) => [
        c,
        c === 'playwright-mcp'
          ? { source: 'dependency', version: packageVersion('@playwright/mcp') }
          : MCP_COMMAND
            ? { source: '--mcp-command', command: MCP_COMMAND }
            : devtoolsMcpInfo(),
      ])
    ),
    sdks: Object.fromEntries(BACKEND_NAMES.map((n) => [n, packageVersion(SDK_PACKAGES[n])])),
    isolation: {
      scratch: 'fresh directory per attempt',
      env: Object.fromEntries(BACKEND_NAMES.map((n) => [n, Object.keys(agentEnv(n)).sort()])),
      toolPolicy: Object.fromEntries(BACKEND_NAMES.map((n) => [n, BACKENDS[n].TOOL_POLICY])),
    },
    node: process.version,
  };
}

async function main() {
  if (REPORT_FROM) {
    const dir = REPORT_FROM.replace(/\/results\.json$/, '');
    const prior = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    const totals = totalsByCondition(prior.results);
    const path = join(dir, 'report.md');
    writeFileSync(path, markdownReport({ ...prior, totals }));
    console.log(`rewrote ${path} (${prior.results.length} rows)`);
    return;
  }
  const selected = await buildTasks('http://placeholder');
  if (!selected.length) {
    throw new Error(`no tasks selected (suite=${SUITE}, task=${ONLY_TASK})`);
  }
  if (LIST_TASKS) {
    console.log(
      selected
        .map((t) => `${t.id}  [${t.tier ?? DEFAULT_TIER}, cap ${wallCapFor(t)}s]`)
        .join('\n')
    );
    console.log(`\n${selected.length} task(s) selected from suite '${SUITE}'`);
    return;
  }
  if (MAX_OUTPUT && BACKENDS.codex) {
    console.log(
      'note: codex reports output tokens only when a run ends, so --max-output ' +
        'fails an over-cap codex run then instead of stopping it\n'
    );
  }

  await preflight();

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const runDir = join(here, 'results', `run-${stamp}`);
  const transcriptsDir = join(runDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const meta = buildMeta(startedAt);
  Object.assign(LIVE, { runDir, meta, rows: [] });
  const shared = { transcriptsDir };
  const onRow = (row) => LIVE.rows.push(row);

  if (CONDITIONS.includes('playwright-mcp')) {
    await ensurePlaywrightFirefox();
  }
  if (HEADED) {
    GRID = windowGrid(TOTAL_SLOTS, detectScreen(flag('screen', null)));
  }

  const runs = BACKEND_NAMES.flatMap((backendName) =>
    CONDITIONS.map((condition) => [backendName, condition])
  );
  // One condition's failure (a pages server or env that would not start) must
  // not discard the rows every other condition produced.
  const conditionFailed = (b, c, reason) => {
    console.error(`[${labelFor(b, c)}] condition failed: ${reason?.message ?? reason}`);
    const row = errorRow({ backend: b, label: labelFor(b, c), task: '(condition)', error: reason });
    onRow(row);
    return row;
  };
  let results = [];
  if (PARALLEL) {
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

  const { totals, mdPath } = writeRun(runDir, meta, results);
  LIVE.runDir = null;
  console.log('\n=== totals per condition ===');
  console.table(totals);
  console.log(`\nrun dir: ${runDir}\nreport:  ${mdPath}`);

  const failed = results.filter((r) => !r.success).length;
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  if (LIVE.runDir && LIVE.rows.length) {
    try {
      writeRun(LIVE.runDir, { ...LIVE.meta, failed: error.message }, LIVE.rows);
      console.error(`${LIVE.rows.length} finished row(s) written to ${LIVE.runDir}`);
    } catch {}
  }
  process.exit(1);
});
