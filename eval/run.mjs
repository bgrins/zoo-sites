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
//   node run.mjs --suite web --rerun-failed results/run-<stamp>
//     top up a run that hit flaky failures, without repeating the passes
//   node scripts/transcript.mjs [run-dir] [--task <id>]
//     inspect what the agents actually did
//
// Runaway protection is a per-task wall-clock tier (quick/standard/long/epic,
// see WALL_TIERS; --max-wall overrides all of them) plus --max-output. There is
// deliberately no turn limit, and turns should not be compared across
// conditions or backends (see markdownReport's note).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPagesServer } from '../server.mjs';
import { basicTasks } from './tasks/basic.mjs';
import { webTasks } from './tasks/web.mjs';
import { devtoolsTasks } from './tasks/devtools.mjs';
import { extractFields, isSentinel } from './extract.mjs';
import { devtoolsMcpEntry } from './mcp-stdio.mjs';
import { createReachRecorder, gradedValues, mintedValues } from './surface-reach.mjs';
import { detectScreen, windowGrid } from './window-grid.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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
  throw new Error('--seed requires a value');
}

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
};
const BACKEND_ARG = flag('backend', args.includes('--compare') && flag('compare', null) === 'backends' ? 'all' : 'anthropic');
const BACKEND_NAMES =
  BACKEND_ARG === 'all' ? ['anthropic', 'codex'] : BACKEND_ARG.split(',');
