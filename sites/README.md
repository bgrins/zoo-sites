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
  the comment at each use site says so and must keep saying so. A route whose
  reply carries a graded value can record the browser's requests and a shell's
  apart, so a validator can refuse a fact read around the browser:
  `sites/console.mjs` stamps a hovercard's first page view apart from its first
  shell read (hovercard-oncall), and `sites/depot.mjs` answers a request that is
  neither the page's nor a tab's navigation (`ctx.isDocumentNav`) with a ref of
  its own (body-only-ref). A tab opened on an API URL sends no Referer and
  `Sec-Fetch-Site: none`, so `fromPage` alone would count it as a shell.
- Graded secrets stay server-side, per `docs/authoring-fixtures.md`. Nothing
  here changes the contract that ground truth is never derivable from `pages/`.
- `node eval/verify.mjs` must be green before any change here is committed.

Registry: `index.mjs` exports `SITES`, an array of `routes` factories in dispatch
order, and `DOCUMENTS`, the `documents` factories. Order matters only where
prefixes overlap, and they should not.

## Per-session records

A record a site only reports (a log of page loads, gestures or saves) is trimmed
oldest-first with `pushTrimmed(list, row)` from `lib.mjs`, so a standing habitat's
session cannot grow without bound, and the client strings in its rows are cut to
a short length. A record a validator grades is never trimmed, because a flood
could push the row that fails a task off the front: its route refuses the
request once the record holds `SESSION_ROWS` rows, with the site's own error
(usually a 429). Its rows keep every string a validator compares as it was sent,
so a cut can never change a grade.

Records bounded another way include:

- One entry per key from a fixed set: gov's form ids (trimmed at `SESSION_ROWS`),
  consent's tiers, maze's surveyed cells, biglist's row offsets, roles' opened
  postings.
- A cap the flow already sets: support's thread length, schedule's hold limit,
  events' drafts and permits (one per application, which refuses at
  `SESSION_ROWS`), registrar's retirements (one per record), forms' Draymere sign-ins (which stop
  once sign-in locks), paylink's intents
  (minted until the session has `SESSION_ROWS`), and auction's bid history (every
  bid raises the price, the room stops at its ceiling, and no bidder may raise
  their own bid).
- A limit of their own: shop keeps its newest 50 lookup-page records and 500
  totals reads per store; auction's refusal log stops recording at 200; parcels'
  collections, telco's reservations, status's subscriptions and voltro's deal
  widths stop recording at 50; and status keeps its newest 50 probe checks, which
  is safe for a graded record only because status-flash grades the latest check
  alone.

`htmlGets` in `server.mjs` and gov's page tokens are keyed by the served path, so
they are bounded by the fixture tree only on a case-sensitive filesystem, as in
the container. On a case-insensitive one, each spelling of a path's case is a key
of its own.

## Dates

A date that has to stay ahead of the run (hard rule 9 in
`docs/authoring-fixtures.md`) is minted here from the UTC day the session opened,
with the pure helpers in `lib.mjs`. The helpers count in UTC milliseconds only, so
neither the server's time zone nor a clock change moves a day. `at` below is a ms
timestamp, such as `session.createdAt`, or a Date. `nextWeekday`, `shiftWeeks`
and `isoWeek` throw on anything else, so a missing `createdAt` fails the request
instead of printing 1 January 1970. `utcDay` and `dayText` check nothing.

- `utcDay(ms)` is the UTC midnight that starts the day `ms` falls in, and
  `DAY_MS` and `WEEK_MS` count on from it.
- `dayText(ms, { weekday, year })` prints a UTC day as a British page does,
  "Friday 25 September 2026", with the weekday or the year left off on request.
- `isoDay(iso)` reads a `YYYY-MM-DD` day as its UTC midnight. It throws on
  anything else, where `Date.parse` rolls 2026-02-30 over to 2 March and reads
  other shapes in local time.
- `nextWeekday(at, weekday)` is the first UTC day on or after the day of `at`
  whose weekday is `weekday`, 0 for Sunday as `getUTCDay` counts. The Nerrow
  Strait opening in `sites/forms.mjs`, a Tuesday 40 to 46 days out, is
  `nextWeekday(createdAt + 40 * DAY_MS, 2)`, and the pdf-bill account's latest
  read in `sites/utility.mjs`, the last Thursday at least 18 days back, is
  `nextWeekday(openedAt - 24 * DAY_MS, 4)`.
- `isoWeek(at)` is the ISO 8601 week of the day of `at`, as `{ year, week }`. A
  week starts on Monday and belongs to the year its Thursday falls in, so 11 May
  2026 is in week 20 and 1 January 2027 in week 53 of 2026. A page that prints a
  week number beside a minted date computes it here.
