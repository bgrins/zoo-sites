# Per-site backends

Each fixture site's server code lives in one module here. `server.mjs` keeps the
core — session minting, static serving with nonce substitution, the state
container, the generic beacon, and the preview and index pages — and dispatches
API requests to these modules.

Module shape, deliberately minimal:

```js
export function routes(ctx) {
  // Also on ctx: TYPES, isDocumentNav, root/readFile/join (static fixture
  // data under pages/), and draw(scope, n) - seeded bytes for DIFFICULTY
  // draws only; graded identifiers stay on randomBytes.
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

Rules:

- A handler that matched returns anything but `false`: a `json(...)` return and a
  bare `return` after an error response both count as handled. A module returns
  `false` only when no route matched, and the dispatcher tries the next module.
- Site constants, per-session state initialisers (`fooState(session)`) and
  helpers move WITH their routes. Anything two sites share belongs on ctx, or
  does not exist yet.
- `ctx.fromPage(prefix)` is the provenance helper: sec-fetch same-origin, or a
  referer under the prefix. It buys legibility, never proof, and the comment at
  each use site says so and must keep saying so.
- Graded secrets stay server-side, per `docs/authoring-fixtures.md`. Nothing
  here changes the contract that ground truth is never derivable from `pages/`.
- `node eval/verify.mjs` must be green before any change here is committed.

Registry: `index.mjs` exports `SITES`, an array of `routes` factories in dispatch
order. Order matters only where prefixes overlap, and they should not.
