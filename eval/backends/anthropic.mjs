// Anthropic backend: drives tasks through the Claude Agent SDK.
// Backend interface (shared with backends/codex.mjs):
//   run({ prompt, model, effort, condition, env, cwd, onMessage, onOutputTokens,
//         mcpStdio, abortController, shellPath, serverOutputDirs }) ->
//     { text, turns, input_tokens, cache_creation, cache_read, output_tokens,
//       cost_usd, duration_ms, api_duration_ms, stream_errors? }
// `input_tokens` is the UNCACHED remainder only, never the total, so that
// input_tokens + cache_creation + cache_read is total input for every backend
// and the three columns stay additive. Anthropic's SDK already reports it that
// way; codex normalizes to it (see backends/codex.mjs).
// The MCP server is spawned over stdio from `mcpStdio` ({command, args, env?}),
// `env` holding what that server alone gets on top of the agent's environment.
// shellPath (optional): the PATH the agent's shell gets instead of env.PATH.
// serverOutputDirs (optional): directories outside cwd where the MCP server
// saves files its replies name, which the agent may read and not write.
// onMessage (optional): called with every raw agent message as it streams
// (thinking, tool calls, tool results, final result) for transcript logging.
// onOutputTokens (optional): called with the run's output tokens so far, for
// run.mjs's --max-output ceiling. A backend that cannot count mid-run never
// calls it.
// stream_errors (optional): errors the backend recovered from before the run
// completed, kept so they stay visible on the row.
// A run that ends in an API error, rather than an answer, throws; run.mjs
// retries it when the message reads transient. A thrown error carries `spend`
// (the same token and cost fields) when the attempt spent anything the backend
// could measure, so run.mjs can report it.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  assertTempDirReadable, makeTempDir, pathSpellings, removeTempDir, serverDirs, SHELL_ENV, TEMP_PREFIX, unreadablePaths,
} from '../agent-env.mjs';
import { priceTokens } from './pricing.mjs';

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const SHELL_READ = unreadablePaths();

// The built-in tool set is pinned rather than left to the CLI's default, which
// offered live web (WebFetch, WebSearch), subagents and orchestration (Task,
// Workflow, SendMessage), scheduling (Cron*, ScheduleWakeup, Monitor) and push
// notifications: none belong in a local browser task, and each lets a run
// differ from its pair by more than the tool surface. ToolSearch stays so an
// MCP tool the CLI still defers can be loaded (CLI_ENV turns deferral off), and
// TaskOutput/TaskStop because a background Bash command needs them. Every
// condition gets a shell so the ONLY difference is how the browser is driven; a
// cost/turn gap must measure the tool surface, never shell access.
const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'ToolSearch', 'TaskOutput', 'TaskStop'];
// Denied by name as well, so a CLI that widened `tools` still could not hand
// these out. The Read rules keep the file tool out of the paths the sandbox
// denies the shell (agent-env.mjs unreadablePaths), under each spelling of a
// /private path; the CLI adds each to the sandbox's denyRead too.
const DISALLOWED_TOOLS = [
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'Workflow', 'SendMessage',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Monitor', 'PushNotification',
  ...SHELL_READ.deny.flatMap(pathSpellings).map((p) => `Read(/${p}/**)`),
];
// dontAsk denies every tool not allowed here, so Write and Edit need a rule or
// each call burns a turn on a denial. An Edit rule covers Write too, and the
// leading `//` makes the path absolute: file tools write in the attempt
// directory only, as codex's shell permissions profile does. Read needs a rule
// for each `readable` directory outside it, where the shell or the MCP server
// saves a file the agent then reads: under each spelling of a /private path,
// and with no Edit rule, so the file tools cannot write there.
const allowedTools = (cwd, readable = []) => [
  'mcp__firefox',
  'Bash',
  ...(cwd ? [`Edit(/${cwd}/**)`] : []),
  ...readable.flatMap(pathSpellings).map((p) => `Read(/${p}/**)`),
];

