// Codex backend: drives tasks through OpenAI's Codex SDK (@openai/codex-sdk),
// which shells out to the `codex` CLI and streams JSONL events back.
// Same interface as backends/anthropic.mjs (see its header), including the
// onMessage transcript sink (receives raw ThreadEvents).
//
// The MCP server is spawned over stdio (`mcpStdio`) through a `mcp_servers`
//   config override (the SDK flattens `config` into --config flags). Tools
//   are auto-approved (default_tools_approval_mode) since codex otherwise
//   cancels non-read-only MCP tools under approval 'never'. Commands run under
//   a permissions profile (shellPermissionsToml) that reads everywhere but the
//   graded truth, writes in the attempt directory and a private TMPDIR, and
//   reaches loopback only (the fixtures are loopback HTTP), so the shell never
//   differs between conditions.
//
// Codex offers tools in the mode the model catalog names (TOOL_MODE). In code
//   mode, which codex ships for gpt-5.6-*, the model has no MCP tool of its
//   own: it writes JavaScript for one `exec` tool, which calls the MCP tools
//   (tools.mcp__firefox__*) and the shell (tools.exec_command) and hands back
//   only what the script prints. So a tool reply reaches the model only as far
//   as the script prints it; codex cuts an exec's whole output past a token
//   budget (10,000 unless the script's first-line `// @exec:` pragma sets
//   max_output_tokens) under "Warning: truncated output"; the model can sleep
//   inside a script, where no wait tool records it; and the tool catalog
//   arrives not as inline schemas (the first request carries none) but through
//   ALL_TOOLS, which a script has to search and print, and which every later
//   request then carries. Each row records those mechanics as `code_mode`
//   (codeModeStats), read from the rollout.
//
// api_duration_ms is not reported by codex; cost_usd is computed locally from
// the reported token counts (codex reports no price of its own).

import { Codex } from '@openai/codex-sdk';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { agentEnv, makeTempDir, pathSpellings, removeTempDir, TEMP_PREFIX, unreadablePaths } from '../agent-env.mjs';
import { priceTokens } from './pricing.mjs';

const execFileAsync = promisify(execFile);

// Pinned explicitly (rather than deferring to ~/.codex/config.toml) so runs
// are reproducible and the model is recorded in results.
export const DEFAULT_MODEL = 'gpt-5.6-terra';
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// The agent's catalog gives every model this tool_mode. code_mode_only is what
// codex ships for gpt-5.6-* and what every stored run used; EVAL_CODEX_TOOL_MODE
// picks another for an experiment, and a run's meta and rows record which. The
// codex extractor keeps the shipped mode, so an experiment never moves the
// grader. A model entry without one would fall back to codex's feature flags.
export const TOOL_MODES = ['direct', 'code_mode', 'code_mode_only'];
const SHIPPED_TOOL_MODE = 'code_mode_only';
export const TOOL_MODE = process.env.EVAL_CODEX_TOOL_MODE || SHIPPED_TOOL_MODE;
if (!TOOL_MODES.includes(TOOL_MODE)) {
  throw new Error(`EVAL_CODEX_TOOL_MODE=${TOOL_MODE}: expected one of ${TOOL_MODES.join(', ')}`);
}

const SHELL_READ = unreadablePaths();
const SHELL_PROFILE = 'shell';
// Hosts the shell may reach through codex's managed proxy: loopback, where
// every fixture is served. The anthropic sandbox names all but ::1, and both
// sandboxes let the shell connect to loopback directly as well.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '*.localhost'];

