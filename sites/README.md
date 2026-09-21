# Per-site backends

Each fixture site's server code lives in one module here. `server.mjs` keeps the
core — session minting, static serving with nonce substitution, the state
container, the generic beacon, and the preview and index pages — and dispatches
API requests and HTML page loads to these modules.

Module shape, deliberately minimal:

```js
export function routes(ctx) {
  // Also on ctx: TYPES, isDocumentNav, mintSession, sitePath/refererPath (a
  // page-reported path or the Referer, in the /<dir>/ form both serving modes
  // share), root/readFile/join (static fixture data under pages/), and
  // draw(scope, n) and pick(scope, options) - seeded DIFFICULTY draws only
  // (see "Difficulty draws" below); graded identifiers stay on randomBytes.
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/example/thing') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, { ok: true });
    }
    return false;
  };
}
```

A site whose page loads carry server state (a navigation stamp, a token minted
into the body) also exports `documents(ctx)`:

```js
export function documents(ctx) {
  return {
    // Lowercase. Matched case-insensitively, because the tree is served off a
    // case-insensitive filesystem; only hooks whose prefix matches run.
    prefix: '/example/',
    // Optional, before the file lookup. Return true once it has answered the
    // request, or { pathname } to serve another file instead.
    beforeStatic({ req, res, url, pathname0, pathname, nav }) {},
    // Optional, for every .html under the prefix, after the nonce substitution.
    // Return { body } to replace the text and/or { headers } to add response
    // headers, or nothing.
    onHtml({ req, url, pathname, found, nav, body }) {
      if (pathname === '/example/index.html' && nav.document) {
        found.session.example ??= { loadedAt: Date.now() };
      }
    },
  };
}
```

`pathname` is the served path in the `/<dir>/` form in both serving modes.
`nav` is `{ document, framed, image }`: a top-level navigation, an iframe
navigation or an image load, read from sec-fetch-* headers that page script
cannot set. Off loopback a browser may omit those headers, and `nav` falls back
to the Accept header, which page script can set (see `navOf` in `server.mjs`).
Each stamp says whether a framed load counts.

Rules:

- A handler that matched returns anything but `false`: a `json(...)` return and a
  bare `return` after an error response both count as handled. A module returns
  `false` only when no route matched, and the dispatcher tries the next module.
- Site constants, per-session state initialisers (`fooState(session)`), document
  hooks and helpers move WITH their routes. Anything two sites share belongs on
  ctx when it needs request or session plumbing (`ctx.readJson(req, res)` parses
  a body or answers 400), and in `lib.mjs` when it is a pure function (`round2`).
- `ctx.fromPage(prefix)` is the provenance helper: sec-fetch same-origin, or a
  Referer on the request's own host whose `refererPath` starts with the prefix,
  so an origin-mode page, served at its origin's root, counts too, and another
  origin's page does not. It buys legibility, never proof, and
  the comment at each use site says so and must keep saying so.
- Graded secrets stay server-side, per `docs/authoring-fixtures.md`. Nothing
  here changes the contract that ground truth is never derivable from `pages/`.
- `node eval/verify.mjs` must be green before any change here is committed.

Registry: `index.mjs` exports `SITES`, an array of `routes` factories in dispatch
order, and `DOCUMENTS`, the `documents` factories. Order matters only where
prefixes overlap, and they should not.

## Per-session records

A record a site only reports (a log of page loads, gestures or saves) is trimmed
oldest-first with `pushTrimmed(list, row)` from `lib.mjs`, so a standing habitat's
session cannot grow without bound. A record a validator grades is never trimmed,
because a flood could push the row that fails a task off the front: its route
refuses the request once the record holds `SESSION_ROWS` rows.

## Difficulty draws

A site that deals each session one of several shapes (a layout, a week, a defect)
draws it through `ctx`, so a seeded run replays it and paired conditions face the
same one. `draw(scope, n)` returns `n` bytes: `randomBytes` unseeded, and with a
seed a per-scope sequence that `state.reset()` restarts for every task.

`pick(scope, options)` is the form to use for a choice among named variants:

```js
const layout = ctx.pick('boxoffice.layout', ['stalls-first', 'circle-first', 'split']);
```

- It returns one element of `options` from `draw(scope, 4)`, sharing the scope's
  sequence with `draw`.
- It appends `{ scope, pick, index }` to `state.draws`, which the runner copies
  onto the result row, so a row says which variant its run faced. Keep options to
  plain data such as names, because the log is state and gets cloned and written
  out; map the name to a layout object after the pick.
- `state.modes['pick.<scope>']` forces the choice, by option value first and then
  by index, so an experiment can hold one factor fixed. The row then carries
  `forced: true`. A force that names neither throws, so the request 500s rather
  than quietly drawing. The draw is consumed either way, which keeps the scope's
  later draws identical between a forced run and an unforced one.
- Scope names are per site and per factor (`<site>.<factor>`), so forcing one
  factor never shifts another's sequence.