// CLI settings the harness pins rather than leaving to the CLI's defaults and
// remote config, which the allowlist in agent-env.mjs would otherwise decide.
//   ENABLE_TOOL_SEARCH=false  every MCP tool's schema in the first request.
//     The default defers them behind ToolSearch, and a stored run spent 197 of
//     one arm's 644 turns on ToolSearch alone. Codex in its default code mode
//     sends no MCP schema at all: its agent searches the catalog from a script
//     (see backends/codex.mjs), so the two backends meet the catalog
//     differently and a cross-backend input comparison carries that.
//   MAX_MCP_OUTPUT_TOKENS     the token cap past which the CLI truncates an MCP
//     result; unset, a remote flag can move it. The CLI's default. It does not
//     govern the <persisted-output> spill, which replaces any MCP result over
//     50,000 characters with a 2,000-character preview and a file path, at a
//     threshold only remote config can move; rows count the spills instead.
//   CLAUDE_CODE_DISABLE_AUTO_MEMORY  no memory directory is offered or read.
export const MAX_MCP_OUTPUT_TOKENS = 25000;
const CLI_ENV = {
  ENABLE_TOOL_SEARCH: 'false',
  MAX_MCP_OUTPUT_TOKENS: String(MAX_MCP_OUTPUT_TOKENS),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};

// The Bash tool runs under the CLI's sandbox (Seatbelt on macOS, bubblewrap on
// Linux): writes only in the attempt directory and the attempt's own temp
// directory, no network, and no way to ask for a command to run outside it.
// Whether it stops /usr/bin/open, or `firefox URL` handing the URL to a
// Firefox already running, is untested. failIfUnavailable makes a missing
// sandbox fail the attempt instead of running it unsandboxed. /tmp/claude is
// the sandbox's default temp directory, shared by every attempt, so it is
// closed. The browser and the MCP server run outside the sandbox, so no task
// needs the shell on the network, and a shell that has it can replay the
// browser's session cookie against fixture routes. An empty allowedDomains
// still starts the CLI's filtering proxy, which strictAllowlist makes refuse
// every host, and without allowLocalBinding the shell may connect to that
// proxy alone: a loopback fixture, which NO_PROXY sends direct, is refused as
// well. Reads go everywhere but the operator's home, the graded truth and the
// agent homes, with what the shell needs to run open again inside them
// (agent-env.mjs unreadablePaths), as in the codex shell.
function sandboxFor(cwd, tmp, read = SHELL_READ) {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [cwd, tmp].filter(Boolean),
      denyWrite: ['/tmp/claude', '/private/tmp/claude', ...serverDirs(cwd)],
      denyRead: read.deny,
      allowRead: read.allow,
    },
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    },
  };
}