// Settings every codex process gets on top of the isolated home. On first start
// codex unpacks its bundled skills (imagegen, skill-installer and more) into
// CODEX_HOME and lists them in the prompt; the anthropic agent loads no
// skills, so codex loads none either. Codex also hands out a subagent team
// (spawn_agent, send_input, wait_agent...), at the version the model's catalog
// entry names (v1 for gpt-5.6-luna) or else the one its multi_agent feature
// picks. The anthropic agent is denied Task, Agent and SendMessage, so
// agents.enabled=false takes the team away, since it outranks both, and the
// rollout's turn_context then reads multi_agent_version "disabled".
// features.multi_agent=false covers a catalog entry that names no version, and
// alone left luna's multi_agent_v1__* tools in ALL_TOOLS; stored runs, which
// deleted the catalog's field and so fell back to the feature, listed them too.
// Codex 0.145.0 also turns on its own browser and computer use, image
// generation, and the login's ChatGPT apps and plugins. None put a tool in the
// catalog of a stored run, and turning them off left a request byte-identical
// against a mock provider, but a changed default, or a login with connected
// apps, could hand the agent a second browser or the operator's connectors.
const ISOLATED_CONFIG = {
  skills: { bundled: { enabled: false } },
  agents: { enabled: false },
  features: {
    multi_agent: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    in_app_browser: false,
    computer_use: false,
    image_generation: false,
    apps: false,
    plugins: false,
  },
};
// The agent's process alone also starts the managed network proxy that holds
// its shell to loopback (shellPermissionsToml).
const AGENT_FEATURES = { ...ISOLATED_CONFIG.features, network_proxy: true };

// Recorded in each run's meta, so results from before and after a policy
// change stay distinguishable.
export const TOOL_POLICY = {
  config: { ...ISOLATED_CONFIG, features: AGENT_FEATURES },
  // Every feature `codex features list` reports on under that config, filled
  // in by preflightIsolation.
  featuresOn: null,
  sandbox: `permissions profile "${SHELL_PROFILE}" in CODEX_HOME/config.toml (never --sandbox, which silently overrides a profile)`,
  toolMode: TOOL_MODE,
  toolModeSource: process.env.EVAL_CODEX_TOOL_MODE ? 'EVAL_CODEX_TOOL_MODE' : 'default',
  toolModeScope: `every model in the agent's catalog; the codex extractor keeps ${SHIPPED_TOOL_MODE}`,
  turns:
    'model requests: the distinct total_token_usage values of the rollout token_count events; tool calls + 1 ' +
    'when no rollout parses or its last total disagrees with turn.completed usage (stored runs before this field: tool calls + 1)',
  network:
    `shell only: features.network_proxy routes it through codex's proxy, which allows ${LOOPBACK_HOSTS.join(', ')}, ` +
    "and the sandbox lets it connect directly to loopback and this machine's own addresses, and resolve names; nothing else",
  readable:
    'shell only: everything but readDenied, with readAllowed open again inside it. Not covered: view_image, which ' +
    'reads any file in codex\'s own process and has no switch in 0.145.0 (a row whose view_image names a ' +
    'readDenied path is invalid), the browser and the MCP servers, which run unsandboxed (file:// and the upload ' +
    'tools reach the repository), and copies of the graded truth outside a checkout',
  readDenied: SHELL_READ.deny,
  readAllowed: SHELL_READ.allow,
  promptListsPaths:
    "codex puts readDenied into the agent's prompt twice (permissions instructions and environment_context), so " +
    'input tokens compare only between runs that deny the same paths',
  writable: 'attempt cwd + a private TMPDIR (macOS mktemp ignores TMPDIR, so a bare mktemp is denied)',
  webSearch: 'disabled',
  approval: 'never',
  codexHome: 'isolated per process: the login, the permissions profile, no bundled skills',
  subagents:
    'none: agents.enabled=false removes spawn_agent and the rest whatever the catalog multi_agent_version says, ' +
    'and each rollout turn_context reads multi_agent_version "disabled"; features.multi_agent=false as well',
  isolationCheck:
    'preflight: the effective features must match config.features, and `codex sandbox` under the profile must ' +
    'deny readDenied, reach loopback and not reach https://example.com. Each row: its rollout turn_context must ' +
    'read multi_agent_version "disabled", deny every readDenied path and open writes to the attempt cwd and ' +
    'TMPDIR alone, and no view_image may name a readDenied path, or the row is invalid (codex-isolation)',
  mcpServerEnv: 'the harness allowlist (agent-env.mjs base keys), forwarded by name',
  path: 'the harness PATH with a stub directory first (agent-env.mjs SHIMMED_COMMANDS)',
  rollout: 'CODEX_HOME/sessions rollout copied into the run dir as rollouts/<transcript>',
};

