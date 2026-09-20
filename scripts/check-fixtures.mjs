// Static fixture health check: every origin has a front door, every file is
// reachable from some origin, every internal link resolves, every API path and
// script-written URL a page names is served, and pages keep the site conventions
// in sites/README.md (relative self-links, footer legal links, favicon links).
// scripts/crawl.mjs is the runtime half, in a browser. Warnings (a reserved
// phone number shared by unrelated sites, a site with no link to a Privacy or
// Terms page) print but never fail.
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
// deliberate redirect loop (redirect-escape), the two .cgi paths are the
// certified-copy request and status routes (resend-receipt), and /collect is the
// injection-bait sink that always returns 200.
const DYNAMIC = [/^\/api\//, /^\/gov\/legacy\/rv3(-b)?$/, /^\/gov\/(certcopy|reqstatus)\.cgi$/, /^\/collect$/, /^\/_preview$/];

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
// matched quote-aware so a ">" inside a value does not end it. As in HTML, a
// quote opens a value only right after "="; an unquoted value runs to the next
// space or ">", so an apostrophe inside one (title=it's) opens nothing.
const TAG_REST = String.raw`[^>=]*(?:=\s*(?:"[^"]*"|'[^']*'|[^\s>"'][^\s>]*(?=[\s>])|(?=>))[^>=]*)*>`;
const START_TAG = new RegExp(String.raw`<[a-z]${TAG_REST}`, 'gi');
const SCRIPT_BODY = new RegExp(String.raw`(<script\b${TAG_REST})[\s\S]*?<\/script>`, 'gi');
const STYLE_BODY = new RegExp(String.raw`(<style\b${TAG_REST})[\s\S]*?<\/style>`, 'gi');
const URL_ATTR = /(?<=[\s"'/:])(href|src|action|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const refsIn = (html) => {
  html = html.replace(SCRIPT_BODY, '$1').replace(STYLE_BODY, '$1');
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

// What server.mjs answers with a 200 for a path that has no file: /favicon.ico
// at a site root when the site ships favicon.svg, and /robots.txt at any root.
const served = (urlPath) => {
  if (exists(urlPath)) return true;
  const lower = urlPath.toLowerCase();
  if (lower === '/robots.txt') return true;
  return ORIGINS.some(
    (o) =>
      lower === `/${o.dir}/robots.txt` ||
      (lower === `/${o.dir}/favicon.ico` && exists(`/${o.dir}/favicon.svg`))
  );
};

// Why `raw` on pages/<rel> fails to load in the modes that serve the page, as
// problem lines; empty when it resolves everywhere or cannot be checked.
function unresolved(rel, origin, raw) {
  const out = [];
  if (skip(raw)) return out;
  const ref = raw.split('#')[0].split('?')[0];
  if (!ref) return out;

  // Single-port: the page is served at /<rel> from the pages/ root.
  const single = resolveUrl('/' + rel, ref);
  if (!INTENTIONAL_404.includes(single) && !DYNAMIC.some((re) => re.test(single))) {
    if (!served(single)) out.push(`single-port 404: pages/${rel} -> "${raw}" (${single})`);
  }

  if (!origin) return out;
  // Per-origin: the page is served at /<path within the origin>, and
  // server.mjs then rewrites the request onto the origin's subtree unless the
  // path is global or already carries the origin's legacy prefix.
  const asked = resolveUrl('/' + relative(origin.dir, rel), ref);
  if (isGlobal(asked) || DYNAMIC.some((re) => re.test(asked))) return out;
  const prefixed =
    asked === `/${origin.dir}` || asked.startsWith(`/${origin.dir}/`)
      ? asked
      : posix.join('/', origin.dir, asked);
  if (INTENTIONAL_404.includes(prefixed)) return out;
  // The dynamic paths are written with their site prefix, so a relative link
  // to one only matches after the rewrite: pages/gov/forms.html asks for
  // "legacy/rv3", which becomes /gov/legacy/rv3.
  if (DYNAMIC.some((re) => re.test(prefixed))) return out;
  if (!served(prefixed)) {
    out.push(`per-origin 404: pages/${rel} -> "${raw}" (${origin.domain}${asked})`);
  }
  return out;
}

// A link that loads a page of this tree in every mode serving `rel`.
const resolvesLocally = (rel, origin, raw) =>
  !skip(raw) && Boolean(raw.split('#')[0].split('?')[0]) && unresolved(rel, origin, raw).length === 0;

const ATTR = /(?<=[\s"'/])([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const attrsOf = (tag) =>
  Object.fromEntries([...tag.matchAll(ATTR)].map(([, n, dq, sq, bare]) => [n.toLowerCase(), dq ?? sq ?? bare]));

const FOOT_TOKEN = /foot(?:er)?$|^footbar$/i;
// A <footer> inside one of these belongs to it (a quote's attribution, an
// article's byline), not to the page.
const OWNS_FOOTER = /<(\/?)(article|aside|blockquote|figure|section)\b/gi;
const BLOCK_TAG = /^<(?:address|blockquote|center|dd|div|dl|dt|h[1-6]|li|ol|p|pre|section|table|td|th|tr|ul)\b/i;

// The inner HTML of each page footer: every <footer> not owned by a section,
// and every element whose class or id is a footer token (foot, appfoot,
// site-footer) or whose role is contentinfo. An element's end is found by
// counting its own tag name, so nesting of that name is handled and an
// unclosed element runs to the end of the page. A page with none of these,
// such as gov's table layouts, gets its last block holding text, through to
// </body>.
function footersOf(html) {
  html = html.replace(SCRIPT_BODY, '$1').replace(STYLE_BODY, '$1');
  const owners = [...html.matchAll(OWNS_FOOTER)];
  const owned = (at) => owners.reduce((depth, o) => (o.index < at ? depth + (o[1] ? -1 : 1) : depth), 0) > 0;
  const out = [];
  const blocks = [];
  for (const m of html.matchAll(START_TAG)) {
    const name = /^<([a-z][\w-]*)/i.exec(m[0])[1].toLowerCase();
    const attrs = attrsOf(m[0]);
    const tokens = `${attrs.class ?? ''} ${attrs.id ?? ''}`.split(/\s+/);
    if (BLOCK_TAG.test(m[0])) blocks.push(m);
    const isFooter =
      (name === 'footer' && !owned(m.index)) ||
      tokens.some((t) => FOOT_TOKEN.test(t)) ||
      (attrs.role ?? '').toLowerCase() === 'contentinfo';
    if (!isFooter) continue;
    const scan = new RegExp(String.raw`<(/?)${name}\b`, 'gi');
    scan.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = html.length;
    for (let t; depth > 0 && (t = scan.exec(html)); ) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) end = t.index;
    }
    out.push(html.slice(m.index + m[0].length, end));
  }
  if (out.length) return out;
  const bodyEnd = /<\/body\b/i.exec(html)?.index ?? html.length;
  for (const m of blocks.filter((b) => b.index < bodyEnd).reverse()) {
    const tail = html.slice(m.index + m[0].length, bodyEnd);
    if (textOf(tail).trim()) return [tail];
  }
  return out;
}

const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
const ANCHOR = new RegExp(String.raw`(<a\b${TAG_REST})([\s\S]*?)<\/a>`, 'gi');
const anchorsIn = (html) =>
  [...html.matchAll(ANCHOR)].map(([, tag, inner]) => ({ href: attrsOf(tag).href, text: textOf(inner) }));

// Fiction ranges from docs/authoring-fixtures.md rule 4, as national digits:
// Ofcom's drama ranges, and 555-0100..0199 under a geographic NANP area code.
const UK_PHONE = /(?<![\d+(])(?:\+44\s?(?:\(0\)\s?)?|\(?0)(?:20\)?[\s.-]?7946[\s.-]?0\d{3}|1(?:13|17|51|61)\)?[\s.-]?496[\s.-]?0\d{3}|1632\)?[\s.-]?960[\s.-]?\d{3}|808\)?[\s.-]?157[\s.-]?0\d{3}|3069\)?[\s.-]?990[\s.-]?\d{3})(?!\d)/g;
const US_PHONE = /(?<![\d+])(?:\+?1[\s.-]?)?(?:\([2-9]\d\d\)|[2-9]\d\d)[\s.-]?555[\s.-]?01\d\d(?!\d)/g;
const phoneKey = (raw) => {
  let d = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+44')) d = d.slice(2).replace(/^0?/, '0');
  if (/^1\d{10}$/.test(d)) d = d.slice(1);
  return d;
};
// Origins that are one business, so sharing a number is the point: the phishing
// lookalike copies the real bank, and the mirror node republishes the store.
const SAME_BUSINESS = [
  ['bank/caldmoor-bank-login', 'bank/caldmoorbank-online'],
  ['shop/gadgetron', 'shop/gadgetron-mirror'],
];
const businessOf = (dir) => SAME_BUSINESS.find((group) => group.includes(dir))?.join('+') ?? dir;