Four sites use `pick`. Two draw once per task, and later sessions reuse the
first session's picks: `console.oncall` in `sites/console.mjs` (hovercard-oncall),
and `smarthome.brightness`, `smarthome.colorTemp` and `smarthome.fadeSeconds` in
`sites/smarthome.mjs` (scene-calibrate). `gov.certcopy.receipt` in `sites/gov.mjs`
(resend-receipt) and
`events.equipment` in `sites/events.mjs` (native-permit) pick once per session. The
sites that call `draw` directly keep their current sequences until they are
migrated.

## Request ledger

`state.ledger` holds a row per request the server answers:
`{ sid, at, method, path, site, dest, mode, route, client, ua, status, bytes, ms }`,
plus `minted: true` when the response set the `sid` cookie and `aborted: true`
when the client left first. `path` is in the `/<dir>/` form with its query,
`site` is the manifest dir, `dest` and `mode` are the `sec-fetch-*` headers as
sent, `route` is `document`, `frame`, `image`, `fetch`, `subresource` or `other`,
and `client` is `browser`, `shell` (loopback without Fetch Metadata, which both
eval browsers always send) or `unknown` (off loopback, where a browser may omit
them). `ua` is the User-Agent header as sent; a paid run tags each attempt's own
browser with a per-attempt token, so its foreign-browser check can tell that browser
from any other. It is telemetry, like the headers it reads: no validator may grade on it.
`state.reset()` clears it, and only `capped` bounds it.

`route` and `client` measure different things. `route: 'fetch'` marks every
fetch() and XHR made in a page, the page's own polls included
(`pages/auction/lot-418.html` polls every 1.5 seconds), and a fetch an agent runs
through a script tool gets the same route. `client: 'shell'` marks a request from
outside the browser, such as curl or a node script, so only `client` shows an
agent going around the browser.

## Static serving

After the API chain and each matching `beforeStatic` hook, `server.mjs` serves the
file under `pages/`. The site a path belongs to is the origin's dir in origin mode,
the dir of the Host's manifest key in host-routed mode (`vhosts`, where
`http://<key>.localhost:<port>` serves that dir at `/` on one port), and in
single-origin mode the manifest dir that prefixes the path. Host-routed mode
applies every rule below exactly as origin mode does; only the way a request names
its origin differs.

- **HTML** gets `Cache-Control: no-cache, private`, because its body carries the
  session's nonce. It gets no `Vary: Cookie`: a response fetched under another
  cookie, as a session's first page always is, would then be refetched on Back,
  re-running `onHtml`'s navigation stamps. `onHtml` runs after the header is set, so
  its `{ headers }` can override it: paylink's checkout sends `no-store`.
- **Methods.** A static path answers GET and HEAD only. Any other method gets 405
  with `Allow: GET, HEAD`, before a session is minted or `onHtml` runs, so a route
  that takes a body lives under `/api/` or in a `beforeStatic` hook, which runs
  first.
- **A directory without its trailing slash** gets a 301 to the slash form when it
  has an `index.html`. The `Location` is relative (`./departments/`), so it lands
  on the same directory in both serving modes.
- **A miss** under a site gets that site's `pages/<dir>/404.html` with status 404
  when the site ships one, and the server's generic page otherwise. The page goes
  out as-is: no session, no nonce, no document hooks, `__ORIGIN_<KEY>__` tokens
  substituted, and a `<base href>` at the site root (`/<dir>/` in single-origin
  mode, `/` in origin mode) inserted into its `<head>`, so its relative links
  resolve from any depth. The `<base>` also re-bases a fragment-only link, so
  `href="#main"` leads to the site's front door; `scripts/check-fixtures.mjs`
  rejects one in a 404 page. An `/api/` path that no handler claimed keeps the
  generic page.
- **`/favicon.ico` at a site root** (`/<dir>/favicon.ico` in single-origin mode)
  answers with `pages/<dir>/favicon.svg` as `image/svg+xml` when the site ships
  one and has no `favicon.ico` of its own. In single-origin mode the server root
  belongs to no site, so a browser's automatic `/favicon.ico` there still 404s,
  which is why every page links its icon explicitly.
- **`/robots.txt` at a site root** answers with `pages/<dir>/robots.txt` when the
  site ships one, and otherwise with an allow-all default.
- A read that fails for any reason other than a missing file, the 404 page's
  and the favicon's included, throws, and the core handler logs it as a 500.

`docs/authoring-fixtures.md`, "Site conventions", is the page-side half: relative
self-links, footer Privacy and Terms links, and what goes in the 404 page and the
favicon. `scripts/check-fixtures.mjs` enforces it, and also fails an `/api/` path
a page names that no route here serves. `scripts/crawl.mjs` loads every page in
Firefox in all three serving modes and fails on a page error or a 4xx/5xx that
its `DELIBERATE` list does not explain; a route that refuses a cold page load on
purpose (a signed-out dashboard, a Review step before checkout) needs an entry
there, with its reason. The crawl never clicks or types, and it keeps a page open
only for the timers the page sets due within 8 seconds of its start, so code
behind an interaction or a longer timer is never run there.