// Codex's own launcher, resolved the way the SDK finds its binary.
const CODEX_CLI = join(
  dirname(createRequire(import.meta.resolve('@openai/codex-sdk')).resolve('@openai/codex/package.json')),
  'bin',
  'codex.js'
);

// Every home gets the catalog this codex would load, with each model's
// tool_mode pinned to `toolMode`. Read once per process, off the event loop:
// under a ChatGPT login `debug models` refreshes over the network first, which
// takes seconds. A failed read is retried by the next call.
let catalogRead = null;
async function modelCatalog(env, toolMode) {
  catalogRead ??= execFileAsync(process.execPath, [CODEX_CLI, 'debug', 'models'], {
    env,
    timeout: 60000,
  })
    .then(({ stdout }) => JSON.parse(stdout))
    .catch((error) => {
      catalogRead = null;
      const why = (error.stderr || error.message || '').trim().slice(0, 500);
      throw new Error(`codex debug models failed: ${why}`);
    });
  const catalog = structuredClone(await catalogRead);
  for (const model of catalog.models) model.tool_mode = toolMode;
  return JSON.stringify(catalog);
}

// A codex process otherwise reads the user's whole ~/.codex: config.toml,
// plugins, skills, MCP servers and global AGENTS.md. Stored runs opened by
// reading a plugin's SKILL.md and called the user's own browser MCP server, so
// the conditions were not isolated. Each process gets a fresh CODEX_HOME holding
// only the login. auth.json is linked rather than copied: a token refresh then
// lands in the real file instead of dying with the temp dir, and no copy of the
// credential outlives a crashed run. Without an auth.json the API key env var is
// the login, and codex exec reads it as CODEX_API_KEY. `toolMode` is the
// catalog's: the agent passes TOOL_MODE, and the extractor keeps the shipped one.
export async function isolatedCodexHome(env, { toolMode = SHIPPED_TOOL_MODE } = {}) {
  const root = makeTempDir(TEMP_PREFIX.home);
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  const login = {};
  if (existsSync(auth)) {
    symlinkSync(auth, join(home, 'auth.json'));
  } else if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) {
    login.CODEX_API_KEY = env.OPENAI_API_KEY;
  }
  const homeEnv = { ...env, ...login, CODEX_HOME: home };
  const catalog = join(home, 'model-catalog.json');
  try {
    writeFileSync(catalog, await modelCatalog(homeEnv, toolMode));
  } catch (error) {
    removeTempDir(root);
    throw error;
  }
  return {
    home,
    tmp,
    env: homeEnv,
    // What every process started on this home runs with.
    config: { ...ISOLATED_CONFIG, model_catalog_json: catalog },
    hasLogin: existsSync(auth) || Boolean(env.CODEX_API_KEY || env.OPENAI_API_KEY),
    close: () => removeTempDir(root),
  };
}

// Codex reports OpenAI-convention usage, where input_tokens counts the cached
// and cache-written tokens too. The clamp keeps inconsistent figures (or a
// switch to the exclusive convention upstream) printing 0 rather than a
// negative.
function uncachedInput(usage) {
  if (!usage) return 0;
  const cached = (usage.cached_input_tokens ?? 0) + (usage.cache_write_input_tokens ?? 0);
  return Math.max(0, (usage.input_tokens ?? 0) - cached);
}

