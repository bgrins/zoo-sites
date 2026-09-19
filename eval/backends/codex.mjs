// Codex backend: drives tasks through OpenAI's Codex SDK (@openai/codex-sdk),
// which shells out to the `codex` CLI and streams JSONL events back.
// Same interface as backends/anthropic.mjs (see its header), including the
// onMessage transcript sink (receives raw ThreadEvents).
//
// The MCP server is spawned over stdio (`mcpStdio`) through a `mcp_servers`
//   config override (the SDK flattens `config` into --config flags). Tools
//   are auto-approved (default_tools_approval_mode) since codex otherwise
//   cancels non-read-only MCP tools under approval 'never'. Commands run in
//   a network-enabled workspace-write sandbox (the fixtures are loopback
//   HTTP), so the shell never differs between conditions.
//
// api_duration_ms is not reported by codex; cost_usd is computed locally from
// the reported token counts (codex reports no price of its own).

import { Codex } from '@openai/codex-sdk';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { agentEnv, makeTempDir, removeTempDir } from '../agent-env.mjs';
import { priceTokens } from './pricing.mjs';

const execFileAsync = promisify(execFile);

// Pinned explicitly (rather than deferring to ~/.codex/config.toml) so runs
// are reproducible and the model is recorded in results.
export const DEFAULT_MODEL = 'gpt-5.6-terra';
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// Recorded in each run's meta, so results from before and after a policy
// change stay distinguishable.
export const TOOL_POLICY = {
  sandbox: 'workspace-write',
  network: true,
  writable: 'attempt cwd + a private TMPDIR (macOS mktemp ignores TMPDIR, so a bare mktemp is denied)',
  webSearch: 'disabled',
  approval: 'never',
  codexHome: 'isolated per process: the login, no config, no bundled skills',
  subagents: 'none: multi_agent_version removed from the model catalog codex loads',
  mcpServerEnv: 'the harness allowlist (agent-env.mjs base keys), forwarded by name',
};

// Settings every codex process gets on top of the isolated home. On first start
// codex unpacks its bundled skills (imagegen, skill-installer and more) into
// CODEX_HOME and lists them in the prompt; the anthropic agent loads no
// skills, so codex loads none either.
const ISOLATED_CONFIG = { skills: { bundled: { enabled: false } } };

// Codex's own launcher, resolved the way the SDK finds its binary.
const CODEX_CLI = join(
  dirname(createRequire(import.meta.resolve('@openai/codex-sdk')).resolve('@openai/codex/package.json')),
  'bin',
  'codex.js'
);

// Codex hands out a subagent team (spawn_agent, send_message, wait_agent...)
// when the model's catalog entry names a multi_agent_version, as gpt-5.6-terra's
// does, and features.multi_agent=false leaves those tools in the request. The
// anthropic agent is denied Task, Agent and SendMessage, so every home gets the
// catalog this codex would load, minus that field. Read once per process, off
// the event loop: under a ChatGPT login `debug models` refreshes over the
// network first, which takes seconds. A failed read is retried by the next call.
let catalogJson = null;
function modelCatalog(env) {
  catalogJson ??= execFileAsync(process.execPath, [CODEX_CLI, 'debug', 'models'], {
    env,
    timeout: 60000,
  })
    .then(({ stdout }) => {
      const catalog = JSON.parse(stdout);
      for (const model of catalog.models) delete model.multi_agent_version;
      return JSON.stringify(catalog);
    })
    .catch((error) => {
      catalogJson = null;
      const why = (error.stderr || error.message || '').trim().slice(0, 500);
      throw new Error(`codex debug models failed: ${why}`);
    });
  return catalogJson;
}

// A codex process otherwise reads the user's whole ~/.codex: config.toml,
// plugins, skills, MCP servers and global AGENTS.md. Stored runs opened by
// reading a plugin's SKILL.md and called the user's own browser MCP server, so
// the conditions were not isolated. Each process gets a fresh CODEX_HOME holding
// only the login. auth.json is linked rather than copied: a token refresh then
// lands in the real file instead of dying with the temp dir, and no copy of the
// credential outlives a crashed run. Without an auth.json the API key env var is
// the login, and codex exec reads it as CODEX_API_KEY.
export async function isolatedCodexHome(env) {
  const root = makeTempDir('zoo-codex-');
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
    writeFileSync(catalog, await modelCatalog(homeEnv));
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

// `home` is the isolatedCodexHome() the process runs on.
export function codexConfig({ home, mcpStdio, effort, path, mcpEnvVars = [] }) {
  const shellTmp = home.tmp;
  return {
    ...home.config,
    approval_policy: 'never',
    ...(effort ? { model_reasoning_effort: effort } : {}),
    // Every condition gets the same network-enabled shell so the only
    // difference is how the browser is driven. workspace-write also opens
    // $TMPDIR and /tmp by default, which every other attempt shares (stored runs
    // kept cookie jars at fixed /tmp paths), so both are closed and the shell
    // gets a private TMPDIR instead. TMPPREFIX is zsh's temp dir for heredocs.
    // macOS mktemp ignores TMPDIR and uses the per-user temp dir, which holds
    // every attempt's directories and so stays closed: there, a bare `mktemp`
    // fails and `mktemp -p "$TMPDIR"` works. A PATH shim cannot fix it, because
    // the shell is a login zsh whose path_helper puts /usr/bin first.
    sandbox_workspace_write: {
      network_access: true,
      writable_roots: [shellTmp],
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    },
    // The process env is already the harness allowlist (agent-env.mjs); the
    // default excludes still keep *KEY*, *SECRET* and *TOKEN* out of the shell.
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

export async function run({ prompt, model, effort, env, cwd, onMessage, mcpStdio, abortController }) {
  const codexHome = await isolatedCodexHome(env ?? {});
  try {
    // When env is provided the SDK does not inherit process.env, so this is
    // exactly the harness allowlist plus CODEX_HOME.
    const codex = new Codex({
      env: codexHome.env,
      config: codexConfig({
        home: codexHome,
        mcpStdio,
        effort,
        path: env?.PATH,
        mcpEnvVars: Object.keys(agentEnv(null, env ?? {})),
      }),
    });
    const thread = codex.startThread({
      ...(model ? { model } : {}),
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
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
    // Codex reports one "turn" per run; approximate agent turns, and the model
    // requests behind them, as tool-call rounds plus the final response.
    const turns = toolCalls + 1;
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
      ...(streamErrors.length
        ? { stream_errors: streamErrors.slice(0, 10).map((m) => m.slice(0, 300)) }
        : {}),
    };
  } finally {
    codexHome.close();
  }
}
