// A stdio MCP client for the harness's own tool calls (verify workers, and
// anything else that needs to drive a browser outside an agent session). The
// server runs as a CHILD of this process - it dies with us, so a crashed
// gate cannot leak detached Firefox instances.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
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

// What every firefox-devtools-mcp server is spawned with over its allowlisted
// environment. Both builds load a .env file from their cwd unless NODE_ENV is
// production, and a .env there (the gate runs its server in the operator's
// cwd) could set CONNECT_EXISTING, TOOL_PRESET or 0.10.3's
// UNRESTRICTED_SAVE_PATHS and DISABLE_NETWORK_BODY_COLLECTION past the
// allowlist. Nothing else in either build reads NODE_ENV.
export const DEVTOOLS_SERVER_ENV = { NODE_ENV: 'production' };

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

// Selenium sizes Firefox's outer window; headless Linux takes one more pixel
// of vertical chrome than macOS before the page gets its inner viewport.
export function devtoolsWindowSize(viewport, platform = process.platform) {
  return `${viewport.width}x${viewport.height + (platform === 'linux' ? 86 : 85)}`;
}

// Firefox prefs both conditions set. The JS locale follows the build's own
// locale (intl.locale.requested=de-DE left an en-US build at en-US), so
// javascript.use_us_english_locale is what holds a localised system Firefox to
// en-US. Unset, the colour scheme follows the operator's OS appearance;
// Playwright emulates one over the pref. Playwright's Firefox build turns
// pdf.js off in its playwright.cfg, so a PDF downloaded there while the release
// Firefox opened it in pdf.js. Playwright's launch sets firefoxUserPrefs again
// over the cfg once the browser is up, so this pin renders it in the viewer
// there too; a --pref from firefox-devtools-mcp lands in user.js under the cfg,
// and only the policy devtoolsFirefoxLaunch writes sets it back.
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

// The Firefox build playwright-mcp launches: the one its own playwright-core
// resolves, in the cache `playwright install` fills. Null when it resolves none.
export function playwrightFirefox() {
  try {
    const cli = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
    const mcpRequire = createRequire(cli);
    return mcpRequire(mcpRequire.resolve('playwright-core')).firefox.executablePath() || null;
  } catch {
    return null;
  }
}

// The variable that pins the Firefox every firefox-devtools-mcp server of the
// gate, the spikes, the probes and the snapshot census launches, and that
// run.mjs reads when --devtools-firefox is not given.
export const DEVTOOLS_FIREFOX_VAR = 'EVAL_DEVTOOLS_FIREFOX';

// The Firefox a firefox-devtools-mcp server is told to launch (--firefox-path):
// `spec` 'playwright' names the build playwright-mcp launches, anything else a
// firefox executable or a macOS .app bundle. Undefined reads
// EVAL_DEVTOOLS_FIREFOX; null, or an unset variable, returns null, which leaves
// the server its own choice, systemFirefox(). Throws on a binary that does not
// exist.
export function devtoolsFirefox(spec = process.env[DEVTOOLS_FIREFOX_VAR] || null) {
  if (spec == null) return null;
  let binary = spec === 'playwright' ? playwrightFirefox() : resolve(spec);
  const install = 'run `npx playwright install firefox`';
  if (!binary) throw new Error(`playwright-mcp's playwright-core resolves no Firefox; ${install}`);
  if (/\.app\/?$/.test(binary) && statSync(binary, { throwIfNoEntry: false })?.isDirectory()) {
    binary = join(binary, 'Contents', 'MacOS', 'firefox');
  }
  if (!statSync(binary, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`no Firefox executable at ${binary}${spec === 'playwright' ? `; ${install}` : ''}`);
  }
  return { spec, binary };
}

// A build's playwright.cfg, which its defaults/pref file names as the
// autoconfig: Firefox runs its pref() calls after the profile's user.js, so
// each one holds over a --pref, and only Playwright's own launch, which sets
// firefoxUserPrefs again once the browser is up, gets past them.
function playwrightCfg(binary) {
  const dir = dirname(binary);
  return [join(dir, '..', 'Resources'), dir, join(dir, 'browser')]
    .map((d) => readText(join(d, 'playwright.cfg')))
    .find((t) => t != null) ?? null;
}