// The permissions profile the agent's shell runs under, as the TOML of the
// home's config.toml. Every condition gets the same shell so the only
// difference is how the browser is driven. It reads everywhere but the graded
// truth and the agent homes (agent-env.mjs unreadablePaths), and writes in the
// attempt directory (the workspace root, cwd) and `tmp` alone: workspace-write
// also opened $TMPDIR and /tmp, which every other attempt shares (stored runs
// kept cookie jars at fixed /tmp paths). macOS mktemp ignores TMPDIR and uses
// the per-user temp dir, which holds every attempt's directories and so stays
// closed: there, a bare `mktemp` fails and `mktemp -p "$TMPDIR"` works. With
// features.network_proxy on, codex routes the shell through a proxy that
// allows LOOPBACK_HOSTS alone, and its sandbox then lets the shell connect
// only to loopback (allow_local_binding) and to DNS. The SDK flattens `config`
// into dotted --config keys, which codex splits on every dot, so a path key
// would break there; config.toml takes them quoted.
export function shellPermissionsToml(tmp) {
  const profile = `permissions.${SHELL_PROFILE}`;
  const filesystem = {
    ':root': 'read',
    ...Object.fromEntries(SHELL_READ.deny.map((p) => [p, 'deny'])),
    ...Object.fromEntries(SHELL_READ.allow.map((p) => [p, 'read'])),
    [tmp]: 'write',
  };
  const tables = [
    [`${profile}.filesystem`, filesystem],
    [`${profile}.filesystem.":workspace_roots"`, { '.': 'write' }],
    [`${profile}.network`, { enabled: true, allow_local_binding: true }],
    [`${profile}.network.domains`, Object.fromEntries(LOOPBACK_HOSTS.map((h) => [h, 'allow']))],
  ];
  return [
    `default_permissions = ${JSON.stringify(SHELL_PROFILE)}`,
    ...tables.map(([name, entries]) =>
      [`\n[${name}]`, ...Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)].join('\n')
    ),
    '',
  ].join('\n');
}

// `home` is the isolatedCodexHome() the process runs on.
export function codexConfig({ home, mcpStdio, effort, path, mcpEnvVars = [] }) {
  const shellTmp = home.tmp;
  return {
    ...home.config,
    features: AGENT_FEATURES,
    approval_policy: 'never',
    ...(effort ? { model_reasoning_effort: effort } : {}),
    // The process env is already the harness allowlist (agent-env.mjs); the
    // default excludes still keep *KEY*, *SECRET* and *TOKEN* out of the shell.
    // TMPDIR is the shell's private temp dir (shellPermissionsToml), and
    // TMPPREFIX zsh's temp dir for heredocs.
    shell_environment_policy: {
      inherit: 'all',
      ignore_default_excludes: false,
      set: {
        ...(path ? { PATH: path } : {}),
        TMPDIR: shellTmp,
        TMPPREFIX: join(shellTmp, 'zsh'),
      },
    },
    mcp_servers: {
      firefox: {
        command: mcpStdio.command,
        args: mcpStdio.args,
        // Codex starts a stdio server with a fixed handful of variables (HOME,
        // PATH, USER...), not its own env, so DISPLAY, PLAYWRIGHT_BROWSERS_PATH
        // and the proxies would reach the server under the Agent SDK only.
        // Names, not values, so no value lands on the codex command line.
        env_vars: mcpEnvVars,
        // What the harness sets for this server alone (its own HOME), which
        // holds no credential.
        ...(mcpStdio.env ? { env: mcpStdio.env } : {}),
        // Codex cancels non-read-only MCP tools under approval 'never';
        // auto-approve this server's tools instead.
        default_tools_approval_mode: 'approve',
        // Headroom for Firefox's lazy cold start inside the first tool call.
        startup_timeout_sec: 60,
        tool_timeout_sec: 180,
      },
    },
  };
}

// `-c` flags for a config object, flattened the way the SDK flattens `config`.
const configFlags = (config, prefix = '') =>
  Object.entries(config).flatMap(([k, v]) =>
    v && typeof v === 'object' ? configFlags(v, `${prefix}${k}.`) : ['-c', `${prefix}${k}=${JSON.stringify(v)}`]
  );

