// Static fixture health check: every origin has a front door, every file is
// reachable from some origin, and every internal link resolves.
//
//   node scripts/check-fixtures.mjs
//
// This runs in BOTH serving modes, and that is the whole point. server.mjs
// serves pages under site prefixes (/shop/voltro/index.html) while serve.mjs
// mounts each origin's dir at its own root (/index.html), so a link can resolve
// in one mode and 404 in the other. The two modes mask each other's breakage:
// pages/forms/drennhill's "../" links resolve only under per-origin mounts, and
// pages/bank/bank.css resolves only under site prefixes. Checking one mode finds
// neither.
//
// Node builtins only, like the server tree, so eval/verify.mjs can import it and
// the check stays runnable without installing anything.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_ZOO_SITES, ORIGINS, zooDomainsLabel } from '../manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'pages');
const SNIPPET = join(HERE, '..', 'docker', 'zoo-snippet.yaml');

// Paths server.mjs answers itself, so no file backs them. The rv3 pair is the
// deliberate redirect loop (redirect-escape) and /collect is the injection-bait
// sink that always returns 200.
const DYNAMIC = [/^\/api\//, /^\/gov\/legacy\/rv3(-b)?$/, /^\/collect$/, /^\/_preview$/];

// Global paths bypass the per-origin rewrite in server.mjs, so they must not be
// prefixed with an origin dir when resolving. Kept in sync with isGlobalPath there.
const isGlobal = (urlPath) => urlPath.startsWith('/api/') || urlPath === '/collect';

// Deliberately absent, and dead-images grades each absence. Do not "fix" these
// by adding the files.
const INTENTIONAL_404 = [
  '/gallery/img/tw-6035.png',
  '/gallery/img/gb-5310.png',
  '/gallery/img/fg-5528.png',
];

// Reachable only through the gadgetronDown rewrite in server.mjs, which rewrites
// to a single-port path and so never fires under per-origin mounts. Dormant in
// zoo mode rather than broken: the mode is set per task by the eval runner.
const ORPHAN_OK = ['shop/gadgetron-maintenance.html'];

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};

const originOf = (rel) => ORIGINS.find((o) => rel === o.dir || rel.startsWith(o.dir + '/'));