const BACKENDS = Object.fromEntries(
  await Promise.all(
    BACKEND_NAMES.map(async (name) => [name, await import(`./backends/${name}.mjs`)])
  )
);
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
    throw new Error('--model requires a value');
  }
  const eq = value.indexOf('=');
  if (eq <= 0) {
    if (MODEL_ALL) throw new Error('--model was given twice without a backend prefix');
    MODEL_ALL = value;
    continue;
  }
  const name = value.slice(0, eq);
  const id = value.slice(eq + 1);
  if (!id) throw new Error(`--model ${value} names no model`);
  if (!BACKEND_NAMES.includes(name)) {
    throw new Error(
      `--model ${value}: "${name}" is not a backend in this run (${BACKEND_NAMES.join(', ')})`
    );
  }
  if (MODEL_BY_BACKEND[name]) {
    throw new Error(`--model set twice for backend "${name}"`);
  }
  MODEL_BY_BACKEND[name] = id;
}
if (MODEL_ALL && Object.keys(MODEL_BY_BACKEND).length) {
  throw new Error(
    '--model takes either one id or <backend>=<id> per backend, not both forms in one run'
  );
}
if (MODEL_ALL && BACKEND_NAMES.length > 1) {
  throw new Error(
    'a bare --model cannot be combined with multiple backends; pin each one with ' +
      `--model <backend>=<id> (${BACKEND_NAMES.join(', ')})`
  );
}
const modelFor = (name) => MODEL_BY_BACKEND[name] ?? MODEL_ALL ?? BACKENDS[name].DEFAULT_MODEL;
// Pin reasoning effort symmetrically across backends (Agent SDK `effort`,
// codex `model_reasoning_effort`); 'default' leaves each backend's own default.
const EFFORT = flag('effort', 'medium');
if (!['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(EFFORT)) {
  throw new Error(`--effort must be default|low|medium|high|xhigh|max, got "${EFFORT}"`);
}
const REPEAT = Number(flag('repeat', '1'));
if (!Number.isInteger(REPEAT) || REPEAT < 1) {
  throw new Error('--repeat must be a positive integer');
}
const SUITE = flag('suite', 'basic');
// --task takes a comma list of ids, each optionally using * as a wildcard, so a
// few tasks can be run without the whole suite:
//   --task ledger-sum                     one task
//   --task cart-math,coupon-stack         several
//   --task 'ledger-*,crm-join'            wildcard plus an exact id
const ONLY_TASK = flag('task', null);
// --rerun-failed <run-dir> selects exactly the tasks that did not pass in an
// earlier run (failures AND errored rows), so a flaky run can be topped up
// without re-running everything or hand-copying ids out of a log.
const RERUN_FAILED = flag('rerun-failed', null);
let RERUN_IDS = null;
if (RERUN_FAILED) {
  const prior = JSON.parse(
    readFileSync(join(RERUN_FAILED.replace(/\/results\.json$/, ''), 'results.json'), 'utf8')
  );
  RERUN_IDS = [...new Set(prior.results.filter((r) => !r.success).map((r) => r.task))]
    .filter((id) => id && id !== '(condition)');
  if (!RERUN_IDS.length) {
    console.log(`--rerun-failed: every task passed in ${RERUN_FAILED}, nothing to do`);
    process.exit(0);
  }
  console.log(`--rerun-failed: ${RERUN_IDS.length} task(s) from ${RERUN_FAILED}: ${RERUN_IDS.join(', ')}`);
}
const TASK_PATTERNS = RERUN_IDS
  ? RERUN_IDS
  : ONLY_TASK
    ? ONLY_TASK.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
const LIST_TASKS = args.includes('--list-tasks');
// Re-render report.md from a finished run's results.json, so a reporting change
// can be applied to runs that already cost money to produce.
const REPORT_FROM = flag('report-from', null);
// API/infrastructure hiccups (dropped connections, overload, 5xx) otherwise land
// as ERROR rows that look like task failures and poison a whole run's numbers.
// Retries re-run the task from scratch against freshly reset server state.
// Wall-clock budget tiers. Real work is not uniformly sized: a smoke page is
// seconds, a rate-limited or embargoed flow has an unavoidable floor, and a
// fog-of-war maze is long-horizon by design. A task declares `tier` and gets
// that cap; --max-wall overrides every tier when you want one number.
const WALL_TIERS = { quick: 180, standard: 600, long: 1800, epic: 5400 };
const DEFAULT_TIER = 'standard';
const MAX_WALL_OVERRIDE = Number(flag('max-wall', '0')) || 0;
const wallCapFor = (task) =>
  MAX_WALL_OVERRIDE || WALL_TIERS[task?.tier ?? DEFAULT_TIER];
const MAX_OUTPUT = Number(flag('max-output', '0')) || 0;
const RETRIES = Number(flag('retries', '2'));
if (!Number.isInteger(RETRIES) || RETRIES < 0) {
  throw new Error('--retries must be a non-negative integer');
}
const TRANSIENT = /connection closed|connection error|econnreset|epipe|etimedout|socket hang up|overloaded|rate.?limit|too many requests|\b(429|500|502|503|504|529)\b|internal server error|service unavailable/i;
function isTransient(error) {
  const message = String(error?.message ?? '');
  // A wall-limit stop is usually infra slowness, so it is worth retrying; an
  // output-token stop means the agent itself ran away, so it is not.
  if (/output-token limit/i.test(message)) return false;
  if (/wall limit/i.test(message)) return true;
  return TRANSIENT.test(message);
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
  --suite <name>          basic|web|devtools|all (default: basic; web = the
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
  --max-output <n>        kill a task after n cumulative output tokens (0 = off)
  --repeat <n>            run each task n times; the report gains a per-task
                          median (min-max) table and flags tasks whose output
                          tokens vary by more than 2x between repeats

Conditions and models:
  --model <id>            model for the run's backend; with several backends
                          use <backend>=<id> instead, repeatable, e.g.
                            --model codex=gpt-5.6-luna
                            --model codex=gpt-5.6-luna --model anthropic=claude-sonnet-5
                          A backend left unnamed keeps its own default.
  --effort <level>        reasoning effort for both backends (default: medium;
                          'default' = leave backend defaults)
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

Results land in results/run-<timestamp>/ (gitignored): results.json,
report.md (shareable), and transcripts/*.jsonl (full agent message streams).
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
// Tasks-within-a-condition concurrency; each worker gets an isolated env
// (own pages server, state dir, and browser where the condition shares one).
const PARALLEL_TASKS = Number(flag('parallel-tasks', '1'));
if (!Number.isInteger(PARALLEL_TASKS) || PARALLEL_TASKS < 1) {
  throw new Error(`--parallel-tasks must be a positive integer`);
}
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
  throw new Error(`--compare must be surfaces or backends, got "${COMPARE}"`);
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
    throw new Error(`unknown condition "${c}" (known: ${KNOWN_CONDITIONS.join(', ')})`);
  }
}
if (BACKEND_NAMES.length > 1 && CONDITIONS.length > 1) {
  console.log(
    `warning: this run varies BOTH axes (${BACKEND_NAMES.length} harnesses x ` +
      `${CONDITIONS.length} tool surfaces). Differences cannot be attributed to ` +
      `either. Use --compare surfaces or --compare backends to pin one.\n`
  );
}

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

function taskPrompt(condition, task) {
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

async function runTask(backendName, condition, label, task, ctx, rep = 1, attempt = 0) {
  const backend = BACKENDS[backendName];
  const spec = {
    prompt: taskPrompt(condition, task),
    model: modelFor(backendName),
    effort: EFFORT === 'default' ? null : EFFORT,
    condition,
    cwd: ctx.scratchDir,
    mcpStdio: mcpStdioFor(condition, ctx),
    env: { ...process.env },
  };
  // Stream the raw agent transcript (thinking, tool calls, results) to disk
  // as it happens rather than buffering.
  let transcriptStream = null;
  if (ctx.transcriptsDir) {
    transcriptStream = createWriteStream(
      join(
        ctx.transcriptsDir,
        `${label.replace('/', '--')}--${task.id}${rep > 1 ? `--r${rep}` : ''}` +
          `${attempt > 0 ? `--a${attempt + 1}` : ''}.jsonl`
      )
    );
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
  const capS = wallCapFor(task);
  const wallTimer = capS
    ? setTimeout(() => stopFor(`wall limit ${capS}s (tier ${task.tier ?? DEFAULT_TIER})`), capS * 1000)
    : null;
  const userOnMessage = spec.onMessage;
  spec.onMessage = (message) => {
    userOnMessage?.(message);
    const usage = message?.message?.usage ?? message?.usage;
    if (usage?.output_tokens) spent += usage.output_tokens;
    if (MAX_OUTPUT && spent > MAX_OUTPUT) {
      stopFor(`output-token limit ${MAX_OUTPUT} (spent ${spent})`);
    }
  };

  const wallStart = Date.now();
  // A discarded attempt still cost real tokens: hang them on the throw so the
  // retry loop can record the spend instead of losing it from every total.
  const stopped = (r) => {
    const error = new Error(`stopped by harness ${limitHit}`);
    error.discarded = r
      ? { cost_usd: r.cost_usd ?? 0, output_tokens: r.output_tokens ?? 0 }
      : { cost_usd: 0, output_tokens: spent };
    return error;
  };
  let r;
  try {
    r = await backend.run(spec);
  } catch (error) {
    if (limitHit) throw stopped(null);
    throw error;
  } finally {
    clearTimeout(wallTimer);
    transcriptStream?.end();
  }
  if (limitHit) throw stopped(r);
  const wallMs = Date.now() - wallStart;
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
  const verdict = task.validate
    ? task.validate(r.text, ctx, fields)
    : { pass: task.expect.test(r.text.replace(/[*_~`]+/g, '')) };
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
  };
}

function totalsByCondition(results) {
  const totals = {};
  for (const r of results) {
    const t = (totals[r.condition] ??= {
      tasks: 0, passed: 0, infra: 0, turns: 0, input_tokens: 0, cache_creation: 0,
      cache_read: 0, output_tokens: 0, cost_usd: 0, duration_s: 0, api_s: 0, wall_s: 0,
    });
    // `tasks` counts GRADED attempts, so a pass rate never charges the agent for
    // an infra error. Token and cost sums still take every row, because tokens an
    // infra row spent were really spent.
    if (r.infra) t.infra++;
    else t.tasks++;
    t.passed += r.success ? 1 : 0;
    for (const key of ['turns', 'input_tokens', 'cache_creation', 'cache_read', 'output_tokens', 'cost_usd', 'duration_s', 'api_s', 'wall_s']) {
      t[key] += r[key] ?? 0;
    }
    t.cost_known ||= r.cost_usd != null;
  }
  for (const t of Object.values(totals)) {
    t.cost_usd = t.cost_known ? Math.round(t.cost_usd * 10000) / 10000 : null;
    delete t.cost_known;
    for (const key of ['duration_s', 'api_s', 'wall_s']) {
      t[key] = Math.round(t[key] * 10) / 10;
    }
  }
  return totals;
}

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// "12 (11-33)" — median plus the observed range, so an unstable task is visible
// at a glance instead of hiding behind its median. spread = max/min on output
// tokens, the metric least polluted by machine contention.
function spanOf(values, digits = 0) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return '';
  const fmt = (x) => (digits ? x.toFixed(digits) : String(Math.round(x)));
  const med = median(v);
  if (v.length === 1 || v[0] === v.at(-1)) return fmt(med);
  return `${fmt(med)} (${fmt(v[0])}-${fmt(v.at(-1))})`;
}

function medianLines(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.condition}|${r.task}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const lines = [
    '',
    '## Per-task medians across repeats',
    '',
    'Each cell is `median (min-max)`. `spread` is max/min output tokens: >2 means',
    'a single sample of that task is not trustworthy.',
    '',
    '| condition | task | pass | turns | output | cost (USD) | wall (s) | api (s) | spread |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [key, rs] of groups) {
    const [condition, task] = key.split('|');
    const graded = rs.filter((r) => !r.infra);
    const passed = graded.filter((r) => r.success).length;
    const outs = rs.map((r) => r.output_tokens).filter((x) => x != null);
    const lo = Math.min(...outs);
    const spread = outs.length > 1 && lo > 0 ? (Math.max(...outs) / lo).toFixed(1) + 'x' : '';
    lines.push(
      `| ${condition} | ${task} | ${passed}/${graded.length}` +
        `${rs.length > graded.length ? ` (+${rs.length - graded.length} infra)` : ''} | ` +
        `${spanOf(rs.map((r) => r.turns))} | ${spanOf(outs)} | ` +
        `${spanOf(rs.map((r) => r.cost_usd), 4)} | ${spanOf(rs.map((r) => r.wall_s), 1)} | ` +
        `${spanOf(rs.map((r) => r.api_s), 1)} | ${spread} |`
    );
  }
  const unstable = [...groups.entries()].filter(([, rs]) => {
    const o = rs.map((r) => r.output_tokens).filter((x) => x != null);
    return o.length > 1 && Math.min(...o) > 0 && Math.max(...o) / Math.min(...o) > 2;
  });
  if (unstable.length) {
    lines.push(
      '',
      `Unstable (>2x output-token spread), treat single samples as unreliable: ` +
        unstable.map(([k]) => k.replace('|', '/')).join(', ')
    );
  }
  return lines;
}

function markdownReport({ meta, results, totals }) {
  const models = Object.entries(meta.models ?? {})
    .map(([b, m]) => `${b}: ${m}`)
    .join(', ');
  const lines = [
    `# zoo-sites eval report`,
    '',
    `- date: ${meta.date}`,
    `- backend: ${meta.backend} · models: ${models} · effort: ${meta.effort} · suite: ${meta.suite}` +
      (meta.repeat ? ` · repeat: ${meta.repeat}` : ''),
    `- tasks are simulated local pages (no live web); harness: run.mjs`,
    `- compare on OUTPUT TOKENS. Turns compare across the two MCP conditions but ` +
      `not across backends, because codex only approximates them.`,
    `- input columns are additive and comparable: \`input\` is the UNCACHED ` +
      `remainder for every backend, so total input is input + cache write + ` +
      `cache read. Codex reports an inclusive figure upstream and is normalized.`,
    `- cost below is what THIS run spent, for budgeting. Do not compare it against ` +
      `another run's: cache-creation volume swung 6x between two runs with identical ` +
      `turn counts, moving a cost ratio from 1.50 to 1.03. Cost ratios WITHIN one ` +
      `run are fine, since both conditions met the same cache.`,
    ...(meta.backend.includes('codex')
      ? [
          `- cost: anthropic is SDK-reported; codex is computed from token counts ` +
            `against genai-prices' bundled table, so the two are not measured the same way`,
        ]
      : []),
    '',
    '## Totals per condition',
    '',
    '`passed` counts graded attempts only. `infra` counts attempts that never',
    'reached a grade because an API or transport error outlived `--retries`; their',
    'tokens still appear in the sums, because they were really spent. A wall-limit',
    'stop is a failure, not infra: the agent spent every retry on the clock.',
    '',
    '| condition | passed | infra | turns | input | cache write | cache read | output | cost (USD) | api (s) | wall (s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [condition, t] of Object.entries(totals)) {
    lines.push(
      `| ${condition} | ${t.passed}/${t.tasks} | ${t.infra} | ${t.turns} | ${t.input_tokens} | ` +
        `${t.cache_creation} | ${t.cache_read} | ${t.output_tokens} | ${t.cost_usd} | ${t.api_s} | ${t.wall_s} |`
    );
  }
  // Extraction spend is reported once for the run, never per condition: the
  // extractor is condition-blind and its usage is excluded from every metric
  // above (docs/grading-design.md).
  const extracted = results.filter((r) => r.extraction);
  if (extracted.length) {
    const spend = extracted.reduce((n, r) => n + (r.extraction.cost_usd ?? 0), 0);
    lines.push(
      '',
      `Structured answer extraction: ${extracted.length} rows via ` +
        `${extracted[0].extraction.extractor}/${extracted[0].extraction.model}, ` +
        `$${spend.toFixed(4)} total (excluded from the per-condition metrics above).`
    );
  }
  // A failure caused by the surface hiding the value is a finding about the tool,
  // not about the agent, and the pass count alone conflates them. Truncation is
  // reported because it is provable: the value's opening reached the agent with
  // the truncator's ellipsis where the rest should have been.
  const cutRows = results.filter((r) => r.surface?.truncated?.length);
  if (cutRows.length) {
    const lost = cutRows.filter((r) => !r.success);
    lines.push(
      '',
      `Surface truncation: ${cutRows.length} row(s) had a graded value cut before it ` +
        `reached the agent, ${lost.length} of which failed. Those failures are the ` +
        `tool surface, not the agent; see the per-task notes.`
    );
    for (const r of lost) {
      lines.push(`  - ${r.condition}/${r.task}: ${JSON.stringify(r.surface.truncated)}`);
    }
  }
  // Spend the totals above cannot see: attempts discarded by retries or wall
  // stops still hit the API. Recorded per row, summed here for honesty.
  const discardedRows = results.filter((r) => r.discarded_cost_usd);
  if (discardedRows.length) {
    const spend = discardedRows.reduce((n, r) => n + r.discarded_cost_usd, 0);
    lines.push(
      '',
      `Discarded attempts (retries and wall stops): ${discardedRows.length} row(s) carry ` +
        `$${spend.toFixed(4)} of additional spend not in the per-condition totals.`
    );
  }
  lines.push('', '## Per-task results', '',
    '| condition | task | pass | turns | input | cache write | cache read | output | cost | api (s) | wall (s) | notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const r of results) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    // Fields-graded rows lead with the extracted claim (the thing that was
    // graded); the validator detail keeps the sub-check breakdown and the
    // route telemetry.
    // The validator detail conventionally ends with its own fields echo;
    // trim it from the last ' fields={' so nested-object fields do not print
    // twice (a brace-blind regex would miss them).
    const trimFieldsEcho = (text) => {
      const i = text.lastIndexOf(' fields={');
      return i === -1 ? text : text.slice(0, i);
    };
    const noteBase =
      r.grading === 'fields'
        ? `fields=${JSON.stringify(r.fields)} — ${trimFieldsEcho(String(r.detail ?? r.error ?? ''))}`
        : (r.detail ?? r.error ?? '');
    // A failure whose value the surface truncated is not the same result as a
    // failure the agent owns, so say which in the row rather than only in JSON.
    const cut = r.surface?.truncated?.length
      ? `SURFACE TRUNCATED ${JSON.stringify(r.surface.truncated)} — `
      : '';
    const note = r.extraction_failed
      ? `${cut}EXTRACTION FAILED (${r.extraction_failed}) — ${noteBase}`
      : cut + noteBase;
    lines.push(
      `| ${r.condition} | ${task} | ${r.success ? 'PASS' : 'FAIL'} | ${r.turns ?? ''} | ` +
        `${r.input_tokens ?? ''} | ${r.cache_creation ?? ''} | ` +
        `${r.cache_read ?? ''} | ${r.output_tokens ?? ''} | ${r.cost_usd?.toFixed?.(4) ?? ''} | ` +
        `${r.api_s ?? ''} | ${r.wall_s ?? ''} | ${cell(note)} |`
    );
  }
  if (meta.repeat) {
    lines.push(...medianLines(results));
  }
  lines.push('', '## Answers (truncated)', '');
  for (const r of results) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    lines.push(`- **${r.condition}/${task}**: ${r.answer ?? '(error)'}`);
  }
  return lines.join('\n') + '\n';
}

// The devtools suite (T120-T124). Same task shape as webTasks; graded against
// the same fixture server. Empty for now: the suite id exists so nothing
// downstream hardcodes 'web'.
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

// One isolated execution environment: pages server + state dir. Sequential
// runs use one env per condition; --parallel-tasks uses one per worker. Every
// live env is tracked so an interrupt removes temp dirs instead of leaking
// them (agents spawn their own MCP servers as children, which die with us).
const ACTIVE_ENVS = new Set();
let interrupting = false;
process.on('SIGINT', () => {
  if (interrupting) process.exit(130);
  interrupting = true;
  console.error('\ninterrupted - closing environments...');
  Promise.allSettled([...ACTIVE_ENVS].map((env) => env.close())).finally(() =>
    process.exit(130)
  );
});

async function makeEnv(backendName, condition, label, workerIndex = 0) {
  // Each env gets its own pages server so validator state (sessions/beacons)
  // never mixes across concurrent agents.
  const pages = await startPagesServer({ modes: RUN_MODES, seed: RUN_SEED });
  const stateDir = mkdtempSync(join(tmpdir(), `zoo-eval-${condition}-`));
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
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
  ACTIVE_ENVS.add(env);
  return env;
}

async function runCondition(backendName, condition, shared) {
  const label = BACKEND_NAMES.length > 1 ? `${backendName}/${condition}` : condition;
  console.log(`[${label}] starting (model: ${modelFor(backendName) || '(backend default)'})`);

  async function runOne(env, item) {
    // Task asks embed the env's pages URL, so rebuild against this env.
    const task = (await buildTasks(env.pages.url)).find((t) => t.id === item.id);
    const tag = REPEAT > 1 ? `${item.id} (r${item.rep})` : item.id;
    const discarded = { cost_usd: 0, output_tokens: 0, attempts: 0 };
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
        return {
          ...r,
          ...(attempt ? { retries: attempt } : {}),
          ...(discarded.attempts
            ? {
                discarded_cost_usd: Math.round(discarded.cost_usd * 10000) / 10000,
                discarded_output_tokens: discarded.output_tokens,
              }
            : {}),
        };
      } catch (error) {
        if (error?.discarded) {
          discarded.cost_usd += error.discarded.cost_usd ?? 0;
          discarded.output_tokens += error.discarded.output_tokens ?? 0;
          discarded.attempts += 1;
        }
        if (isTransient(error) && attempt < RETRIES) {
          console.log(
            `[${label}] ${tag}: transient error, retrying ` +
              `(${attempt + 1}/${RETRIES}): ${error.message.slice(0, 90)}`
          );
          continue;
        }
        console.log(`[${label}] ${tag}: ERROR ${error.message}`);
        // `infra` separates "we never got a graded attempt" from "the agent
        // failed the task", and is deliberately NARROWER than isTransient: what
        // is worth retrying is not the same as what is worth excusing. An API or
        // transport error is the former. A harness limit stop is the latter even
        // though we retry it, because an agent that exhausts every retry on the
        // wall clock really was too slow, and excusing that inflates the pass
        // rate. A backend that exits non-zero also stays a failure, since we
        // cannot show it was not the agent's doing.
        return {
          backend: backendName, condition: label, task: item.id, rep: item.rep,
          success: false, error: error.message,
          ...(TRANSIENT.test(error.message ?? '') ? { infra: true } : {}),
          ...(attempt ? { retries: attempt } : {}),
        };
      }
    }
  }

  const items = (await buildTasks('http://placeholder')).flatMap((t) =>
    Array.from({ length: REPEAT }, (_, i) => ({ id: t.id, rep: i + 1 }))
  );
  if (PARALLEL_TASKS > 1) {
    const queue = [...items];
    const done = new Map();
    const keyOf = (item) => `${item.id}#${item.rep}`;
    const workerCount = Math.min(PARALLEL_TASKS, queue.length);
    const errorRow = (item, error) => ({
      backend: backendName,
      condition: label,
      task: item.id,
      ...(REPEAT > 1 ? { rep: item.rep } : {}),
      success: false,
      error: String(error?.message ?? error),
    });
    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerIndex) => {
        // A worker that cannot start or a task that escapes runOne must not
        // sink the pool: completed rows stay, the failure becomes its row.
        let env;
        try {
          env = await makeEnv(backendName, condition, label, workerIndex);
        } catch {
          return;
        }
        try {
          while (queue.length) {
            const item = queue.shift();
            try {
              done.set(keyOf(item), await runOne(env, item));
            } catch (error) {
              done.set(keyOf(item), errorRow(item, error));
            }
          }
        } finally {
          await env.close().catch(() => {});
        }
      })
    );
    for (const item of queue) done.set(keyOf(item), errorRow(item, 'no worker started'));
    return items.map((item) => done.get(keyOf(item))).filter(Boolean);
  }

  const env = await makeEnv(backendName, condition, label);
  try {
    const results = [];
    for (const item of items) {
      try {
        results.push(await runOne(env, item));
      } catch (error) {
        results.push({
          backend: backendName,
          condition: label,
          task: item.id,
          ...(REPEAT > 1 ? { rep: item.rep } : {}),
          success: false,
          error: String(error?.message ?? error),
        });
      }
    }
    return results;
  } finally {
    await env.close().catch(() => {});
  }
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

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const runDir = join(here, 'results', `run-${stamp}`);
  const transcriptsDir = join(runDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });

  const scratchDir = mkdtempSync(join(tmpdir(), 'zoo-eval-scratch-'));
  const shared = { scratchDir, transcriptsDir };

  if (CONDITIONS.includes('playwright-mcp')) {
    await ensurePlaywrightFirefox();
  }
  if (HEADED) {
    GRID = windowGrid(TOTAL_SLOTS, detectScreen(flag('screen', null)));
  }

  const runs = BACKEND_NAMES.flatMap((backendName) =>
    CONDITIONS.map((condition) => [backendName, condition])
  );
  let results = [];
  if (PARALLEL) {
    console.log('(parallel mode: runs execute side by side; wall timings may include contention)\n');
    // allSettled so one condition's failure still lets the others finish and
    // tear down their instances/servers.
    const settled = await Promise.allSettled(
      runs.map(([b, c]) => runCondition(b, c, shared))
    );
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        const [b, c] = runs[i];
        console.error(`[${b}/${c}] condition failed: ${outcome.reason?.message}`);
        results.push({ backend: b, condition: `${b}/${c}`, task: '(condition)', success: false, error: outcome.reason?.message });
      }
    }
  } else {
    for (const [b, c] of runs) {
      results.push(...(await runCondition(b, c, shared)));
    }
  }
  rmSync(scratchDir, { recursive: true, force: true });

  const totals = totalsByCondition(results);
  console.log('\n=== totals per condition ===');
  console.table(totals);

  const meta = {
    date: startedAt.toISOString(),
    backend: BACKEND_NAMES.join(','),
    models: Object.fromEntries(
      BACKEND_NAMES.map((n) => [n, modelFor(n) || '(backend default)'])
    ),
    effort: EFFORT,
    suite: SUITE,
    task: ONLY_TASK ?? undefined,
    repeat: REPEAT > 1 ? REPEAT : undefined,
    conditions: CONDITIONS.join(','),
    mcpCommand: MCP_COMMAND ?? undefined,
    parallel: PARALLEL || undefined,
    parallelTasks: PARALLEL_TASKS > 1 ? PARALLEL_TASKS : undefined,
  };
  const jsonPath = join(runDir, 'results.json');
  const mdPath = join(runDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify({ meta, results, totals }, null, 2));
  writeFileSync(mdPath, markdownReport({ meta, results, totals }));
  console.log(`\nrun dir: ${runDir}\nreport:  ${mdPath}`);

  const failed = results.filter((r) => !r.success).length;
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
