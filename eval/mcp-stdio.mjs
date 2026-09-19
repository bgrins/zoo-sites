// A stdio MCP client for the harness's own tool calls (verify workers, and
// anything else that needs to drive a browser outside an agent session). The
// server runs as a CHILD of this process - it dies with us, so a crashed
// gate cannot leak detached Firefox instances.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CALL_TIMEOUT_MS = 120000;

// The firefox-devtools-mcp server entry. Two sources, in order:
//   FIREFOX_DEVTOOLS_MCP  a local checkout of the tool, for the iterate-on-the-
//                         tool loop and for working inside the tool's own repo
//   the dependency        @mozilla/firefox-devtools-mcp, the normal case
// The package name is scoped; `firefox-devtools-mcp` is only its bin name, so
// resolving that unscoped specifier always throws. Both paths are checked for
// existence here rather than at connect time: the server is spawned as a child
// with its stderr captured, so a missing entry would otherwise surface as an
// opaque "MCP error -32000: Connection closed" naming neither path nor cause.
export function devtoolsMcpEntry() {
  const fromEnv = process.env.FIREFOX_DEVTOOLS_MCP
    ? join(process.env.FIREFOX_DEVTOOLS_MCP, 'dist', 'index.js')
    : null;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw new Error(
      `FIREFOX_DEVTOOLS_MCP is set but ${fromEnv} does not exist. ` +
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

// Which firefox-devtools-mcp build a run measured, for its meta: the version
// alone cannot tell a local checkout's working tree from the release.
export function devtoolsMcpInfo() {
  const entry = devtoolsMcpEntry();
  const root = join(entry, '..', '..');
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {}
  if (!process.env.FIREFOX_DEVTOOLS_MCP) return { source: 'dependency', version };
  const git = (gitArgs) => {
    const r = spawnSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const status = git(['status', '--porcelain']);
  return {
    source: 'FIREFOX_DEVTOOLS_MCP',
    path: root,
    version,
    commit: git(['rev-parse', 'HEAD']),
    dirty: status == null ? null : status !== '',
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
// Playwright emulates one over the pref.
export const PINNED_PREFS = {
  'intl.accept_languages': BROWSER_PINS.acceptLanguage,
  'javascript.use_us_english_locale': true,
  'layout.css.prefers-color-scheme.content-override': 1,
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
