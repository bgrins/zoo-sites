// What an agent process inherits from the harness, and the temporary
// directories each attempt owns.
//
// Agents used to inherit all of process.env. Under a parent Claude Code session
// that carried its control channels (CLAUDE_CODE_MESSAGING_SOCKET and _TOKEN,
// CLAUDE_CODE_SESSION_ID, ANTHROPIC_MODEL, CLAUDE_CODE_EFFORT_LEVEL...) into
// every run, and a shell variable such as TOOL_PRESET or CONNECT_EXISTING
// silently reconfigured the firefox-devtools-mcp server under test. Only the
// allowlist below passes now: what the processes need to start, reach and
// authenticate against their API, and launch a browser.

import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_KEYS = [
  // Process basics. USER is also how Claude Code finds its macOS keychain login.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'LANG', 'TERM',
  // Reaching the API from behind a proxy or a private CA.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // A headed Firefox on Linux.
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  // The tool checkout under test, and where `playwright install` put Firefox.
  'FIREFOX_DEVTOOLS_MCP', 'PLAYWRIGHT_BROWSERS_PATH',
];
const BASE_PREFIXES = ['LC_'];

// Credentials and endpoints per backend. Model and effort selectors
// (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL) are deliberately absent: the
// harness pins both explicitly, and inheriting them would let the parent shell
// decide what ran.
const BACKEND_KEYS = {
  anthropic: {
    keys: [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_PROFILE', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
      'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
    ],
    prefixes: ['AWS_'],
  },
  // CODEX_HOME is not inherited: every codex process gets its own (see
  // backends/codex.mjs).
  codex: {
    keys: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'],
    prefixes: [],
  },
};

// `backend` null gives the base set alone, which is what an MCP server needs.
export function agentEnv(backend = null, source = process.env) {
  const extra = backend ? BACKEND_KEYS[backend] : { keys: [], prefixes: [] };
  if (!extra) throw new Error(`no environment allowlist for backend "${backend}"`);
  const keys = new Set([...BASE_KEYS, ...extra.keys]);
  const prefixes = [...BASE_PREFIXES, ...extra.prefixes];
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (keys.has(key) || prefixes.some((p) => key.startsWith(p))) env[key] = value;
  }
  return env;
}

// Every live temp dir, so a signal handler can remove them synchronously even
// while the code that made them is still awaiting an agent.
const LIVE_DIRS = new Set();

export function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  LIVE_DIRS.add(dir);
  return dir;
}

// Never throws: callers clean up in finally blocks, where a throw would replace
// a finished attempt's result. A directory that will not go stays registered,
// so removeAllTempDirs tries it again at exit.
export function removeTempDir(dir) {
  // Retries cover a child that is still exiting and writing as we delete.
  const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  try {
    remove();
  } catch {
    try {
      // An agent can leave a directory it made read-only, which rmSync cannot
      // empty.
      makeRemovable(dir);
      remove();
    } catch (error) {
      console.error(`warning: could not remove ${dir}: ${error.message}`);
      return;
    }
  }
  LIVE_DIRS.delete(dir);
}

// Directories only, and never through a symlink, so no mode outside `dir`
// changes.
function makeRemovable(dir) {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) makeRemovable(join(dir, entry.name));
  }
}

export function removeAllTempDirs() {
  for (const dir of [...LIVE_DIRS]) removeTempDir(dir);
}
