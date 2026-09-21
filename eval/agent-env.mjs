// What an agent process inherits from the harness, the temporary directories
// each attempt owns, and what an attempt leaves behind: its downloads, and the
// pages server's state it was graded on.
//
// Agents get an allowlist, never all of process.env. Under a parent Claude
// Code session, process.env would carry its control channels
// (CLAUDE_CODE_MESSAGING_SOCKET and _TOKEN, CLAUDE_CODE_SESSION_ID,
// ANTHROPIC_MODEL, CLAUDE_CODE_EFFORT_LEVEL...) into every run, and a shell
// variable such as TOOL_PRESET or CONNECT_EXISTING would silently reconfigure
// the firefox-devtools-mcp server under test. The allowlist below passes what
// the processes need to start, reach and authenticate against their API, and
// launch a browser.

import { createHash } from 'node:crypto';
import {
  chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const BASE_KEYS = [
  // Process basics. USER is also how Claude Code finds its macOS keychain login.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'LANG', 'TERM',
  // Reaching the API from behind a proxy or a private CA.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // A headed Firefox on Linux.
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  // Where state from before the run lives: the Claude CLI's profile
  // credentials (XDG_CONFIG_HOME/anthropic) and data, and on Linux the Firefox
  // that `playwright install` put under XDG_CACHE_HOME.
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
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

// Prefixes an agent can read (its cwd in every playwright-mcp action result,
// TMPDIR, PATH and CLAUDE_CONFIG_DIR in its shell), so none says what the run is.
export const TEMP_PREFIX = {
  attempt: 'work-',
  home: 'home-',
  tmp: 'tmp-',
  bin: 'bin-',
  profiles: 'profiles-',
};

// The real path: macOS tmpdir() is under /var, a symlink to /private/var, and
// firefox-devtools-mcp rejected a saveTo path under /var as outside its
// /private/var cwd.
export function makeTempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  LIVE_DIRS.add(dir);
  return dir;
}

// Commands that would reach a browser other than the condition's own, or drive
// the desktop: stored runs opened fixture pages in the operator's running
// Firefox through /opt/homebrew/bin/firefox. Each is shadowed by a stub that
// says it is not available and fails, for a PATH lookup only: an absolute path
// (/usr/bin/open), a login shell, whose profile rebuilds PATH, or `env -i`
// reaches the real one. What stops that is the backend's sandbox, if anything,
// and what catches a page it loads is scripts/foreign-browser.mjs.
export const SHIMMED_COMMANDS = [
  'firefox', 'firefox-esr', 'firefox-bin', 'firefox-beta', 'firefox-nightly', 'firefox-developer-edition',
  'firefoxdeveloperedition', 'playwright', 'playwright-cli', 'open', 'osascript', 'xdg-open',
  'x-www-browser', 'sensible-browser',
];
let shims = null;
export function shimDir() {
  if (shims) return shims;
  shims = makeTempDir(TEMP_PREFIX.bin);
  for (const name of SHIMMED_COMMANDS) {
    const path = join(shims, name);
    writeFileSync(path, `#!/bin/sh\necho "${name}: not available" >&2\nexit 127\n`);
    chmodSync(path, 0o755);
  }
  return shims;
}

// `path` with the stub directory first, so everything else on it still runs.
export function shimmedPath(path) {
  const rest = String(path ?? '').split(delimiter).filter((p) => p && p !== shimDir());
  return [shimDir(), ...rest].join(delimiter);
}

// What no agent shell may read. `deny` holds the operator's home directory,
// every checkout of this repository, whose eval/answers.mjs and sites/ hold the
// graded truth, and the operator's Claude and codex homes (the defaults and any
// the environment names), whose session transcripts can quote them. `allow`
// re-opens, inside that, what a shell needs to run: this checkout's
// node_modules, where the agent CLIs live (the Claude CLI's shell runs `rg` as
// the CLI's own bundled build from there), and each directory on `path`, the
// PATH the shell gets, that lies in the home directory, with the lib directory
// beside it when it is a bin one, where a python keeps its standard library.
// A directory that holds or lies in a checkout or an agent home is never
// re-opened, so a PATH entry under ~/.claude stays shut. A linked worktree's
// .git file names its git directory, whose commondir names the main one, which
// lists every linked worktree under worktrees/; git may write any of those
// paths relative. Real paths, since both sandboxes match the resolved path. A
// denied path inside another is left out unless a re-opened one holds it: both
// backends print the lists into the agent's prompt.
export function unreadablePaths(env = process.env, { path = env.PATH } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const checkouts = new Set([root]);
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  let common = join(root, '.git');
  const gitdir = /^gitdir:\s*(.+)$/m.exec(read(common) ?? '')?.[1].trim();
  if (gitdir) {
    const admin = resolve(root, gitdir);
    common = resolve(admin, read(join(admin, 'commondir')) ?? '.');
  }
  // A bare repository has no main checkout to add.
  if (basename(common) === '.git') checkouts.add(dirname(common));
  let linked = [];
  try {
    linked = readdirSync(join(common, 'worktrees'));
  } catch {}
  for (const name of linked) {
    const admin = join(common, 'worktrees', name);
    const dotGit = read(join(admin, 'gitdir'));
    if (dotGit) checkouts.add(dirname(resolve(admin, dotGit)));
  }
  const real = (paths) => [...new Set(paths.filter((p) => p && existsSync(p)).map((p) => realpathSync(p)))];
  const within = (p, dir) => p === dir || p.startsWith(dir + sep);
  const [home] = real([homedir()]);
  const secret = real([
    ...checkouts,
    env.CLAUDE_CONFIG_DIR,
    join(homedir(), '.claude'),
    env.CODEX_HOME,
    join(homedir(), '.codex'),
  ]);
  const all = [...(home ? [home] : []), ...secret];
  const reopenable = (p) => p !== home && !secret.some((s) => within(p, s) || within(s, p));
  const onPath = real(String(path ?? '').split(delimiter).filter((p) => isAbsolute(p)));
  const toolchain = real(
    onPath.flatMap((dir) => (['bin', 'sbin'].includes(basename(dir)) ? [dir, join(dirname(dir), 'lib')] : [dir]))
  ).filter((p) => home && within(p, home) && reopenable(p));
  const wanted = [...new Set([...real([join(root, 'node_modules')]), ...toolchain])];
  const allow = wanted.filter((p) => !wanted.some((q) => q !== p && within(p, q)));
  const deny = all.filter((p) => !all.some((q) => q !== p && within(p, q)) || allow.some((a) => within(p, a)));
  return { deny, allow };
}

// Every attempt directory, its temp directory and firefox-devtools-mcp's save
// root are made in the temp directory, so one that lay in a denied path would
// shut the agent out of its own files: the Read tool's deny rules outrank its
// allow rules, and a codex view_image of an attempt file would mark the row.
// Both backends' preflights call this before any paid work.
export function assertTempDirReadable(deny) {
  const root = realpathSync(tmpdir());
  const shut = deny.find((d) => root === d || root.startsWith(d + sep));
  if (shut) {
    throw new Error(`the temp directory ${root} lies in ${shut}, which no agent may read; set TMPDIR outside it`);
  }
}

// What every agent shell's environment sets over the harness's. The home
// directory is shut to the shell, and git skips a missing ~/.gitconfig but
// stops at one it may not read.
export const SHELL_ENV = { GIT_CONFIG_GLOBAL: '/dev/null' };

// Both ways an agent can write a real path under macOS's /private, which /tmp,
// /var and /etc link into: a check that matches the text an agent wrote, not
// the resolved path, needs each.
export const pathSpellings = (path) => [...new Set([path, path.replace(/^\/private(?=\/(?:tmp|var|etc)\/)/, '')])];

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

// The directory of the attempt's that only its MCP server writes: where the
// browser saves downloads, which for playwright-mcp is its --output-dir, beside
// its own snapshots and logs. Stored runs recorded curl's 403 bodies, which the
// agent's shell wrote into downloads/, as the browser's downloads, so each
// backend's sandbox lets the agent's shell and file tools read both names and
// write neither (serverDirs); the servers run outside the sandboxes. Plain
// directories, since `find` and `rg --files` skip a linked one.
export const SERVER_DIR_NAMES = ['downloads', 'playwright-output'];
export const serverDirName = (condition) => (condition === 'playwright-mcp' ? 'playwright-output' : 'downloads');
export const serverDirs = (cwd) => (cwd ? SERVER_DIR_NAMES.map((name) => join(cwd, name)) : []);

// Files the MCP servers write for themselves into the download directory, so
// `downloads` counts only what a page made the browser save, in either
// condition. playwright-mcp names its snapshots and logs <kind>-<ISO time>.<ext>;
// firefox-devtools-mcp's screencast_stop saves screencast-<uuid>.webm.
const TOOL_ARTIFACTS = [
  /^[a-z]+(?:-[a-z]+)*-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(?:\.\w+)?$/,
  /^screencast-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.\w+$/,
];

async function describeFile(path, name) {
  let bytes;
  try {
    bytes = lstatSync(path).size;
    const hash = createHash('sha256');
    let read = 0;
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
      read += chunk.length;
    }
    return { name, bytes: read, sha256: hash.digest('hex') };
  } catch (error) {
    return { name, ...(bytes == null ? {} : { bytes }), error: error.code ?? error.message };
  }
}