// The sandbox needs bubblewrap and socat on Linux (macOS has sandbox-exec).
// Without them every attempt would fail on its first command, after the run
// has started paying, so run.mjs's preflight asks first, and it asks that the
// temp directory lie outside every denied path (agent-env.mjs).
export function preflightCheck(env = process.env) {
  assertTempDirReadable(SHELL_READ.deny);
  if (process.platform !== 'linux') return;
  const onPath = (name) => (env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
  const missing = ['bwrap', 'socat'].filter((name) => !onPath(name));
  if (missing.length) {
    throw new Error(`the anthropic backend runs Bash in the Claude CLI's sandbox, which needs ${missing.join(' and ')} on PATH`);
  }
}

// Recorded in each run's meta, so results from before and after a policy
// change stay distinguishable.
export const TOOL_POLICY = {
  tools: TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  allowedTools: allowedTools('/<attempt dir>', ['/<attempt temp dir>', '/<server output dir>']),
  permissionMode: 'dontAsk',
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
  cliEnv: CLI_ENV,
  toolMode: 'direct',
  toolModeDetail: 'every MCP tool is a tool of its own, its schema in the first request (ENABLE_TOOL_SEARCH=false)',
  subagents: 'none: Task, Agent, Workflow and SendMessage are left out of tools and named in disallowedTools',
  network:
    'none for Bash: sandbox.network allows no host, strictAllowlist makes its proxy refuse the rest, and without ' +
    'allowLocalBinding loopback fixtures are refused too; no web tool. The browser and the MCP server run outside it',
  readable:
    'Bash reads everything but sandbox.filesystem.denyRead (the operator home, every checkout, the agent homes), ' +
    'with allowRead open again inside it (this checkout\'s node_modules, and the shell PATH directories under the ' +
    'home, each bin with the lib beside it: agent-env.mjs unreadablePaths); the Read tool is denied every denyRead ' +
    'path, allowRead included, and reads outside the attempt directory only in the attempt temp directory and ' +
    'serverOutputDirs. The preflight keeps the temp directory, which holds all three, outside every denied path. ' +
    'Not covered: the browser and the MCP server, which run unsandboxed (file:// and the upload tools reach the ' +
    'repository), and copies of the graded truth outside the home and every checkout',
  serverOutput:
    'firefox-devtools-mcp saves under <its HOME>/.firefox-devtools-mcp (saveTo:true in its output/, an absolute ' +
    'saveTo anywhere inside), outside the attempt directory, and names the file in its reply: a Read allow rule ' +
    'opens that root, under each spelling of a /private path, with no Edit rule and no sandbox write, so it stays ' +
    'read-only. playwright-mcp saves inside the attempt directory. A --mcp-command server keeps the operator HOME, ' +
    'so a file it saves there is unreadable to the agent',
  shellEnv: SHELL_ENV,
  promptListsPaths:
    "the Bash tool's description lists the sandbox's denyRead and allowRead paths, so input tokens compare only " +
    'between runs that deny and re-open the same paths (allowRead follows the shell PATH)',
  sandbox: sandboxFor('<attempt dir>', '<attempt temp dir>'),
  claudeConfigDir: 'fresh per attempt; the login stays where it was (CLAUDE_SECURESTORAGE_CONFIG_DIR)',
  path: 'the harness PATH with a stub directory first (agent-env.mjs SHIMMED_COMMANDS)',
};

// A fresh CLAUDE_CONFIG_DIR per attempt, as codex gets a fresh CODEX_HOME: the
// CLI otherwise wrote spilled tool results and a memory path into the
// operator's ~/.claude/projects/<cwd slug>, and kept background task output in
// /tmp/claude-<uid>/<cwd slug>, shared by every attempt. What a login needs stays put: an API key or ANTHROPIC_PROFILE is
// read from the environment and ~/.config/anthropic, and a `claude login`
// credential from the keychain entry (or .credentials.json) that
// CLAUDE_SECURESTORAGE_CONFIG_DIR names, where the empty string means the
// default one. Exported for any other process the harness starts on the CLI
// (the extractor).
export function isolatedClaudeHome(env) {
  const config = makeTempDir(TEMP_PREFIX.home);
  const tmp = makeTempDir(TEMP_PREFIX.tmp);
  const secureStorage = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? '';
  return {
    env: {
      ...env,
      ...CLI_ENV,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorage,
      CLAUDE_CODE_TMPDIR: tmp,
    },
    tmp,
    // The CLI names a session's directories after its cwd. A CLI that ignored
    // the variables above would write them under the defaults, so those go too.
    close(cwd) {
      removeTempDir(config);
      removeTempDir(tmp);
      if (!cwd) return;
      const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
      const uid = process.getuid?.();
      const leftovers = [
        join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', slug),
        ...(uid == null ? [] : [join('/tmp', `claude-${uid}`, slug)]),
      ];
      for (const dir of leftovers) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch {}
      }
    },
  };
}

