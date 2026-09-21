// A stdio MCP client for the harness's own tool calls (verify workers, and
// anything else that needs to drive a browser outside an agent session). The
// server runs as a CHILD of this process - it dies with us, so a crashed
// gate cannot leak detached Firefox instances.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CALL_TIMEOUT_MS = 120000;

// The firefox-devtools-mcp server entry. `root` picks the build: a checkout's
// repo root, null for the dependency, or undefined for the default order:
//   FIREFOX_DEVTOOLS_MCP  a local checkout of the tool, for the iterate-on-the-
//                         tool loop and for working inside the tool's own repo
//   the dependency        @mozilla/firefox-devtools-mcp, the normal case
// The package name is scoped; `firefox-devtools-mcp` is only its bin name, so
// resolving that unscoped specifier always throws. Both paths are checked for
// existence here rather than at connect time: the server is spawned as a child
// with its stderr captured, so a missing entry would otherwise surface as an
// opaque "MCP error -32000: Connection closed" naming neither path nor cause.
export function devtoolsMcpEntry(root = undefined) {
  const fromEnv = root === undefined && Boolean(process.env.FIREFOX_DEVTOOLS_MCP);
  const checkout = root === undefined ? process.env.FIREFOX_DEVTOOLS_MCP || null : root;
  if (checkout) {
    const entry = join(checkout, 'dist', 'index.js');
    if (existsSync(entry)) return entry;
    throw new Error(
      `${fromEnv ? 'FIREFOX_DEVTOOLS_MCP is set but ' : ''}${entry} does not exist. ` +
        'Point it at a checkout of firefox-devtools-mcp that has been built (npm run build).'
    );
  }
  let resolved;
  try {
    resolved = join(
      createRequire(import.meta.url).resolve('@mozilla/firefox-devtools-mcp/package.json'),
      '..',
      'dist',
      'index.js'
    );
  } catch {
    throw new Error(
      'Cannot find @mozilla/firefox-devtools-mcp. Run `npm install`, or set ' +
        'FIREFOX_DEVTOOLS_MCP to a built checkout of the tool.'
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(`@mozilla/firefox-devtools-mcp is installed but ${resolved} is missing.`);
  }
  return resolved;
}

export function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

// Which firefox-devtools-mcp build a run measured, for its meta: the version
// alone cannot tell a local checkout's working tree from the release, and a
// commit cannot tell an uncommitted edit from it, so the entry and the snapshot
// walker it injects into every page are hashed too. `root` as for
// devtoolsMcpEntry.
export function devtoolsMcpInfo(root = undefined) {
  const entry = devtoolsMcpEntry(root);
  const dir = join(entry, '..', '..');
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {}
  const hashes = {
    sha256: sha256File(entry),
    walkerSha256: sha256File(join(entry, '..', 'snapshot.injected.global.js')),
  };
  const checkout = root === undefined ? process.env.FIREFOX_DEVTOOLS_MCP || null : root;
  if (!checkout) return { source: 'dependency', version, ...hashes };
  const git = (gitArgs) => {
    const r = spawnSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  // A build copied into some other repository would otherwise report that
  // repository's commit as its own.
  const top = git(['rev-parse', '--show-toplevel']);
  const ownRepo = top != null && realpathSync(top) === realpathSync(dir);
  const status = ownRepo ? git(['status', '--porcelain']) : null;
  return {
    source: root === undefined ? 'FIREFOX_DEVTOOLS_MCP' : 'checkout',
    path: dir,
    version,
    commit: ownRepo ? git(['rev-parse', 'HEAD']) : null,
    dirty: status == null ? null : status !== '',
    ...hashes,
  };
}

// The browser settings every condition launches with, so two conditions differ
// by their tool surface rather than by the machine they ran on. Unpinned, one
// measurement found 1366x683 against 1280x720, dark against light, and the
// operator's own time zone in both. `viewport` is the page's inner size.
export const BROWSER_PINS = {
  locale: 'en-US',
  acceptLanguage: 'en-US, en',
  timeZone: 'UTC',
  viewport: { width: 1366, height: 683 },
  colorScheme: 'light',
};

// Firefox prefs both conditions set. The JS locale follows the build's own
// locale (intl.locale.requested=de-DE left an en-US build at en-US), so
// javascript.use_us_english_locale is what holds a localised system Firefox to
// en-US. Unset, the colour scheme follows the operator's OS appearance;
// Playwright emulates one over the pref. Playwright's Firefox build turns
// pdf.js off in its playwright.cfg, so a PDF downloaded there while the release
// Firefox opened it in pdf.js; a user pref overrides the cfg, and the build
// then renders it in the viewer too.
export const PINNED_PREFS = {
  'intl.accept_languages': BROWSER_PINS.acceptLanguage,
  'javascript.use_us_english_locale': true,
  'layout.css.prefers-color-scheme.content-override': 1,
  'pdfjs.disabled': false,
};

// Downloads go to `dir` without a dialog. Firefox's default is the operator's
// ~/Downloads, where an attachment a fixture serves would otherwise land.
export function downloadPrefs(dir) {
  return {
    'browser.download.dir': dir,
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
  };
}

// firefox-devtools-mcp's repeatable --pref flag, which it hands Firefox at launch.
export const prefArgs = (prefs) => Object.entries(prefs).flatMap(([k, v]) => ['--pref', `${k}=${v}`]);

// The Firefox that WebDriver starts when firefox-devtools-mcp is given no
// --firefox-path: the macOS app, or the first `firefox` on PATH.
function systemFirefox() {
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = dir && join(dir, 'firefox');
    if (path && existsSync(path)) return realpathSync(path);
  }
  return null;
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// A Firefox build as its files describe it: application.ini's Version and
// BuildID, and whether pdf.js is on: Playwright's build ships a playwright.cfg
// that turns it off, which a pinned pdfjs.disabled overrides. `binary` null
// means systemFirefox().
export function firefoxBuild(binary) {
  const path = binary ?? systemFirefox();
  if (!path) return null;
  const dir = dirname(path);
  const nearby = (name) => [join(dir, '..', 'Resources', name), join(dir, name), join(dir, 'browser', name)];
  const ini = nearby('application.ini').map(readText).find((t) => t != null) ?? '';
  const field = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(ini)?.[1]?.trim() ?? null;
  const cfg = nearby('playwright.cfg').map(readText).find((t) => t != null) ?? '';
  const pdfOff = /pref\(\s*["']pdfjs\.disabled["']\s*,\s*true\s*\)/.test(cfg);
  const pinned = PINNED_PREFS['pdfjs.disabled'];
  return {
    binary: path,
    version: field('Version'),
    buildID: field('BuildID'),
    pdfjs:
      pinned === true
        ? 'disabled by a pinned pref'
        : !pdfOff
          ? 'enabled'
          : pinned === false
            ? 'enabled by a pinned pref over playwright.cfg'
            : 'disabled by playwright.cfg',
  };
}

// `baseEnv` is what the server inherits under `env`; the runner's preflight
// passes the agents' allowlist so a server that needs a dropped variable fails
// there, before any paid work, rather than inside every agent.
export async function startMcpServer({ command, args, env = {}, baseEnv = process.env, cwd } = {}) {
  const client = new Client({ name: 'zoo-sites-harness', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: command ?? process.execPath,
    args,
    env: { ...baseEnv, ...env },
    ...(cwd ? { cwd } : {}),
    // Piped, not inherited: the server logs on every run and inheriting would
    // interleave that into the harness output. Kept only to explain a failed
    // connect, which otherwise reports "Connection closed" with no cause.
    stderr: 'pipe',
  });
  let stderr = '';
  try {
    await client.connect(transport);
    transport.stderr?.on('data', () => {});
  } catch (error) {
    for await (const chunk of transport.stderr ?? []) {
      stderr += String(chunk);
      if (stderr.length > 4000) break;
    }
    error.message = stderr.trim()
      ? `${error.message}\nMCP server stderr:\n${stderr.trim().slice(0, 4000)}`
      : error.message;
    throw error;
  }
  return {
    call: (name, toolArgs = {}) =>
      client.callTool({ name, arguments: toolArgs }, undefined, { timeout: CALL_TIMEOUT_MS }),
    listTools: () => client.listTools(undefined, { timeout: CALL_TIMEOUT_MS }),
    close: () => client.close().catch(() => {}),
  };
}