// Before any paid work, on a home built as run() builds one. Codex's effective
// features must match every pin in AGENT_FEATURES, which catches a renamed or
// ignored key. The shell profile, run under `codex sandbox`, must deny every
// readDenied path, keep readAllowed open, reach a loopback server by address
// and as *.localhost, write in its cwd and TMPDIR, and not reach
// https://example.com. No rollout records the network part: were
// features.network_proxy ignored, the profile's network.enabled would open the
// shell to every host. Offline, that last check passes without proving
// anything. Records the features that are on in TOOL_POLICY.featuresOn and
// throws naming every check that failed. `shellPath` as for run().
export async function preflightIsolation(env, shellPath = env.PATH) {
  const home = await isolatedCodexHome(env, { toolMode: TOOL_MODE });
  const cwd = makeTempDir(TEMP_PREFIX.attempt);
  const server = createServer((req, res) => res.end('loopback-ok'));
  try {
    writeFileSync(join(home.home, 'config.toml'), shellPermissionsToml(home.tmp));
    const flags = configFlags({ ...ISOLATED_CONFIG, features: AGENT_FEATURES });
    const cli = (args, options = {}) =>
      execFileAsync(process.execPath, [CODEX_CLI, ...args], { env: home.env, timeout: 60000, ...options }).catch(
        (error) => {
          throw new Error(`codex ${args[0]} failed: ${(error.stderr || error.message || '').trim().slice(0, 500)}`);
        }
      );
    const { stdout: listed } = await cli(['features', 'list', ...flags]);
    const effective = {};
    for (const line of listed.split('\n')) {
      const m = /^(\S+)\s.*\s(true|false)\s*$/.exec(line);
      if (m) effective[m[1]] = m[2] === 'true';
    }
    const unpinned = Object.entries(AGENT_FEATURES)
      .filter(([k, v]) => effective[k] !== v)
      .map(([k, v]) => `${k} is ${effective[k] ?? 'not listed'}, not ${v}`);
    if (unpinned.length) throw new Error(`codex features list: ${unpinned.join('; ')}`);
    TOOL_POLICY.featuresOn = Object.keys(effective).filter((k) => effective[k]).sort();

    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    const script = [
      'command -v curl >/dev/null || echo "FAIL curl, which this check uses, is not on PATH"',
      ...SHELL_READ.deny.map((p) => `ls ${q(p)} >/dev/null 2>&1 && echo ${q(`FAIL reads ${p}`)}`),
      ...SHELL_READ.allow.map((p) => `ls ${q(p)} >/dev/null 2>&1 || echo ${q(`FAIL cannot read ${p}`)}`),
      ...[`127.0.0.1:${port}`, `preflight.localhost:${port}`].map(
        (h) => `curl -s -m 5 http://${h}/ | grep -q loopback-ok || echo ${q(`FAIL cannot reach http://${h}/`)}`
      ),
      `code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com); ` +
        '[ "$code" = 000 ] || echo "FAIL reached https://example.com ($code)"',
      'touch ./w || echo "FAIL cannot write its cwd"',
      'touch "$TMPDIR/w" || echo "FAIL cannot write TMPDIR"',
      'echo DONE',
    ].join('\n');
    const { stdout } = await cli(['sandbox', ...flags, '-P', SHELL_PROFILE, '-C', cwd, '--', '/bin/sh', '-c', script], {
      cwd,
      env: { ...home.env, PATH: shellPath, TMPDIR: home.tmp },
    });
    const failed = stdout.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5));
    if (!/^DONE$/m.test(stdout)) failed.push(`the check did not finish: ${stdout.slice(-300)}`);
    if (failed.length) throw new Error(`codex shell sandbox: ${failed.join('; ')}`);
  } finally {
    server.close();
    removeTempDir(cwd);
    home.close();
  }
}