// Output tokens per API message. The SDK streams an assistant message once per
// content block, each carrying the usage as of message_start, so those alone
// covered 11-43% of the true output in stored runs; message_delta carries the
// message's cumulative output. Both are max-ed per message id, and the result
// message never feeds the running count (it repeats the total).
function usageTracker() {
  const byId = new Map();
  let current = null;
  const take = (id, usage) => {
    if (!id || !usage) return;
    const u = byId.get(id) ?? { input_tokens: 0, cache_creation: 0, cache_read: 0, output_tokens: 0 };
    u.input_tokens = Math.max(u.input_tokens, usage.input_tokens ?? 0);
    u.cache_creation = Math.max(u.cache_creation, usage.cache_creation_input_tokens ?? 0);
    u.cache_read = Math.max(u.cache_read, usage.cache_read_input_tokens ?? 0);
    u.output_tokens = Math.max(u.output_tokens, usage.output_tokens ?? 0);
    byId.set(id, u);
  };
  const total = (key) => [...byId.values()].reduce((n, u) => n + u[key], 0);
  return {
    // Returns true when the message changed a count.
    observe(message) {
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        take(message.message?.id, message.message?.usage);
        return true;
      }
      if (message.type === 'stream_event' && !message.parent_tool_use_id) {
        const event = message.event;
        if (event?.type === 'message_start') {
          current = event.message?.id ?? null;
          take(current, event.message?.usage);
        } else if (event?.type === 'message_delta') {
          take(current, event.usage);
          return true;
        }
      }
      return false;
    },
    output: () => total('output_tokens'),
    requests: () => byId.size,
    totals: () => ({
      input_tokens: total('input_tokens'),
      cache_creation: total('cache_creation'),
      cache_read: total('cache_read'),
      output_tokens: total('output_tokens'),
    }),
  };
}

// `env` is the CLI's own environment, which its Bash commands inherit;
// `shellPath` replaces its PATH there. The MCP server is started with the PATH
// `env` had, since the stub directory would hide the Firefox a server looks up
// on PATH, plus whatever `mcpStdio.env` sets for it alone. `tmp` is the
// attempt's own temp directory, which the sandbox lets the shell write. The
// shell's read rules are derived from the PATH it gets; the agent homes are
// the operator's, not the CLI's fresh one. SHELL_ENV reaches the MCP server
// too, which reads no git config.
export function agentOptions({
  model, effort, env, cwd, mcpStdio, abortController, shellPath, tmp, serverOutputDirs = [],
}) {
  const base = env ?? process.env;
  const read = unreadablePaths(process.env, { path: shellPath ?? base.PATH });
  return {
    model,
    permissionMode: TOOL_POLICY.permissionMode,
    cwd,
    settingSources: TOOL_POLICY.settingSources,
    tools: TOOLS,
    disallowedTools: [...DISALLOWED_TOOLS, ...serverDirs(cwd).map((dir) => `Edit(/${dir}/**)`)],
    allowedTools: allowedTools(cwd, [tmp, ...serverOutputDirs].filter(Boolean)),
    strictMcpConfig: TOOL_POLICY.strictMcpConfig,
    persistSession: TOOL_POLICY.persistSession,
    sandbox: sandboxFor(cwd, tmp, read),
    // Only for the message_start/message_delta usage above; content deltas are
    // dropped before they reach the transcript.
    includePartialMessages: true,
    ...(effort ? { effort } : {}),
    // Lets run.mjs stop a task on its backend-agnostic token/wall ceilings.
    ...(abortController ? { abortController } : {}),
    env: { ...base, ...(shellPath ? { PATH: shellPath } : {}), ...SHELL_ENV },
    mcpServers: {
      firefox: {
        type: 'stdio',
        command: mcpStdio.command,
        args: mcpStdio.args,
        env: { ...(base.PATH ? { PATH: base.PATH } : {}), ...(mcpStdio.env ?? {}) },
      },
    },
  };
}