// The prefs of `prefs` that the build's playwright.cfg sets to another value,
// by name, with the cfg's value, and whether the cfg reads its policies file
// from PLAYWRIGHT_FIREFOX_POLICIES_JSON, the one way past them for a browser
// that geckodriver launches.
function cfgOverrides(binary, prefs) {
  const cfg = binary ? playwrightCfg(binary) : null;
  if (!cfg) return { overridden: {}, policyHook: false };
  const overridden = {};
  const call = /^\s*(pref|lockPref)\(\s*(["'])([^"']+)\2\s*,\s*(true|false|-?\d+|"[^"]*"|'[^']*')\s*\)/gm;
  for (const [, fn, , name, raw] of cfg.matchAll(call)) {
    if (!(name in prefs)) continue;
    const value = /^["']/.test(raw) ? raw.slice(1, -1) : raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    if (value !== prefs[name]) overridden[name] = { value, locked: fn === 'lockPref' };
  }
  return { overridden, policyHook: /getenv\(\s*"PLAYWRIGHT_FIREFOX_POLICIES_JSON"\s*\)/.test(cfg) };
}

// Which of `prefs` a firefox-devtools-mcp launch of `firefox` (from
// devtoolsFirefox; null for the installed one) needs a policy for: `policy`
// the prefs the build's playwright.cfg overrides and a Preferences policy can
// set back, read through the cfg's PLAYWRIGHT_FIREFOX_POLICIES_JSON, null for
// none; `unpinned` those no policy can, a lockPref or a cfg without the hook.
export function devtoolsFirefoxPolicy(firefox, prefs) {
  if (!firefox) return { policy: null, unpinned: [] };
  const { overridden, policyHook } = cfgOverrides(firefox.binary, prefs);
  const settable = Object.keys(overridden).filter((k) => policyHook && !overridden[k].locked);
  return { policy: settable.length ? settable : null, unpinned: Object.keys(overridden).filter((k) => !settable.includes(k)) };
}

// What a firefox-devtools-mcp server is spawned with to launch `firefox` (from
// devtoolsFirefox; null adds nothing), given the prefs the harness hands that
// browser through --pref or user.js: --firefox-path, and the policy
// devtoolsFirefoxPolicy names, written into `dir`. Playwright's build turns
// pdf.js off in its cfg, and --pref pdfjs.disabled=false alone left it off.
export function devtoolsFirefoxLaunch(firefox, prefs, dir) {
  if (!firefox) return { args: [], env: {}, policy: null, unpinned: [] };
  const { policy, unpinned } = devtoolsFirefoxPolicy(firefox, prefs);
  let path = null;
  if (policy) {
    path = join(dir, 'firefox-policies.json');
    const Preferences = Object.fromEntries(policy.map((k) => [k, { Value: prefs[k], Status: 'user' }]));
    writeFileSync(path, JSON.stringify({ policies: { Preferences } }, null, 2));
  }
  return {
    args: ['--firefox-path', firefox.binary],
    env: path ? { PLAYWRIGHT_FIREFOX_POLICIES_JSON: path } : {},
    policy,
    unpinned,
  };
}

// A Firefox build as its files describe it: application.ini's Version and
// BuildID, and whether pdf.js is on. `binary` null means systemFirefox().
// `launch` says how the pinned prefs reach the browser: 'playwright', whose
// launch sets them again over playwright.cfg once the browser is up, or
// firefox-devtools-mcp's devtoolsFirefoxLaunch() or devtoolsFirefoxPolicy()
// result, whose --pref flags land in user.js under the cfg unless a policy sets
// them back. It has no default, since each answer is wrong for the other tool.
export function firefoxBuild(binary, launch) {
  if (launch !== 'playwright' && (launch == null || typeof launch !== 'object')) {
    throw new TypeError("firefoxBuild: launch is 'playwright' or a devtoolsFirefoxLaunch() or devtoolsFirefoxPolicy() result");
  }
  const path = binary ?? systemFirefox();
  if (!path) return null;
  const dir = dirname(path);
  const nearby = (name) => [join(dir, '..', 'Resources', name), join(dir, name), join(dir, 'browser', name)];
  const ini = nearby('application.ini').map(readText).find((t) => t != null) ?? '';
  const field = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(ini)?.[1]?.trim() ?? null;
  const cfgOff = cfgOverrides(path, { 'pdfjs.disabled': false }).overridden['pdfjs.disabled'];
  const pinned = PINNED_PREFS['pdfjs.disabled'];
  const byPolicy = launch !== 'playwright' && (launch.policy ?? []).includes('pdfjs.disabled');
  return {
    binary: path,
    version: field('Version'),
    buildID: field('BuildID'),
    pdfjs:
      pinned === true
        ? 'disabled by a pinned pref'
        : !cfgOff
          ? 'enabled'
          : pinned !== false
            ? 'disabled by playwright.cfg'
            : cfgOff.locked
              ? 'disabled by playwright.cfg, which locks it'
              : launch === 'playwright'
                ? 'enabled by a pinned pref over playwright.cfg'
                : byPolicy
                  ? 'enabled by a pinned policy over playwright.cfg'
                  : 'disabled by playwright.cfg, which a --pref cannot override',
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
    // The instructions the server's initialize reply carried, which an agent's
    // client puts into its prompt; null for a server that sends none.
    instructions: () => client.getInstructions() ?? null,
    close: () => client.close().catch(() => {}),
  };
}
