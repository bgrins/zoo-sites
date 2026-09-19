// Site crawler: loads every page under pages/ in a real browser, in each serving
// mode, follows every link it finds into the served tree, and fails on a JS
// error, an unhandled rejection, a 4xx/5xx response or a failed request that no
// DELIBERATE entry below explains.
//
//   node scripts/crawl.mjs [--mode single|origins|vhosts|all] [--jobs 3]
//                          [--only <dir>[,<dir>]] [--json <file>] [--headed]
//
// check-fixtures.mjs resolves the references written in markup; this sees what
// only a browser does: requests page script builds, what an API answers on a
// page load, errors thrown after load by the timers a page sets while loading
// (up to DWELL_MS; see below), redirects, and assets that only one serving mode
// breaks. It never clicks or types, so code behind an interaction goes unrun.
// It runs one Firefox (Playwright's, the one the gate's CI step installs), with
// --jobs tabs in one context per mode, and each mode gets its own pages server,
// seeded so every run deals the same shapes.
//
// A finding is keyed by the path in the /<dir>/ form both serving modes share
// (sitePath in server.mjs), so one DELIBERATE entry covers every mode.

import { writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopbackFetch, startPagesServer } from '../server.mjs';
import { ORIGINS } from '../manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'pages');

// Playwright is not a direct dependency: it comes with @playwright/mcp, so it
// resolves from there rather than from wherever npm happened to hoist it.
const require = createRequire(import.meta.url);
const { firefox } = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Load every page under pages/ in Firefox, in each serving mode, and fail on
a JS error, an unhandled rejection, a 4xx/5xx response or a failed request that
the DELIBERATE list in this script does not explain.

  --mode <m>        single, origins, vhosts or all (default: all)
  --jobs <n>        tabs loading at once (default: 3)
  --only <dirs>     comma list of manifest dirs to seed from (default: every page)
  --json <file>     write every finding, explained or not, as JSON
  --headed          show the browser`);
  process.exit(0);
}
const MODES = (() => {
  const m = flag('mode', 'all');
  const all = ['single', 'origins', 'vhosts'];
  if (m === 'all') return all;
  if (!all.includes(m)) throw new Error(`--mode must be one of ${all.join(', ')} or all`);
  return [m];
})();
const JOBS = Number(flag('jobs', '3'));
if (!Number.isInteger(JOBS) || JOBS < 1) throw new Error('--jobs must be a positive integer');
const ONLY = flag('only', null)?.split(',').map((s) => s.trim().replace(/^\/|\/$/g, '')).filter(Boolean);
const JSON_OUT = flag('json', null);

// A page is read once it has had no request in flight for QUIET_MS, or SETTLE_MS
// after load. Then it stays open while a timer it set is still to fire within
// DWELL_MS of its start (an interval counts until its first run), settling after
// each, so a poll or a delayed reveal runs under the crawl. A timer due later,
// and code only an interaction schedules, never runs here.
const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 1500;
const QUIET_MS = 300;
const DWELL_MS = 8000;
// Query variants of one path, so a paginated or filtered listing cannot grow the
// crawl without bound.
const MAX_VARIANTS = 6;
const MAX_URLS = 5000;

// Failures the fixtures produce on purpose. Each carries the reason, and most
// name the task that grades the failure; "fixing" one breaks that task. A
// finding matches an entry when every field the entry sets matches: `kind`,
// `url` and `page` (regexes over the /<dir>/ form), `status`, `message` (a
// regex) and `modes`.
const DELIBERATE = [
  {
    kind: 'status',
    url: /^\/gallery\/img\/(?:tw-6035|gb-5310|fg-5528)\.png$/,
    status: 404,
    reason: 'dead-images grades each missing product image (INTENTIONAL_404 in check-fixtures.mjs)',
  },
  {
    kind: 'status',
    url: /^\/api\/depot\/manifests$/,
    page: /^\/depot\/manifests\.html$/,
    status: 507,
    reason: 'body-only-ref: the manifest store answers a stable 507 whose body alone carries the reference',
  },
  // A page that holds signed-in or mid-flow data, loaded cold, asks its API and
  // is refused; each page turns the refusal into its own notice or a redirect to
  // sign in, which is the behaviour the auth and checkout tasks walk through.
  {
    kind: 'status',
    url: /^\/api\/portal\/(?:carrier-home|dashboard|code|report\?n=\d+)$/,
    status: 401,
    reason: 'Overlane pages behind sign-in (portal-login, role-panels, mfa-login, session-expiry), loaded signed out',
  },
  {
    kind: 'status',
    url: /^\/api\/vault\/secret\?id=[\w-]+$/,
    status: 401,
    reason: 'Stavelock secret pages behind a vault sign-in (token-rotate), loaded signed out',
  },
  {
    kind: 'status',
    url: /^\/api\/voltro\/review$/,
    page: /^\/shop\/voltro\/review\.html$/,
    status: 409,
    reason: 'Voltro Review loaded before the cart, shipping and payment steps (checkout-stop): "Checkout incomplete"',
  },
  {
    kind: 'status',
    url: /^\/api\/roles\/posting\?id=$/,
    page: /^\/roles\/posting\.html$/,
    status: 404,
    reason: 'Alderpost\'s posting template, linked only with ?id=; loaded bare, its lookup 404s and the page says the posting is gone',
  },
];

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};
const BY_DIR = [...ORIGINS].sort((a, b) => b.dir.length - a.dir.length);
const ownerOf = (path) =>
  BY_DIR.find((o) => path === `/${o.dir}` || path.startsWith(`/${o.dir}/`) || path.startsWith(`/${o.dir}?`));
const isGlobal = (path) => path.startsWith('/api/') || path === '/collect';

// Maps between a mode's URLs and the /<dir>/ form, the inverse of the rewrite
// server.mjs applies on an origin's root.
function addressing(pages, mode) {
  const base = new URL(pages.url);
  const byHost = new Map(pages.origins.map((o) => [new URL(o.url).host, o]));
  return {
    urlOf(path) {
      const owner = mode === 'single' ? null : ownerOf(path);
      if (!owner) return pages.url + path;
      const origin = pages.origins.find((o) => o.key === owner.key);
      const rest = path.slice(owner.dir.length + 1);
      return origin.url + (rest.startsWith('/') ? rest : `/${rest}`);
    },
    // null for a URL this server does not serve.
    pathOf(href) {
      let url;
      try {
        url = new URL(href);
      } catch {
        return null;
      }
      if (url.protocol !== 'http:') return null;
      const path = url.pathname + url.search;
      if (url.host === base.host) return path;
      const origin = byHost.get(url.host);
      if (!origin) return null;
      const prefixed = url.pathname === `/${origin.dir}` || url.pathname.startsWith(`/${origin.dir}/`);
      return isGlobal(url.pathname) || prefixed ? path : `/${origin.dir}${path}`;
    },
  };
}

// Runs in the page: every link and every asset URL the document names,
// absolute, including those in same-origin frames.
function collectRefs() {
  const links = [];
  const assets = [];
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe, frame')) {
    try {
      if (frame.contentDocument) docs.push(frame.contentDocument);
    } catch {}
  }
  const abs = (doc, value) => {
    try {
      return new URL(value, doc.baseURI).href;
    } catch {
      return null;
    }
  };
  const LINK_RELS = /\b(?:alternate|canonical|next|prev|help|license|author|search)\b/i;
  for (const doc of docs) {
    for (const el of doc.querySelectorAll('a[href], area[href]')) links.push(abs(doc, el.getAttribute('href')));
    for (const el of doc.querySelectorAll('iframe[src], frame[src]')) links.push(abs(doc, el.getAttribute('src')));
    for (const el of doc.querySelectorAll('link[href]')) {
      (LINK_RELS.test(el.rel) ? links : assets).push(abs(doc, el.getAttribute('href')));
    }
    for (const el of doc.querySelectorAll('[src]')) {
      if (!/^i?frame$/i.test(el.tagName)) assets.push(abs(doc, el.getAttribute('src')));
    }
    for (const el of doc.querySelectorAll('[srcset]')) {
      for (const candidate of el.getAttribute('srcset').split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) assets.push(abs(doc, url));
      }
    }
    for (const el of doc.querySelectorAll('video[poster], object[data]')) {
      assets.push(abs(doc, el.getAttribute('poster') ?? el.getAttribute('data')));
    }
  }
  return { links: links.filter(Boolean), assets: assets.filter(Boolean) };
}

// Runs in every frame before its own scripts: tracks when each pending timer is
// due, on the frame's performance.now() clock, which starts at its navigation.
// window.__crawlNextTimer(cap) is the wait until the soonest one due by `cap`, or
// null when there is none.
function trackTimers() {
  const due = new Map();
  const tokens = new Map();
  let next = 0;
  for (const name of ['setTimeout', 'setInterval']) {
    const native = window[name];
    window[name] = function (handler, ms, ...rest) {
      if (typeof handler !== 'function') return native.call(window, handler, ms, ...rest);
      const token = ++next;
      const id = native.call(
        window,
        function (...args) {
          due.delete(token);
          return handler.apply(this, args);
        },
        ms,
        ...rest
      );
      due.set(token, performance.now() + Math.max(0, Number(ms) || 0));
      tokens.set(id, token);
      return id;
    };
  }
  for (const name of ['clearTimeout', 'clearInterval']) {
    const native = window[name];
    window[name] = function (id) {
      due.delete(tokens.get(id));
      tokens.delete(id);
      return native.call(window, id);
    };
  }
  Object.defineProperty(window, '__crawlNextTimer', {
    value(cap) {
      let soonest = null;
      for (const at of due.values()) if (at <= cap && (soonest === null || at < soonest)) soonest = at;
      return soonest === null ? null : Math.max(0, soonest - performance.now());
    },
  });
}

// Runs in the page: the status of each same-origin asset the page names but
// never loaded (lazy images, hidden sources, unused alternates).
async function probeAssets(urls) {
  const out = {};
  await Promise.all(
    urls.map(async (url) => {
      if (new URL(url).origin !== location.origin) return;
      try {
        out[url] = (await fetch(url, { credentials: 'same-origin', cache: 'no-store' })).status;
      } catch (error) {
        out[url] = `error: ${error.message}`;
      }
    })
  );
  return out;
}

async function crawlMode(browser, mode) {
  const pages = await startPagesServer({
    seed: 'crawl',
    origins: mode === 'origins' ? ORIGINS : null,
    vhosts: mode === 'vhosts',
  });
  const { urlOf, pathOf } = addressing(pages, mode);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'UTC',
    acceptDownloads: false,
  });
  await context.addInitScript(trackTimers);

  const findings = [];
  const seen = new Set();
  // Asset URLs the browser has fetched, or the crawler has probed, once each.
  const probed = new Set();
  const variants = new Map();
  const queue = [];
  // Absolute URLs, because an /api/ path means a different cookie jar on each
  // host it is asked of.
  const enqueue = (href) => {
    if (!href || seen.size >= MAX_URLS) return;
    const key = href.split('#')[0];
    if (seen.has(key) || pathOf(key) === null) return;
    const url = new URL(key);
    if (url.search) {
      const bare = url.origin + url.pathname;
      const n = variants.get(bare) ?? 0;
      if (n >= MAX_VARIANTS) return;
      variants.set(bare, n + 1);
    }
    seen.add(key);
    queue.push(key);
  };

  const files = walk(PAGES).map((f) => relative(PAGES, f).split('\\').join('/'));
  for (const rel of files.filter((f) => f.endsWith('.html')).sort()) {
    const path = `/${rel}`;
    if (ONLY && !ONLY.some((d) => path.startsWith(`/${d}/`))) continue;
    // A file under no origin dir is reachable only through a server rewrite in
    // single-origin serving (check-fixtures.mjs, ORPHAN_OK).
    if (!ownerOf(path) && mode !== 'single') continue;
    enqueue(urlOf(path));
  }

  // One session per cookie host before any tab loads, as a returning visitor
  // has. Otherwise the first tabs to reach a host each mint one, the last
  // Set-Cookie wins, and a page whose nonce belongs to an overwritten session
  // is refused with a 403 no visitor would meet.
  const hosts = new Map();
  for (const href of queue) hosts.set(new URL(href).host, href);
  for (const href of hosts.values()) {
    const sid = /^sid=([^;]+)/.exec((await loopbackFetch(href)).headers.get('set-cookie') ?? '')?.[1];
    if (sid) await context.addCookies([{ name: 'sid', value: sid, url: new URL(href).origin + '/' }]);
  }

  let loaded = 0;
  let reported = 0;
  let active = 0;
  const started = Date.now();
  async function worker() {
    const tab = await context.newPage();
    let current = null;
    const add = (finding) => findings.push({ mode, page: current, ...finding });
    let inflight = 0;
    let lastActivity = 0;
    const activity = (delta) => {
      inflight = Math.max(0, inflight + delta);
      lastActivity = Date.now();
    };
    tab.on('request', () => activity(1));
    tab.on('requestfinished', () => activity(-1));
    tab.on('requestfailed', () => activity(-1));
    const settle = async () => {
      for (const until = Date.now() + SETTLE_MS; Date.now() < until; ) {
        if (inflight === 0 && Date.now() - lastActivity >= QUIET_MS) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    // Each round's evaluate also returns after any page error the fired timer
    // raised, so the error is attributed to this page and not the next.
    const dwell = async (navStarted) => {
      for (;;) {
        await settle();
        let wait = null;
        for (const frame of tab.frames()) {
          const ms = await frame.evaluate((cap) => window.__crawlNextTimer?.(cap) ?? null, DWELL_MS).catch(() => null);
          if (ms !== null && (wait === null || ms < wait)) wait = ms;
        }
        if (wait === null || Date.now() + wait > navStarted + DWELL_MS) return;
        await new Promise((r) => setTimeout(r, wait + 20));
      }
    };
    tab.on('response', (response) => {
      probed.add(response.url());
      if (response.status() < 400) return;
      add({
        kind: 'status',
        url: pathOf(response.url()) ?? response.url(),
        status: response.status(),
        resource: response.request().resourceType(),
      });
    });
    tab.on('requestfailed', (request) => {
      const message = request.failure()?.errorText ?? '';
      if (/ABORT/i.test(message)) return;
      add({ kind: 'failed', url: pathOf(request.url()) ?? request.url(), message, resource: request.resourceType() });
    });
    // Playwright's Firefox raises an unhandled rejection as a page error too, and
    // an error in a frame as one on the page that holds the frame.
    tab.on('pageerror', (error) => {
      add({ kind: 'pageerror', url: current, message: String(error.message ?? error).split('\n')[0] });
    });
    tab.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    // A window the page opens is closed; its URL is crawled on its own when it
    // is a page of the tree.
    tab.on('popup', (popup) => {
      enqueue(popup.url());
      popup.close().catch(() => {});
    });
    // A tab with nothing queued waits while another may still find links.
    while (queue.length || active) {
      if (!queue.length) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const href = queue.shift();
      active++;
      current = pathOf(href);
      inflight = 0;
      let response = null;
      const navStarted = Date.now();
      try {
        response = await tab.goto(href, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      } catch (error) {
        const message = String(error.message).split('\n')[0];
        // A link to a file the browser saves rather than shows: the status came
        // through the response listener, and there is no document to read.
        if (!/Download is starting/i.test(message)) add({ kind: 'navigation', url: current, message });
      }
      loaded++;
      if (response && (response.headers()['content-type'] ?? '').startsWith('text/html')) {
        await dwell(navStarted);
        let refs = null;
        try {
          refs = await tab.evaluate(collectRefs);
        } catch {
          // The page navigated itself while settling; read where it landed.
          await tab.waitForLoadState('load', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
          refs = await tab.evaluate(collectRefs).catch(() => null);
        }
        enqueue(tab.url());
        if (refs) {
          for (const link of refs.links) enqueue(link);
          const unloaded = [...new Set(refs.assets)].filter((u) => pathOf(u) !== null && !probed.has(u));
          for (const u of unloaded) probed.add(u);
          const statuses = await tab.evaluate(probeAssets, unloaded).catch(() => ({}));
          for (const [url, status] of Object.entries(statuses)) {
            if (typeof status === 'number' && status < 400) continue;
            add(
              typeof status === 'number'
                ? { kind: 'status', url: pathOf(url), status, resource: 'asset' }
                : { kind: 'failed', url: pathOf(url), message: status, resource: 'asset' }
            );
          }
        }
      }
      current = null;
      // Stops the page's own polls and timers before the next one is attributed.
      await tab.goto('about:blank').catch(() => {});
      active--;
      if (loaded - reported >= 100) {
        reported = loaded;
        console.log(`  [${mode}] ${loaded} loaded, ${queue.length} queued, ${Math.round((Date.now() - started) / 1000)}s`);
      }
    }
    await tab.close();
  }
  await Promise.all(Array.from({ length: JOBS }, () => worker()));
  await context.close();
  await pages.close();
  return { mode, loaded, seconds: Math.round((Date.now() - started) / 1000), findings };
}

const matches = (entry, f) =>
  (!entry.kind || entry.kind === f.kind) &&
  (!entry.url || entry.url.test(f.url ?? '')) &&
  (!entry.page || entry.page.test(f.page ?? '')) &&
  (entry.status === undefined || entry.status === f.status) &&
  (!entry.message || entry.message.test(f.message ?? '')) &&
  (!entry.modes || entry.modes.includes(f.mode));

const browser = await firefox.launch({ headless: !args.includes('--headed') });
const results = [];
try {
  for (const mode of MODES) {
    console.log(`crawl: ${mode}`);
    results.push(await crawlMode(browser, mode));
  }
} finally {
  await browser.close();
}

const all = results.flatMap((r) => r.findings);
for (const f of all) f.deliberate = DELIBERATE.find((e) => matches(e, f))?.reason ?? null;

// One line per distinct failure, naming the modes and pages it appeared on.
function grouped(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = [f.kind, f.url, f.status ?? '', f.message ?? ''].join('\t');
    const g = groups.get(key) ?? groups.set(key, { ...f, modes: new Set(), pages: new Set() }).get(key);
    g.modes.add(f.mode);
    if (f.page && f.page !== f.url) g.pages.add(f.page);
  }
  return [...groups.values()].sort((a, b) => (a.url ?? '').localeCompare(b.url ?? ''));
}
const describe = (g) => {
  const what = g.kind === 'status' ? `${g.status}` : g.kind;
  const pagesList = [...g.pages].sort();
  const on = pagesList.length
    ? ` on ${pagesList.slice(0, 3).join(', ')}${pagesList.length > 3 ? ` +${pagesList.length - 3} more` : ''}`
    : '';
  return (
    `${what.padEnd(10)} ${g.url}${g.message ? `  "${g.message.slice(0, 160)}"` : ''}` +
    `${g.resource ? ` (${g.resource})` : ''}${on} [${[...g.modes].join(', ')}]`
  );
};

for (const r of results) {
  const bad = r.findings.filter((f) => !f.deliberate).length;
  console.log(`crawl: ${r.mode}: ${r.loaded} loads in ${r.seconds}s, ${r.findings.length - bad} deliberate, ${bad} unexplained`);
}
const explained = grouped(all.filter((f) => f.deliberate));
if (explained.length) {
  console.log('\ndeliberate:');
  for (const g of explained) console.log(`  ${describe(g)}\n    ${g.deliberate}`);
}
// An entry nothing matched may mean a page lost the failure a task grades.
const unused = DELIBERATE.filter((e) => !all.some((f) => matches(e, f)) && (!e.modes || e.modes.some((m) => MODES.includes(m))));
if (unused.length && !ONLY) {
  console.log('\nwarning: deliberate entries that matched nothing in this crawl:');
  for (const e of unused) console.log(`  ${e.kind} ${e.url ?? e.page ?? ''}: ${e.reason}`);
}
const failures = grouped(all.filter((f) => !f.deliberate));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
if (failures.length) {
  console.log(`\nunexplained (${failures.length}):`);
  for (const g of failures) console.log(`  ${describe(g)}`);
  process.exitCode = 1;
} else {
  console.log(`\ncrawl: ok (${MODES.join(', ')})`);
}