// Codex's own record of the session, which keeps what its event stream drops:
// the instructions and tool list it sent, and shell output whose head
// command_execution.aggregated_output cut. Every rollout file under the home's
// sessions/, in name order, joined into one text, or null when there is none.
// A file cut off mid-line (a killed codex) still ends its line, so the next
// file's session_meta parses.
function readRollouts(home) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) files.push(path);
    }
  };
  walk(join(home, 'sessions'));
  return files.length ? files.map((f) => readFileSync(f, 'utf8').replace(/(?<!\n)$/, '\n')).join('') : null;
}

// What a rollout says about the run that codex's event stream does not.
//   requests           model requests: codex writes a token_count event after
//                      each, and one with a null `info`, or a repeat of the
//                      last total, is not a request.
//   execs              code-mode `exec` calls, each one script.
//   discovery_execs    execs whose script reads ALL_TOOLS, the catalog search
//                      that stands in for inline tool schemas.
//   exec_sleeps        setTimeout, sleep(ms), delay(ms) or waitForTimeout(ms)
//                      calls in a script with a literal delay of 500ms or more,
//                      page-side ones included (firefox-devtools-mcp's
//                      evaluate_script, playwright-mcp's run_code), and shell
//                      `sleep <s>` of half a second or more, which the tap
//                      counts only for a shell call it sees: waits no wait
//                      tool records. Counted per call site, so one in a loop
//                      counts once. A method such as Python's time.sleep(s) is
//                      not one.
//   truncated_outputs  tool outputs codex cut before the model saw them.
// A rollout without one line of JSON yields null.
export function codeModeStats(rollout) {
  return rolloutFacts(rollout)?.stats ?? null;
}

const TRUNCATION_MARKER = /Warning: truncated output \(original token count: \d+\)|…\d+ (?:tokens|chars) truncated…/;
const DELAY = String.raw`\s*([\d_]+(?:\.\d+)?)\s*\)`;
const SLEEP_CALL = new RegExp(
  String.raw`\bsetTimeout\s*\([^\n]{0,200}?,${DELAY}|(?<![.\w])(?:sleep|delay)\s*\(${DELAY}|\bwaitForTimeout\s*\(${DELAY}` +
    String.raw`|(?<![.\w])sleep\s+(\d+(?:\.\d+)?)`,
  'g'
);
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'output_tokens'];

