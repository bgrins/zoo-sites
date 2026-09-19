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
  // draw(scope, n) - seeded bytes for DIFFICULTY draws only; graded
  // identifiers stay on randomBytes.
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