- `shiftWeeks(iso, at, { past })` moves a fixed day in whole weeks to the first
  day on its weekday on or after the day of `at`, 0 to 6 days after it. With
  `past: true` it lands on the last such day before the day of `at` instead, 1
  to 7 days before it. It returns `{ day, iso, weeks }`, where `weeks` is negative when the day moved
  back. The page moves every other date it prints by the same `weeks`,
  `isoDay(other) + weeks * WEEK_MS`, so each weekday and each gap holds.
  - A page whose dates must stay ahead passes the earliest of them. Every date
    on or after it then stays on or after the session's day, and every date a
    week or more before it stays in the past. A date 1 to 6 days before it can
    land on either side, so end the history a week before it.
  - A page of history, such as a mailbox, a run log or a scan timeline, passes
    its latest date with `past: true`, and every date then lands before the
    session's day.
  - Neither form keeps a relative label true, since the page's today lands up
    to a week from the session's. A page that prints "Today", "Yesterday" or
    "Last 14 days" moves by whole days instead, `utcDay(at) - isoDay(written)`
    from the day it was written as today, so its today is the session's day.
    Its weekdays then change, so it prints them with `dayText`.

The driver half is in `eval/verify-drivers/lib.mjs`:

- `notBeforeToday(page, date, { text, today, ahead })` throws unless `date`
  falls on or after today in UTC, or at least `ahead` days after it, and returns
  its UTC day. `ahead: 1` is the strict "after today" that the `abstract-length`
  and `pdf-bill` drivers check.
- `notAfterToday(page, date, { text, today, behind })` is the same guard for a
  date that must not run ahead of today, such as history or an issue date, or
  must sit at least `behind` days before it. `behind: 1` is the vault driver's
  "Overdue since" check.
- `date` is ms, a Date, or the page's own text, which `pageDay` reads. The error
  names the page, the words it printed (`date` itself, or `text` when given) and
  both days: `carrier.html prints "Mon 21 Sep" (2026-09-21), before today
  (2026-09-22)`. A date the driver failed to read throws too, rather than
  passing as `NaN`.
- `today` has no default. A date the site counts from the day the session
  opened, which is every date the helpers above mint, is checked against
  `session.createdAt`, because the gate may have passed midnight since, and
  `nextWeekday` and `shiftWeeks` land on the session's own day in one session in
  seven. A date the ask fixes is checked against `Date.now()`.
- `pageDay(text, near)` reads a page's date text as a UTC day: "2026-07-31",
  "Friday 31 July 2026", "Fri 31 Jul", "Fri, Jul 31" or "31 Jul". It returns
  null for other words, for a day the month lacks and for a weekday that is not
  the day's own. A date printed without its year is read in whichever of the
  year before `near`'s, its own and the one after puts it nearest `near`,
  counting only those on the weekday it names. A driver that reads a yearless
  date as its next occurrence after today, as `thornburyRound` in `forms.mjs`
  does, can never find it past: an aged "Cycle closes 31 Jul" reads as next July
  and passes forever. A printed weekday pins the year for good. Without one, a
  date more than six months from today reads on the wrong side, so a page prints
  the year or the weekday of a date further out.

`node eval/scripts/rule-checks.mjs`, which the gate runs, checks these helpers
across month, year and leap-day boundaries, on a Sunday session, and in six time
zones, each in a child process of its own.

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
  later draws identical between a forced run and an unforced one. A pick whose
  options depend on an earlier pick is forced against the options it was given:
  `quotient.decoy` picks among the seven fields left after `quotient.omitted`,
  so its index counts within those seven, and forcing it to the omitted field
  throws.
- Scope names are per site and per factor (`<site>.<factor>`), so forcing one
  factor never shifts another's sequence.

Nine sites use `pick`. Two draw once per task, and later sessions reuse the
first session's picks: `console.oncall` in `sites/console.mjs` (hovercard-oncall),
and `smarthome.brightness`, `smarthome.colorTemp` and `smarthome.fadeSeconds` in
`sites/smarthome.mjs` (scene-calibrate). The others pick once per session:

- `console.queue.phase` in `sites/console.mjs` (reused-row): how long after the
  session's first queue poll the first re-sort comes.
- `events.equipment`, `events.event` and `events.contact` in `sites/events.mjs`
  (native-permit).
- `filemgr.scans.run` in `sites/filemgr.mjs` (range-select): how many files the
  dictated batch holds.
- `gov.certcopy.receipt` in `sites/gov.mjs` (resend-receipt).
- `lumeva.roaming`, `lumeva.alert`, `lumeva.cap` and `lumeva.atcap` in
  `sites/telco.mjs` (unsaved-leave).
- `media.desk.moves` in `sites/media.mjs` (pointer-drag): how many stories the
  deal puts out of place.
- `quotient.omitted` and `quotient.decoy` in `sites/quotient.mjs` (silent-throw).
- `utility.estimated-bill` in `sites/utility.mjs` (pdf-bill).

A deal that is not a choice among variants, such as a shuffle, a folder of files
or a clock time, stays on `draw`, which `state.draws` does not log. Where such a
deal has a named factor, the site picks the factor on a scope of its own and
draws the rest: `media.desk.moves` sets how many stories the `media.desk` shuffle
puts out of place, `filemgr.scans.run` sets the length of the dictated batch in
the `filemgr.scans` folder, and `events.event` and `events.contact` finish the
`events.brief` pack, whose streets and times stay drawn.

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
- A path that does not decode, or that decodes to one holding a NUL byte, gets a
  400 before any hook or file lookup. A name too long for the filesystem counts
  as a missing file.
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