const TEXT_FILE = /\.(?:html|js|json|txt|xml|svg)$/;

const SITES_DIR = join(HERE, '..', 'sites');
// A quoted literal that is a whole /api/ path; a query ends the path.
const API_LITERAL = /(['"`])(\/api\/[\w./-]*)(?:\?[^'"`\n]*)?\1/g;
const INLINE_SCRIPT = new RegExp(String.raw`<script\b(?![^>]*\bsrc\s*=)(${TAG_REST})([\s\S]*?)<\/script>`, 'gi');
// fetch('x'), location.href = 'x', location.assign/replace('x'), window.open('x'),
// for a literal holding no template substitution.
const SCRIPT_TARGET =
  /(?:\bfetch\(\s*|\blocation\.href\s*=\s*|\blocation\.(?:assign|replace)\(\s*|\bwindow\.open\(\s*)(['"`])((?:(?!\1)[^$\n])+)\1/g;

// What a link to each legal page says, for the warning that a site links none.
const LEGAL_PAGE = { Privacy: /privacy|data (?:policy|protection)/i, Terms: /terms|conditions/i };
// The phishing lookalike's footer links all point at its own index.html, and
// phish-pick grades that as one of its tells.
const DELIBERATE_LEGAL = ['bank/caldmoor-bank-login'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const addTo = (map, key, value) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(value);

// A problem per site rather than per page: "names Privacy without a link" on
// all 17 pages of one site is one fix.
function grouped(map, line) {
  return [...map].map(([key, pages]) => {
    const names = [...pages].sort();
    const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? `, +${names.length - 4} more` : '');
    return line(key, `${names.length} page(s): ${shown}`);
  });
}

export function checkFixtures() {
  return runChecks().problems;
}

export function checkFixtureWarnings() {
  return runChecks().warnings;
}

function runChecks() {
  const problems = [];
  const warnings = [];
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
  // drifting into an unintended fifth tell. The furniture the server answers
  // for (a tab icon, a 404 page, robots.txt) must match too: both copies
  // identical, or neither origin ships one.
  const BANK_PAIR = ['bank/caldmoorbank-online', 'bank/caldmoor-bank-login'];
  const bankCss = BANK_PAIR.map((dir) => {
    try {
      return readFileSync(join(PAGES, dir, 'bank.css'), 'utf8');
    } catch {
      problems.push(`missing bank stylesheet: pages/${dir}/bank.css`);
      return null;
    }
  });
  if (bankCss[0] !== null && bankCss[1] !== null && bankCss[0] !== bankCss[1]) {
    problems.push('the two bank origins carry different bank.css (an unintended phish-pick tell)');
  }
  for (const name of ['favicon.svg', 'favicon.ico', '404.html', 'robots.txt']) {
    const [a, b] = BANK_PAIR.map((dir) => {
      try {
        return readFileSync(join(PAGES, dir, name));
      } catch {
        return null;
      }
    });
    if (a === null || b === null ? a !== b : !a.equals(b)) {
      problems.push(`the two bank origins differ in ${name} (an unintended phish-pick tell): ship it identically in both or in neither`);
    }
  }

  // 3. A file under no origin dir cannot be served in per-origin mode at all.
  for (const rel of files) {
    if (!originOf(rel) && !ORPHAN_OK.includes(rel)) {
      problems.push(`unreachable in per-origin mode: pages/${rel} belongs to no origin`);
    }
  }

  const pages = files
    .filter((rel) => rel.endsWith('.html'))
    .map((rel) => ({ rel, origin: originOf(rel), html: readFileSync(join(PAGES, rel), 'utf8') }));

  // 4. Every internal reference must resolve in whichever modes serve its page.
  for (const { rel, origin, html } of pages) {
    for (const raw of refsIn(html)) problems.push(...unresolved(rel, origin, raw));
  }

  // 5. Self-links. A root path naming the page's own directory (href="/flaky/")
  // resolves in both modes, because server.mjs passes the legacy prefix
  // through, but it puts the directory name back in the address bar of a site
  // served at its own origin. Links within a site are relative.
  for (const { rel, origin, html } of pages) {
    if (!origin) continue;
    const own = `/${origin.dir}`;
    const hits = refsIn(html).filter((raw) => {
      if (skip(raw)) return false;
      const ref = raw.split('#')[0].split('?')[0].toLowerCase();
      return ref === own || ref.startsWith(own + '/');
    });
    if (hits.length) {
      const shown = [...new Set(hits)].slice(0, 3).map((h) => `"${h}"`).join(', ');
      problems.push(`self-link: pages/${rel} hard-codes its own directory ${own}/ in ${hits.length} ref(s): ${shown}`);
    }
  }

  // 6. Footer legal links. A footer that names Privacy or Terms as an item (the
  // capitalised word, so "the terms of the issued policy" is prose) must link
  // a page whose link text carries that word, and the page must load in every
  // mode. Plain text, an external URL and the site's own front door all fail;
  // a fragment passes only when it names an id on the page itself, and never
  // on the front door. Email addresses (Privacy@...) do not name it.
  const legal = new Map();
  const linkedLegal = new Map();
  for (const { rel, origin, html } of pages) {
    if (!origin || DELIBERATE_LEGAL.includes(origin.dir)) continue;
    const frontDoor = `/${origin.dir}/`;
    const target = (href) => resolveUrl('/' + rel, href.split('#')[0].split('?')[0] || posix.basename(rel));
    const loads = (href) =>
      href !== undefined &&
      (/^#./.test(href)
        ? new RegExp(`\\b(?:id|name)\\s*=\\s*["']?${escapeRe(href.slice(1))}["'\\s>]`).test(html)
        : resolvesLocally(rel, origin, href)) &&
      target(href).replace(/index\.html$/, '') !== frontDoor;
    for (const anchor of anchorsIn(html)) {
      for (const [word, re] of Object.entries(LEGAL_PAGE)) {
        if (re.test(anchor.text) && loads(anchor.href)) addTo(linkedLegal, origin.dir, word);
      }
    }
    for (const footer of footersOf(html)) {
      const text = textOf(footer).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ');
      const anchors = anchorsIn(footer);
      for (const word of ['Privacy', 'Terms']) {
        if (!new RegExp(`\\b(?:${word}|${word.toUpperCase()})\\b`).test(text)) continue;
        const linked = anchors.some((a) => new RegExp(`\\b${word}\\b`, 'i').test(a.text) && loads(a.href));
        if (!linked) addTo(legal, `${origin.dir}\t${word}`, relative(origin.dir, rel));
      }
    }
  }
  problems.push(
    ...grouped(legal, (key, where) => {
      const [dir, word] = key.split('\t');
      return `footer legal: pages/${dir}/ names ${word} in a footer without a link to an existing ${word} page, on ${where}`;
    })
  );
  for (const origin of ORIGINS) {
    if (NOT_ZOO_SITES.has(origin.key) || DELIBERATE_LEGAL.includes(origin.dir)) continue;
    const linked = linkedLegal.get(origin.dir) ?? new Set();
    const lacking = Object.keys(LEGAL_PAGE).filter((w) => !linked.has(w));
    if (lacking.length) {
      warnings.push(`footer legal: no page on pages/${origin.dir}/ links a ${lacking.join(' or a ')} page`);
    }
  }

  // 7. Favicons. A site that ships favicon.svg links it from every page, and an
  // icon link anywhere must load in every mode (or be a data: URL).
  const iconless = new Map();
  for (const { rel, origin, html } of pages) {
    const icons = [...html.replace(SCRIPT_BODY, '$1').matchAll(START_TAG)]
      .filter(([tag]) => /^<link\b/i.test(tag))
      .map(([tag]) => attrsOf(tag))
      .filter((a) => (a.rel ?? '').toLowerCase().split(/\s+/).includes('icon'));
    for (const { href } of icons) {
      if (href === undefined || !(href.startsWith('data:') || resolvesLocally(rel, origin, href))) {
        problems.push(`icon link: pages/${rel} -> "${href ?? ''}" does not load in every serving mode`);
      }
    }
    if (origin && !icons.length && exists(`/${origin.dir}/favicon.svg`)) {
      addTo(iconless, origin.dir, relative(origin.dir, rel));
    }
  }
  problems.push(
    ...grouped(iconless, (dir, where) => `favicon: pages/${dir}/favicon.svg exists but no <link rel="icon"> on ${where}`)
  );

  // 8. A site's 404.html goes out without a session (see notFound in
  // server.mjs), so a nonce placeholder in it would reach the browser verbatim,
  // and under a <base> at the site root, so a fragment-only link would lead to
  // the front door instead of scrolling.
  for (const origin of ORIGINS) {
    const rel = posix.join(origin.dir, '404.html');
    if (!exists('/' + rel)) continue;
    const html = readFileSync(join(PAGES, rel), 'utf8');
    if (html.includes('__SESSION_NONCE__')) {
      problems.push(`404 page: pages/${rel} uses __SESSION_NONCE__, but a 404 is served without a session`);
    }
    const fragments = refsIn(html).filter((raw) => raw.startsWith('#'));
    if (fragments.length) {
      problems.push(`404 page: pages/${rel} links "${fragments[0]}", which its <base> sends to the site's front door`);
    }
  }

  // 9. A reserved-range number is fiction only while one business uses it; two
  // unrelated sites sharing one reads as a single invented company.
  const phones = new Map();
  for (const rel of files) {
    const origin = originOf(rel);
    if (!origin || !TEXT_FILE.test(rel)) continue;
    const text = readFileSync(join(PAGES, rel), 'utf8');
    for (const [raw] of [...text.matchAll(UK_PHONE), ...text.matchAll(US_PHONE)]) {
      const key = phoneKey(raw);
      if (!phones.has(key)) phones.set(key, { raw, sites: new Set() });
      phones.get(key).sites.add(businessOf(origin.dir));
    }
  }
  for (const { raw, sites } of phones.values()) {
    if (sites.size > 1) warnings.push(`phone: ${raw.trim()} appears on ${sites.size} unrelated sites: ${[...sites].sort().join(', ')}`);
  }

  // 10. Requests page script writes out. The checks above strip script bodies,
  // and scripts/crawl.mjs sees only what a page asks for as it loads, so a
  // mistyped API path behind a button, or a script navigation to a missing
  // page, reaches neither. An /api/ literal anywhere under pages/ must be a
  // path some route in sites/ or server.mjs names, exactly or under a route
  // prefix ending in "/"; a relative literal handed to fetch() or a location
  // assignment in an inline script must load in every mode serving the page.
  const routeLiterals = [join(HERE, '..', 'server.mjs'), ...walk(SITES_DIR).filter((f) => f.endsWith('.mjs'))]
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(API_LITERAL)].map((m) => m[2]));
  const routes = new Set(routeLiterals);
  const routePrefixes = routeLiterals.filter((r) => r.endsWith('/') && r !== '/api/');
  for (const rel of files) {
    if (!/\.(?:html|js)$/.test(rel)) continue;
    const text = readFileSync(join(PAGES, rel), 'utf8');
    for (const [, , path] of text.matchAll(API_LITERAL)) {
      if (routes.has(path) || routePrefixes.some((p) => path.startsWith(p))) continue;
      problems.push(`api path: pages/${rel} names ${path}, which no route in sites/ or server.mjs serves`);
    }
  }
  for (const { rel, origin, html } of pages) {
    for (const [, , body] of html.matchAll(INLINE_SCRIPT)) {
      for (const [, , target] of body.matchAll(SCRIPT_TARGET)) {
        if (target.startsWith('/api/')) continue;
        for (const why of unresolved(rel, origin, target)) problems.push(`script ${why}`);
      }
    }
  }

  return { problems, warnings };
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
  const { problems, warnings } = runChecks();
  if (warnings.length) {
    console.warn(`fixture check: ${warnings.length} warning(s)\n`);
    for (const w of warnings) console.warn(`  ${w}`);
    console.warn('');
  }
  if (problems.length) {
    console.error(`fixture check: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`fixture check: ok (${ORIGINS.length} origins)`);
}
