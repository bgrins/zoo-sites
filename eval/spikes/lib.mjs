// Shared plumbing for the capability spikes: each condition's MCP server
// spawned the way eval/run.mjs spawns it, a probe page server that records
// every input event its pages see, and a finding log that compares each
// observation with the value last measured.

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentEnv } from '../agent-env.mjs';
import {
  DEVTOOLS_SERVER_ENV, devtoolsFirefox, devtoolsFirefoxLaunch, devtoolsMcpEntry, devtoolsMcpInfo, firefoxBuild, playwrightFirefox,
  startMcpServer,
} from '../mcp-stdio.mjs';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_MCP_ROOT = dirname(require.resolve('@playwright/mcp/package.json'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Firefox outlives its MCP server by a few hundred ms, and meanwhile writes its
// session store into a seeded profile, recreating a scratch directory removed
// too early. Wait for every process whose command line names `dir` to exit;
// without ps, wait a fixed two seconds.
async function untilUnused(dir, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    let ps;
    try {
      ps = execFileSync('ps', ['axww', '-o', 'command='], { encoding: 'utf8' });
    } catch {
      return sleep(2000);
    }
    if (!ps.includes(dir)) return;
    await sleep(200);
  }
}

export const textOf = (result) =>
  (result.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');

export function packageVersions() {
  const pw = JSON.parse(readFileSync(join(PLAYWRIGHT_MCP_ROOT, 'package.json'), 'utf8')).version;
  return { devtools: devtoolsMcpInfo().version, playwright: pw };
}

// One condition's browser. `call` never throws: a tool error comes back as
// text starting ERROR and a transport failure as THROW, because what a tool
// reports on failure is part of what a spike records. playwright-mcp writes
// snapshots and downloads under its cwd and --output-dir, so both point at a
// scratch directory that close() removes, never at the repo.
//
// `prefs(scratch)` (devtools only) returns prefs for a seeded profile's
// user.js. The tool launches Firefox from
// <--profile-path>/firefox_devtools_mcp_profile, so the file lands there and
// in the parent, as eval/window-grid.mjs does. `args(scratch)` (devtools
// only) returns more server flags, such as the --viewport and --pref flags a
// paid run launches with. The devtools server launches the Firefox
// EVAL_DEVTOOLS_FIREFOX names, as the gate's do, and `browser` is the build
// the surface launched (mcp-stdio.mjs firefoxBuild).
export async function surface(name, { prefs, args: extra } = {}) {
  // Resolved, because playwright-mcp compares file paths against its allowed
  // roots after resolving symlinks (macOS /var is /private/var).
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zoo-spike-')));
  let profile = [];
  const given = prefs && name === 'devtools' ? { ...prefs(scratch) } : {};
  if (prefs && name === 'devtools') {
    const dir = join(scratch, 'profile');
    const userJs = Object.entries(given)
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`)
      .join('');
    for (const d of [dir, join(dir, 'firefox_devtools_mcp_profile')]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'user.js'), userJs);
    }
    profile = ['--profile-path', dir];
  }
  const extraArgs = name === 'devtools' && extra ? extra(scratch) : [];
  // The prefs the browser is handed, from user.js and --pref alike, parsed as
  // firefox-devtools-mcp parses a --pref value.
  for (let i = 0; i < extraArgs.length - 1; i++) {
    if (extraArgs[i] !== '--pref') continue;
    const [k, v] = extraArgs[i + 1].split(/=(.*)/s);
    given[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  const pin = name === 'devtools' ? devtoolsFirefox() : null;
  const firefox = name === 'devtools' ? devtoolsFirefoxLaunch(pin, given, scratch) : null;
  const args =
    name === 'devtools'
      ? [devtoolsMcpEntry(), '--enable-script', '--headless', ...profile, ...firefox.args, ...extraArgs]
      : [
          join(PLAYWRIGHT_MCP_ROOT, 'cli.js'),
          '--browser',
          'firefox',
          '--isolated',
          '--headless',
          '--output-dir',
          join(scratch, 'out'),
        ];
  // The allowlisted environment run.mjs gives a server, so CONNECT_EXISTING or
  // TOOL_PRESET in the operator's shell cannot reconfigure the one measured.
  const server = await startMcpServer({
    args,
    cwd: scratch,
    env: name === 'devtools' ? { ...DEVTOOLS_SERVER_ENV, ...firefox.env } : {},
    baseEnv: agentEnv(null),
  });
  const call = async (tool, toolArgs = {}) => {
    try {
      const r = await server.call(tool, toolArgs);
      return (r.isError ? 'ERROR ' : '') + textOf(r);
    } catch (error) {
      return `THROW ${error.message}`;
    }
  };
  const dt = name === 'devtools';
  const s = {
    name,
    scratch,
    browser: dt ? firefoxBuild(pin?.binary ?? null, firefox) : firefoxBuild(playwrightFirefox(), 'playwright'),
    call,
    tools: async () => (await server.listTools()).tools,
    navigate: (url) => call(dt ? 'navigate_page' : 'browser_navigate', { url }),
    snapshot: (opts = {}) => call(dt ? 'take_snapshot' : 'browser_snapshot', opts),
    // The page-side value of a function source, parsed from each surface's
    // own result framing; unparseable output comes back as raw text.
    evaluate: async (fn) => {
      const out = await call(dt ? 'evaluate_script' : 'browser_evaluate', { function: String(fn) });
      const body = dt
        ? out.match(/```json\n([\s\S]*?)\n```/)?.[1]
        : out.match(/### Result\n([\s\S]*?)(?:\n###|$)/)?.[1]?.trim();
      if (body === undefined) return out;
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    },
    // The uid (devtools) or ref (playwright) on the first snapshot line
    // matching `re`.
    target: (snap, re) => {
      for (const line of snap.split('\n')) {
        if (!re.test(line)) continue;
        const m = line.match(/uid=(\S+)|\[ref=(\w+)\]/);
        if (m) return m[1] ?? m[2];
      }
      return null;
    },
    firefox: async () => {
      const ua = await s.evaluate(() => navigator.userAgent);
      return String(ua).match(/Firefox\/([\d.]+)/)?.[1] ?? 'unknown';
    },
    close: async () => {
      await server.close();
      await untilUnused(scratch);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  return s;
}

// Every probe page gets this logger: each input event it sees reaches the
// server with isTrusted and the fields a spike asks about. Beacons can arrive
// out of order, so each carries its page-clock time and drain() sorts on it.
const LOGGER = `<script>
let seq = 0;
const L = (k, d) => navigator.sendBeacon('/__log', JSON.stringify({ k, d, t: performance.timeOrigin + performance.now(), n: seq++ }));
window.L = L;
for (const ev of ['pointerdown','pointerup','pointermove','mousedown','mouseup','click','contextmenu','mouseenter','mouseover','pointerenter','dragstart','drop','keydown','keyup','paste','beforeinput','input','change','focusin','submit'])
  document.addEventListener(ev, (e) => L(ev, { tag: e.target?.tagName, id: e.target?.id, trusted: e.isTrusted, key: e.key, code: e.code, btn: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, pt: e.pointerType, it: e.inputType, data: e.data ?? null, detail: e.detail, x: e.clientX, y: e.clientY }), true);
</script>`;

export const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${LOGGER}</head><body>${body}</body></html>`;

// A loopback server for probe pages. `routes` maps a path to an HTML string
// or to a (req, res, body) handler; every request lands in `requests` and
// every logged event in `events`.
export async function probeServer(routes) {
  const events = [];
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://probe');
    let body = '';
    for await (const chunk of req) body += chunk;
    if (url.pathname === '/__log') {
      try {
        events.push(JSON.parse(body));
      } catch {}
      res.end();
      return;
    }
    requests.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body });
    const route = routes[url.pathname];
    if (typeof route === 'function') return route(req, res, body, url);
    if (typeof route === 'string') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(route.replaceAll('__ORIGIN__', `http://127.0.0.1:${srv.address().port}`));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    port: srv.address().port,
    events,
    requests,
    // Wait out sendBeacon delivery, then hand back and clear what arrived.
    drain: async (ms = 400) => {
      await sleep(ms);
      return events.splice(0).sort((a, b) => a.t - b.t || a.n - b.n);
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

// Findings, each compared with the value last measured. The measured value
// lives in the spike beside the probe, so rerunning after a version bump
// prints CHANGED where a tool's behaviour moved, and the exit status is 1.
export function findings(title) {
  const rows = [];
  return {
    record(label, observed, measured) {
      const same = JSON.stringify(observed) === JSON.stringify(measured);
      rows.push({ label, observed, measured, same });
      console.log(`${same ? 'same   ' : 'CHANGED'} ${label}: ${JSON.stringify(observed)}` +
        (same ? '' : `  (measured: ${JSON.stringify(measured)})`));
    },
    async header(...surfaces) {
      const v = packageVersions();
      const parts = [];
      for (const s of surfaces) {
        const pkg = s.name === 'devtools' ? `firefox-devtools-mcp ${v.devtools}` : `@playwright/mcp ${v.playwright}`;
        parts.push(`${pkg} (Firefox ${await s.firefox()})`);
      }
      console.log(`${title}\nrunning on: ${parts.join(', ')}\n`);
    },
    done() {
      const changed = rows.filter((r) => !r.same).length;
      console.log(`\n${rows.length} findings, ${changed} changed since measured`);
      process.exitCode = changed ? 1 : 0;
    },
  };
}