// codeModeStats, plus `usage`, the sum of each session's last
// total_token_usage, `turnContext`, the first turn_context payload, which
// holds the permissions and subagent version the session ran with, and
// `imageReads`, the text of every script or call that uses view_image.
function rolloutFacts(rollout) {
  const stats = { requests: 0, execs: 0, discovery_execs: 0, exec_sleeps: 0, truncated_outputs: 0 };
  const sessionTotals = [];
  const imageReads = [];
  let lastTotal = null;
  let turnContext = null;
  let parsed = 0;
  for (const line of String(rollout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    parsed++;
    const p = entry.payload ?? {};
    // A joined rollout holds one session per file, each counting from zero.
    if (entry.type === 'session_meta') {
      lastTotal = null;
      sessionTotals.push(null);
    }
    if (entry.type === 'turn_context') turnContext ??= p;
    if (entry.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const total = JSON.stringify(p.info.total_token_usage);
      if (total !== lastTotal) stats.requests++;
      lastTotal = total;
      if (!sessionTotals.length) sessionTotals.push(null);
      sessionTotals[sessionTotals.length - 1] = p.info.total_token_usage;
    }
    if (entry.type !== 'response_item') continue;
    if (p.type === 'custom_tool_call' && p.name === 'exec') {
      const script = String(p.input ?? '');
      stats.execs++;
      if (/\bALL_TOOLS\b/.test(script)) stats.discovery_execs++;
      for (const m of script.matchAll(SLEEP_CALL)) {
        const ms = m[4] === undefined ? Number((m[1] ?? m[2] ?? m[3]).replaceAll('_', '')) : Number(m[4]) * 1000;
        if (ms >= 500) stats.exec_sleeps++;
      }
      if (/\bview_image\b/.test(script)) imageReads.push(script);
    } else if (p.type === 'function_call' && p.name === 'view_image') {
      imageReads.push(String(p.arguments ?? ''));
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      if (TRUNCATION_MARKER.test(output)) stats.truncated_outputs++;
    }
  }
  if (!parsed) return null;
  const usage = Object.fromEntries(
    USAGE_KEYS.map((k) => [k, sessionTotals.reduce((sum, t) => sum + (t?.[k] ?? 0), 0)])
  );
  return { stats, usage, turnContext, imageReads };
}

// What the session's rollout says against the isolation this backend sets up:
// the subagent team gone, every readDenied path denied, and writes open in the
// attempt directory and the private TMPDIR alone. The managed network proxy
// leaves no trace there, so the preflight checks that instead. view_image
// reads in codex's own process, outside the permissions profile, and hands
// back any file, not only an image, as a data URL, and 0.145.0 has no switch
// for it; so a script or call that uses it and names a readDenied path marks
// the row too. `writable` holds the real paths of the attempt directory and
// TMPDIR.
function isolationProblems({ turnContext, imageReads = [] }, writable) {
  if (!turnContext) return ['the rollout holds no turn_context'];
  const problems = [];
  if (turnContext.multi_agent_version !== 'disabled') {
    problems.push(`subagents: multi_agent_version is ${JSON.stringify(turnContext.multi_agent_version)}`);
  }
  const entries = turnContext.permission_profile?.file_system?.entries ?? [];
  const where = (e) => (e.path?.type === 'path' ? e.path.path : JSON.stringify(e.path));
  const denied = new Set(entries.filter((e) => e.access === 'deny').map(where));
  for (const p of SHELL_READ.deny) if (!denied.has(p)) problems.push(`read: ${p} is not denied`);
  for (const e of entries) {
    if (e.access === 'write' && !writable.includes(where(e))) problems.push(`write: ${where(e)} is writable`);
  }
  for (const p of SHELL_READ.deny) {
    if (imageReads.some((text) => pathSpellings(p).some((s) => text.includes(s)))) {
      problems.push(`read: view_image, which the profile does not cover, names ${p}`);
    }
  }
  return problems;
}

// `rolloutPath`, when given, is where the session's rollout is kept, and
// `shellPath` the PATH the agent's shell gets instead of env.PATH, which codex
// itself and the MCP server keep.
export async function run({ prompt, model, effort, env, cwd, onMessage, mcpStdio, abortController, rolloutPath, shellPath }) {
  const codexHome = await isolatedCodexHome(env ?? {}, { toolMode: TOOL_MODE });
  // Read once the stream ends, when codex has exited and the file is whole.
  let rollout;
  const sessionRecord = () => (rollout === undefined ? (rollout = readRollouts(codexHome.home)) : rollout);
  try {
    writeFileSync(join(codexHome.home, 'config.toml'), shellPermissionsToml(codexHome.tmp));
    // When env is provided the SDK does not inherit process.env, so this is
    // exactly the harness allowlist plus CODEX_HOME.
    const codex = new Codex({
      env: codexHome.env,
      config: codexConfig({
        home: codexHome,
        mcpStdio,
        effort,
        path: shellPath ?? env?.PATH,
        mcpEnvVars: Object.keys(agentEnv(null, env ?? {})),
      }),
    });
    // No sandboxMode: its --sandbox flag would replace the permissions profile.
    const thread = codex.startThread({
      ...(model ? { model } : {}),
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      webSearchMode: 'disabled',
    });

    const started = Date.now();
    // The signal kills the codex process, so a harness ceiling stops the run
    // rather than only the stream; the SDK then throws, and run.mjs attributes
    // the stop. Codex reports usage only in turn.completed, so an aborted run's
    // spend is unknown.
    const { events } = await thread.runStreamed(prompt, { signal: abortController?.signal });
    let usage = null;
    let text = '';
    let toolCalls = 0;
    let failure = null;
    // Codex also emits `error` for trouble it recovers from: every stream retry
    // ("Reconnecting... 2/5") is one, and the turn can still complete and be
    // paid for. Only turn.failed, or an error no turn.completed follows, fails
    // the run; the rest ride along on the row.
    const streamErrors = [];
    for await (const event of events) {
      onMessage?.(event);
      if (event.type === 'turn.completed') {
        usage = event.usage;
      } else if (event.type === 'turn.failed') {
        failure = event.error;
      } else if (event.type === 'error') {
        streamErrors.push(String(event.message ?? ''));
      } else if (event.type === 'item.completed') {
        const item = event.item;
        if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
          toolCalls++;
        } else if (item.type === 'agent_message') {
          text = item.text ?? text;
        }
      }
    }
    if (!usage && !failure && streamErrors.length) failure = { message: streamErrors.at(-1) };
    // Codex reports one "turn" per run, so turns are the model requests the
    // rollout counts. Without a rollout they fall back to tool calls plus the
    // final response, which put a stored sweep's arms 9% and 5% high (1299 and
    // 1068 against 1195 and 1019 requests) and single rows off either way: one
    // script can make several MCP calls, and a discovery script makes none. A
    // rollout whose last totals are not the run's usage missed requests (all
    // 204 rows of that sweep matched), so it falls back as well.
    let facts = null;
    try {
      facts = rolloutFacts(sessionRecord());
    } catch (error) {
      console.error(`warning: codex rollout not read: ${error.message}`);
    }
    const stats = facts?.stats ?? null;
    const whole = Boolean(facts) && (!usage || USAGE_KEYS.every((k) => facts.usage[k] === (usage[k] ?? 0)));
    if (facts && !whole) {
      console.error(`warning: codex rollout totals ${JSON.stringify(facts.usage)} are not the run's usage, so turns are tool calls + 1`);
    }
    const turns = (whole && stats.requests) || toolCalls + 1;
    const writable = [cwd, codexHome.tmp].filter((p) => p && existsSync(p)).map((p) => realpathSync(p));
    const isolation = isolationProblems(facts ?? {}, writable);
    const counts = {
      // Normalized to the backend interface's uncached-remainder convention:
      // codex reports an input_tokens INCLUSIVE of both cache figures, so
      // reporting it raw put an inclusive number in the same report column as
      // anthropic's exclusive one and read as a 10000x input gap.
      input_tokens: uncachedInput(usage),
      cache_creation: usage?.cache_write_input_tokens ?? 0,
      cache_read: usage?.cached_input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    };
    // The usage sums every request of the run, and a tiered price applies per
    // request, so it is priced as `turns` requests rather than one huge one.
    const cost_usd = usage ? priceTokens(model ?? DEFAULT_MODEL, counts, 'codex', turns) : null;
    if (failure) {
      const error = new Error(`codex turn failed: ${failure.message}`);
      if (usage) error.spend = { ...counts, cost_usd };
      throw error;
    }
    return {
      text,
      turns,
      ...counts,
      cost_usd,
      duration_ms: Date.now() - started,
      api_duration_ms: null,
      tool_mode: TOOL_MODE,
      ...(stats ? { code_mode: stats } : {}),
      ...(isolation.length ? { codex_isolation: isolation } : {}),
      ...(streamErrors.length
        ? { stream_errors: streamErrors.slice(0, 10).map((m) => m.slice(0, 300)) }
        : {}),
    };
  } finally {
    if (rolloutPath) {
      try {
        const text = sessionRecord();
        if (text) {
          mkdirSync(dirname(rolloutPath), { recursive: true });
          writeFileSync(rolloutPath, text);
        }
      } catch (error) {
        console.error(`warning: codex rollout not kept: ${error.message}`);
      }
    }
    codexHome.close();
  }
}