export async function run({
  prompt, model, effort, env, cwd, onMessage, onOutputTokens, mcpStdio, abortController, shellPath, serverOutputDirs,
}) {
  const home = isolatedClaudeHome(env ?? process.env);
  try {
    return await runIn(home, {
      prompt, model, effort, cwd, onMessage, onOutputTokens, mcpStdio, abortController, shellPath, serverOutputDirs,
    });
  } finally {
    home.close(cwd);
  }
}

async function runIn(home, {
  prompt, model, effort, cwd, onMessage, onOutputTokens, mcpStdio, abortController, shellPath, serverOutputDirs,
}) {
  const options = agentOptions({
    model, effort, env: home.env, cwd, mcpStdio, abortController, shellPath, tmp: home.tmp, serverOutputDirs,
  });
  const started = Date.now();
  const tracker = usageTracker();
  // What an attempt spent when no result message will ever say: an abort, or a
  // stream that died. The cost is priced from the observed tokens.
  const partialSpend = () => {
    const counts = tracker.totals();
    const cost_usd = priceTokens(model ?? DEFAULT_MODEL, counts, 'anthropic', tracker.requests());
    return { ...counts, cost_usd, cost_estimated: true };
  };
  // A run can emit MORE THAN ONE result message: if the agent starts a background
  // Bash task (agents do this to wait for an async page reply), its completion
  // re-invokes the agent and the SDK emits a fresh result for that continuation.
  // `usage` and `num_turns` are PER-SEGMENT while `total_cost_usd` and the
  // durations are CUMULATIVE — so usage must be summed and the rest taken at its
  // last value. Keeping only the last result reports a 26-turn/2392-token run as
  // 1 turn and 53 tokens, silently understating the suite's primary metric by 45x.
  const results = [];
  const resultSpend = () => {
    const sum = (pick) => results.reduce((n, r) => n + (pick(r.usage ?? {}) ?? 0), 0);
    return {
      input_tokens: sum((u) => u.input_tokens),
      cache_creation: sum((u) => u.cache_creation_input_tokens),
      cache_read: sum((u) => u.cache_read_input_tokens),
      output_tokens: sum((u) => u.output_tokens),
      cost_usd: results.at(-1).total_cost_usd ?? null,
    };
  };
  try {
    for await (const message of query({ prompt, options })) {
      const counted = tracker.observe(message);
      if (message.type === 'stream_event' && message.event?.type !== 'message_delta') continue;
      onMessage?.(message);
      if (counted) onOutputTokens?.(tracker.output());
      if (message.type === 'result') {
        results.push(message);
      }
    }
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    // An API failure ("API Error: 529 ...") arrives as a result flagged
    // is_error, and the SDK throws "Claude Code returned an error result: <its
    // text>" once the CLI exits, so that result's exact spend is already here.
    error.spend ??= results.at(-1)?.is_error ? resultSpend() : partialSpend();
    throw error;
  }
  if (!results.length) {
    const error = new Error('no result message from agent');
    error.spend = partialSpend();
    throw error;
  }
  const last = results.at(-1);
  // The same failure when the CLI exits cleanly. Either way run.mjs retries it
  // when the text reads transient.
  if (last.is_error) {
    const error = new Error(
      'agent result is_error' +
        (last.api_error_status != null ? ` (API status ${last.api_error_status})` : '') +
        `: ${String(last.result ?? last.errors?.join('; ') ?? last.subtype).slice(0, 300)}`
    );
    error.spend = resultSpend();
    throw error;
  }
  return {
    text: last.subtype === 'success' ? last.result : `[${last.subtype}]`,
    turns: results.reduce((n, r) => n + (r.num_turns ?? 0), 0),
    ...resultSpend(),
    duration_ms: last.duration_ms ?? Date.now() - started,
    // Time spent in API calls (vs tool execution etc.), when reported.
    api_duration_ms: last.duration_api_ms ?? null,
    segments: results.length,
    tool_mode: TOOL_POLICY.toolMode,
  };
}