// What the browser saved into an attempt's download directory, read before the
// directory is removed. A file still downloading keeps Firefox's .part name.
// `named` holds the absolute paths the agent gave a server tool to write, which
// playwright-mcp resolves against the attempt directory, so one inside its
// output directory is the server's file too. Never throws, like removeTempDir:
// a file it cannot read is recorded with its error.
export async function attemptDownloads(dir, named = new Set()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && !TOOL_ARTIFACTS.some((re) => re.test(e.name)) && !named.has(join(dir, e.name))) {
      out.push(await describeFile(join(dir, e.name), e.name));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// A pages server's state as a validator read it, so a row can be regraded after
// a validator fix without paying for the run again. The copy is the one
// verify.mjs's cloneState makes: every data member, the logs as plain arrays,
// and the methods dropped, since they close over the live state. It is JSON
// with Map, Set, Date and byte values tagged, gzipped. `extra` rides along at
// the top level (the origins the attempt's task URLs used).
const TAG = '$zooType';
export function writeStateFile(path, state, extra = {}) {
  const methods = Object.keys(state).filter((k) => typeof state[k] === 'function');
  const data = Object.fromEntries(
    Object.entries(state)
      .filter(([k]) => !methods.includes(k))
      .map(([k, v]) => [k, Array.isArray(v) ? Array.from(v) : v])
  );
  // `this[key]` is the value before toJSON, which has already turned a Date
  // into a string and a Buffer into {type, data} by the time `value` arrives.
  const json = JSON.stringify({ version: 1, ...extra, methods, state: data }, function (key, value) {
    const raw = this[key];
    if (raw instanceof Map) return { [TAG]: 'Map', value: [...raw] };
    if (raw instanceof Set) return { [TAG]: 'Set', value: [...raw] };
    if (raw instanceof Date) {
      return { [TAG]: 'Date', value: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
    }
    if (ArrayBuffer.isView(raw)) {
      return { [TAG]: 'Bytes', value: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') };
    }
    return value;
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(json));
}

// The file writeStateFile wrote, with `state` rebuilt the way cloneState
// rebuilds one: its data plus beaconsOf. `methods` names what the live state
// had, so a validator that needs another method fails naming it.
export function readStateFile(path) {
  const file = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'), (key, value) => {
    if (value === null || typeof value !== 'object' || typeof value[TAG] !== 'string') return value;
    switch (value[TAG]) {
      case 'Map':
        return new Map(value.value);
      case 'Set':
        return new Set(value.value);
      case 'Date':
        return new Date(value.value ?? NaN);
      case 'Bytes':
        return Buffer.from(value.value, 'base64');
      default:
        return value;
    }
  });
  const state = file.state;
  state.beaconsOf = (kind) => (state.beacons ?? []).filter((b) => b.kind === kind);
  return { ...file, state };
}