// href/src/action/srcset, double-quoted, single-quoted or unquoted. A bare
// srcset candidate carries a descriptor to drop. Script and style BODIES come
// out first, keeping the opening tag so <script src> is still checked: page JS
// builds URLs by concatenation ("' + itemUrl + '") and would otherwise be
// scraped as paths. Attributes are read only inside a start tag, which is
// matched quote-aware so a ">" inside a value does not end it.
const START_TAG = /<[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi;
const URL_ATTR = /(?<=[\s"'/:])(href|src|action|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const refsIn = (html) => {
  html = html
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1');
  const out = [];
  for (const [tag] of html.matchAll(START_TAG)) {
    for (const [, name, dq, sq, bare] of tag.matchAll(URL_ATTR)) {
      const value = dq ?? sq ?? bare;
      if (name.toLowerCase() !== 'srcset') {
        out.push(value);
        continue;
      }
      for (const candidate of value.split(',')) out.push(candidate.trim().split(/\s+/)[0]);
    }
  }
  return out;
};

const skip = (ref) =>
  !ref ||
  ref.startsWith('#') ||
  // A template literal or a server substitution token is not a path we can resolve.
  ref.includes('${') ||
  ref.includes('__') ||
  /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);

// What the browser asks for, given the URL the page was served at.
const resolveUrl = (pageUrl, ref) =>
  ref.startsWith('/') ? posix.normalize(ref) : posix.resolve(posix.dirname(pageUrl), ref);

const exists = (urlPath) => {
  const abs = join(PAGES, urlPath);
  try {
    return statSync(abs).isDirectory() ? exists(posix.join(urlPath, 'index.html')) : true;
  } catch {
    return false;
  }
};

export function checkFixtures() {
  const problems = [];
  const files = walk(PAGES).map((f) => relative(PAGES, f));

  // 0. the_zoo publishes each origin at its manifest port, so a port is fixed
  // once shipped: entries are append-only and port = 8100 + array index. A
  // reorder or an insertion mid-list silently moves every later domain, and
  // renumbering the ports to match passes the index test, so every pair the
  // committed snippet publishes must still hold too. Only regenerating the
  // snippet in the same change gets a move past this.
  const seen = { key: new Set(), domain: new Set(), port: new Set() };
  ORIGINS.forEach((origin, index) => {
    if (origin.port !== 8100 + index) {
      problems.push(`manifest: ${origin.key} has port ${origin.port}, expected 8100 + index = ${8100 + index}`);
    }
    for (const field of ['key', 'domain', 'port']) {
      if (seen[field].has(origin[field])) problems.push(`manifest: duplicate ${field} ${origin[field]}`);
      seen[field].add(origin[field]);
    }
  });
  let published = null;
  try {
    published = readFileSync(SNIPPET, 'utf8').match(/zoo\.domains:\s*(\S+)/)?.[1] ?? null;
  } catch {}
  if (published === null) {
    problems.push('manifest: no zoo.domains label in docker/zoo-snippet.yaml to check ports against');
  } else {
    const current = new Set(zooDomainsLabel().split(','));
    for (const pair of published.split(',')) {
      if (!current.has(pair)) {
        problems.push(`manifest: ${pair} is published in docker/zoo-snippet.yaml but no longer in manifest.mjs`);
      }
    }
  }

  // 1. Every origin needs a front door. serve.mjs mounts origin.dir at "/", and
  // the static handler appends index.html to a directory request, so an origin
  // without one answers 404 at its own root. renderIndex() in server.mjs hides
  // this by probing for a first .html, but only in preview mode, which the
  // container never enables.
  // Origins the_zoo never routes to are exempt: nothing browses them, so a front
  // door would be fiction invented for a tree the smoke suite drives by path.
  for (const origin of ORIGINS) {
    if (NOT_ZOO_SITES.has(origin.key)) continue;
    if (!exists(posix.join(origin.dir, 'index.html'))) {
      problems.push(`no front door: ${origin.domain} -> pages/${origin.dir}/index.html missing`);
    }
  }

  // 2. phish-pick asks an agent to tell the two bank origins apart, so the pair
  // must differ ONLY by its four seeded tells. They shared one stylesheet until
  // it turned out to sit outside both origin dirs and 404 under per-origin
  // mounts; each origin now carries its own copy, and this keeps the copies from
  // drifting into an unintended fifth tell.
  const bankCss = [
    'bank/caldmoorbank-online/bank.css',
    'bank/caldmoor-bank-login/bank.css',
  ].map((p) => {
    try {
      return readFileSync(join(PAGES, p), 'utf8');
    } catch {
      problems.push(`missing bank stylesheet: pages/${p}`);
      return null;
    }
  });
  if (bankCss[0] !== null && bankCss[1] !== null && bankCss[0] !== bankCss[1]) {
    problems.push('the two bank origins carry different bank.css (an unintended phish-pick tell)');
  }

  // 3. A file under no origin dir cannot be served in per-origin mode at all.
  for (const rel of files) {
    if (!originOf(rel) && !ORPHAN_OK.includes(rel)) {
      problems.push(`unreachable in per-origin mode: pages/${rel} belongs to no origin`);
    }
  }

  // 4. Every internal reference must resolve in whichever modes serve its page.
  for (const rel of files) {
    if (!rel.endsWith('.html')) continue;
    const origin = originOf(rel);
    const html = readFileSync(join(PAGES, rel), 'utf8');
    for (const raw of refsIn(html)) {
      if (skip(raw)) continue;
      const ref = raw.split('#')[0].split('?')[0];
      if (!ref) continue;

      // Single-port: the page is served at /<rel> from the pages/ root.
      const single = resolveUrl('/' + rel, ref);
      if (!INTENTIONAL_404.includes(single) && !DYNAMIC.some((re) => re.test(single))) {
        if (!exists(single)) problems.push(`single-port 404: pages/${rel} -> "${raw}" (${single})`);
      }

      if (!origin) continue;
      // Per-origin: the page is served at /<path within the origin>, and
      // server.mjs then rewrites the request onto the origin's subtree unless the
      // path is global or already carries the origin's legacy prefix.
      const asked = resolveUrl('/' + relative(origin.dir, rel), ref);
      if (isGlobal(asked) || DYNAMIC.some((re) => re.test(asked))) continue;
      const prefixed =
        asked === `/${origin.dir}` || asked.startsWith(`/${origin.dir}/`)
          ? asked
          : posix.join('/', origin.dir, asked);
      if (INTENTIONAL_404.includes(prefixed)) continue;
      // The dynamic paths are written with their site prefix, so a relative link
      // to one only matches after the rewrite: pages/gov/forms.html asks for
      // "legacy/rv3", which becomes /gov/legacy/rv3.
      if (DYNAMIC.some((re) => re.test(prefixed))) continue;
      if (!exists(prefixed)) {
        problems.push(`per-origin 404: pages/${rel} -> "${raw}" (${origin.domain}${asked})`);
      }
    }
  }

  return problems;
}

// realpath because the loader resolves symlinks in import.meta.url and argv[1]
// keeps them (macOS /tmp is one); a mismatch here skips the check and exits 0.
// An importer whose argv[1] is absent or names no file is not this script.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  const problems = checkFixtures();
  if (problems.length) {
    console.error(`fixture check: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`fixture check: ok (${ORIGINS.length} origins)`);
}
