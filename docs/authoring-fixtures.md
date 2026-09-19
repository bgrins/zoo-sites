# Authoring fixtures and validators

A fixture is a simulated site under `pages/`. A validator is the function in
`eval/tasks/` that grades a task on what that site's server observed.
`docs/process.md` covers the gate, the fix-pass method, and who owns which file.
Every path below is relative to the repo root.

The eval measures how the browser tool surface shapes a run, not how capable the
agent is, across two conditions: `firefox-devtools-mcp` (over stdio) and
`playwright-mcp` (the vendored `@playwright/mcp`). Build each fixture as the real
site it imitates, and let the surfaces succeed or fail against it on their own: a
task that one surface loses is a finding, not a bug to author away. See
"Tool-surface limits are the measurement" below. For scale: 94 tasks (86 web, 5
devtools, 3 basic smoke) run against 66 origins served from 53 fixture trees under
`pages/`, and `eval/verify.mjs` gates 91 of them with one deterministic driver each.

## Where to look first

1. `docs/task-ideas.md` — the `### <ID> — …` plan for your task, which is the
   contract (Fixture / Server / Ask / Validator); deviate only for a stated reason.
2. `sites/README.md` for the per-site module contract, and `sites/canvas.mjs`,
   `sites/forms.mjs`, `sites/filemgr.mjs`, `sites/biglist.mjs` for handler shape.
3. `eval/tasks/web/`, one module per family concatenated by `eval/tasks/web.mjs`; model
   validators `register-errors` (`eval/tasks/web/forms.mjs`), `checkout-stop`
   (`eval/tasks/web/commerce.mjs`), `rename-rollback` (`eval/tasks/web/recovery.mjs`).
4. `registrar-purge` (`eval/verify-drivers/registrar.mjs`) and `partial-import`
   (`eval/tasks/devtools.mjs`) set the bar for a driver-and-validator pair.
5. House style near yours: `pages/forms/kestrel/brochure.html` (forms),
   `pages/shop/voltro/index.html` (shop), `pages/gov/fee-schedule.html` (legacy
   gov), `pages/news/index.html`.

## Hard rules

Each of these binds every fixture and every validator, without exception.

1. **Ground truth is never derivable from anything under `pages/`.** A validator's
   codes, messages and figures are minted per session in `sites/`, or the fact
   itself is server-observed ("the server saw a compliant submission"). Assume the
   agent can `cat` and `grep` everything under `pages/`. A pure-extraction datum
   that needs no interaction to be trustworthy — a long document, a messy table —
   may live in the page, but in EXACTLY ONE place, with plausible decoys elsewhere,
   and its answer key lives in `eval/answers.mjs`, never in the page.
2. **Nothing under `pages/` may say or imply a site is a test fixture.** No
   disclaimer that the site is fictional, simulated, a test fixture, or built for
   browser automation. Titles, headings, body copy and footers read as a real
   company's — copyright line, privacy/terms links, registered address, support
   contact. The privacy and terms links lead to pages that exist, written in the
   site's own voice (see "Site conventions" below).
3. **Every page starts with `<!doctype html>` and carries `<meta charset="utf-8">`.**
   Fixtures under `pages/gov/` are the exception: that site is deliberately legacy
   HTML 4.01 (`<font>`, tables, spacer gifs), so match the neighbours.
   `pages/gov/handbook.html` is the one modern page in that tree.
4. **Brands, domains, phone numbers and identifiers must be verifiably fictional.**
   Search a brand against the real world before you use it, and reject any hit in
   the same sector as the fixture. Coin a word rather than borrowing a placename or
   a surname: invented consonant clusters come back with no hits, while real places
   and family names collide. Surnames and real place names are the usual source of
   the collisions a review finds: the 2026-09-19 review flagged Marlowe,
   Harrowgate, Trelowen and Northgate among the brands, and Leeming, Harwell and
   Ardwick as towns. Every name a site shows needs the same search, not only its
   brand: a customer, a dealer, a supplier, a street, a town. A plausible UK
   postcode is often a real one, so use an outward code that does not exist.
   - Identifiers belong to ONE site. Never reuse a phone number, a postcode unit, a
     street address or a name stem across unrelated sites: two companies sharing
     `01632 960118` read as one invented company, and a stem that recurs
     ("Northgate" on six entities, "Fern-" on eight) reads as one author.
     `node scripts/check-fixtures.mjs` warns when a reserved-range phone number
     appears on more than one site. `eval/verify.mjs` prints only the check's
     failures, never its warnings, so run the script itself to see them.
   - Domains: RFC 2606 reserved only — `<brand>.example`, `<brand>.example.net`,
     `example.com`. A fictional state's portal still uses one, e.g.
     `qta.gov.example`.
   - Phone numbers: reserved fiction ranges only. On UK sites, Ofcom's drama
     ranges, which the fixtures use as `020 7946 0xxx` (mostly written
     `+44 20 7946 0xxx`), `0113/0117/0151/0161 496 0xxx`, `01632 960xxx`,
     `0808 157 0xxx` and `03069 990xxx`. On US sites, the NANP `555-0100` to
     `555-0199` block under a geographic area code, written `541-555-0142`,
     `1-614-555-0142`, `(415) 555-0104` or `+1 206 555 0148`. The block is not
     reserved in toll-free codes, so `1-800-555-01xx` can be a real line. Nor is
     `(555) 01x-xxxx`, which puts 555 in the area-code slot; `pages/gov/` still
     uses that form, so do not copy it from there.
   - Company, charity, VAT and regulator register numbers must be unmistakable
     sentinels — `company number 00000000`, `VAT 000 0000 00`, `Registered
     charity 0000000`, `firm reference 000000`. A well-formed registration number
     belongs to a real registrant, so never invent a plausible one.
5. **No emoji anywhere** — code, comments, log messages, strings, documentation —
   **and no copyrighted content**; invent everything.
6. **Near-zero code comments.** Comment non-obvious mechanics only, and every
   non-obvious grading rule. A later change re-breaks whichever rule no comment
   explains.
7. **A page looks like a real site of its genre** — nav, footer, filler content,
   plausible copy — never like a test harness.
8. **Every site needs its OWN design language.** Copy the *rigor* of your
   house-style reference — real chrome, plausible copy, no test-harness tells —
   never its fonts, palette, or layout. Agents must re-orient on each site, so
   vary: type family and scale, colour palette, density, border/corner/shadow
   treatment, nav pattern (top bar / sidebar / breadcrumb / tabs), form layout
   (stacked / two-column / inline labels / floating labels), button shape and label
   wording, table vs card vs list presentation, and the terminology of common
   actions. A municipal site, a 2004 intranet, a SaaS console and a discount retailer
   should look nothing alike.

   ALREADY CLAIMED, by style family, with the member sites (dirs under `pages/`).
   The list was measured on 2026-09-19, after the re-skins of that date, from
   every origin's landing page in Playwright Firefox at 1366px. It records the
   face that renders most of the text on macOS, the computed colours, the nav
   pattern, and the corner and shadow treatment, not the first name in a CSS
   stack: `forms/draymere` asks for IBM Plex Sans and renders the generic
   sans-serif, which is Helvetica. Re-measure and edit this list whenever a site
   is re-skinned.

   CLOSED — every family here already has two or more members and takes no new
   one. A re-skin moves a site OUT of its family and into unclaimed territory,
   never into another family on this list.

   By main face:
   - Trebuchet MS, the largest face family: `biglist`, `fernwood`, `forge`,
     `intl`, `paylink`, `promo`, `shop/marrowgate`.
   - Futura: `boxoffice` (with Copperplate, on brown-black), `forms/summit`,
     `smarthome`, `telco`, `unsub`.
   - Lucida Grande: `forms/farholt` (with Rockwell headings), `grid-edit`,
     `news`, `registrar`.
   - Avenir or Avenir Next: `crm`, `maze`, `portal`, `support`.
   - Helvetica Neue: `parcels`, `press`, `shop/voltro`, and `bank/*`, the
     phishing pair, identical by design.
   - Arial Narrow: `depot`, `kiosk`, and `shop/gadgetron` with its mirror, a
     pair by design.
   - SF through system-ui: `filemgr`, `forms/drennhill`, `forms/waypost`,
     `status`, and half of `calc`.
   - Monospace throughout: `console`, `forms/fernlight`, `media`, `shadow`, and
     the other half of `calc`.
   - Palatino: `bistro`, `insure`, `ledger`.
   - Seravek: `gallery`, `quotient`.
   - DIN Alternate: `jobs`, `kanban`.

   By ground, palette and chrome:
   - A near-black ground: `boxoffice` (brown-black and gold), `console`,
     `forms/draymere` (ice cyan), `kiosk` (amber), `shadow` (hazard yellow),
     `smarthome` (teal).
   - A warm cream or parchment ground: `bistro`, `cabins`, `fernwood`,
     `forms/farholt`, `forms/kestrel` (the original, Optima and rust), `intl`,
     `ledger`, `paylink`, `promo`, `unsub`. Three of them set oxblood or wine
     on that paper: `bistro`, `forms/farholt`, `ledger`.
   - A grey-green or sage ground: `calc`, `forms/thornbury` (with moss),
     `inbox`, `kanban`.
   - Rust, brick, terracotta or burnt orange as the lead accent:
     `forms/kestrel`, `paylink`, `press`, `roles`. `crm`, `grid-edit`, `intl`,
     `lexvane` and `registrar` set it on secondary text or rules.
   - Lime or chartreuse: `metrics` and `telco`, both under a near-black bar,
     and `jobs`, in yellow-lime bands.
   - Purple, plum or indigo chrome: `biglist`, `crm`, `forge`, `forms/summit`,
     `news`, `promo`, `registrar`.
   - A dark green or teal band across the top: `cabins`, `grid-edit`, `intl`,
     `parcels`, `shop/voltro`, `status`.
   - A navy or slate header or nav band: `bank/*`, `floorplan`, `forms/nerrow`,
     `forms/vendor`, `insure`, `media`, `utility`.
   - A pale grey SaaS ground with white rounded cards and a blue or indigo
     primary: `filemgr`, `forms/drennhill`, `forms/waypost`, `portal`.
   - Marketplace yellow or amber buy buttons on a product grid:
     `shop/gadgetron`, `shop/marrowgate`, `shop/voltro`.

   By nav pattern:
   - A full-height left rail: `biglist`, `console`, `floorplan`, `grid-edit`,
     `inbox`, `metrics`, `quotient`, `registrar`, `support`, `vault`. Five of
     them hang the rail under a dark full-width top bar, the console look:
     `console`, `floorplan`, `grid-edit`, `metrics`, `support`.
   - A centred masthead, with the wordmark and the nav on the centre line:
     `bistro`, `boxoffice`, `insure`, `promo`.
   - The defaults, which claim nothing on their own: a horizontal top nav whose
     current item is underlined or filled, on 36 landing pages, and a dark
     full-width top bar, on 23. A dark top bar over a left rail is the console
     look above.

   By corners and depth:
   - Hard offset shadows with no blur: `lexvane`, `promo`, `vault`.
   - The rest are counts, not families, and most sites are square and flat:
     37 landing pages have no corner of 8px or more and no shadow at all. Cards
     rounded to 8px or more: `fernwood`, `forms/drennhill`, `forms/summit`,
     `forms/thornbury`, `forms/waypost`, `gallery`, `inbox`, `intake`,
     `kanban`, `lexvane`, `portal`, `roles`, `smarthome`, `status`, `telco`.
     Pill chips or buttons: `biglist`, `forms/thornbury`, `intake`,
     `lexvane`, `roles`, `smarthome`. Soft card shadows: `crm`, `fernwood`,
     `flaky`, `forms/thornbury`, `forms/waypost`, `intake`, `kanban`, `roles`.

   Claimed by one site each, as a face or as the face with its palette — do not
   copy:
   - `gov`: legacy HTML 4.01 tables and `<font>`, in Times.
   - `auction`: Gill Sans with Baskerville headings on stone.
   - `cabins`: a Rockwell body under a forest-green header on cream;
     `forms/farholt` sets only its headings in Rockwell.
   - `canvas`: a Hoefler Text body under Didot headings on cool grey, with a
     CMYK rule.
   - `forms/kestrel`: Optima with Avenir Next Condensed caps, on cream and rust.
   - `forms/nerrow`: an Iowan Old Style body on blue-grey; `quotient` uses the
     face for headings only.
   - `utility`: Georgia with Verdana labels under a navy municipal bar.
   - `schedule`: Verdana, grey toolbar tabs and a client-coloured day grid.
   - `inbox`: Arial, because its Franklin Gothic stack falls back, in a light
     fern-green webmail.
   - `floorplan`: PT Sans, a navy bar with an orange rule, and a left rail.
   - `metrics`: Hiragino Sans with DIN figures and square panels. Only the face
     is its own: the black bar, the grey rail and the lime put it in the lime
     and the console-look families above.
   - `forms/thornbury`: Charter throughout, which `roles` gave up on
     2026-09-19, with pill tabs and rounded white cards. Its moss on a pale
     green-white wash sits in the grey-green family above.
   - `forms/vendor`: Geneva, close in texture to `schedule`'s Verdana, under a
     slate civic header with a teal rule, which sits in the navy-or-slate
     family above.
   - `rosters`: a learned-society site. A Cochin body under Big Caslon
     headings, white and ochre, a centred column under a ruled text nav, and
     booktabs tables.
   - `flaky`: a SharePoint-style intranet. Tahoma behind a Segoe UI stack, a
     white suite bar with a sky-blue waffle, a hub nav strip and a command bar
     over a right-hand bulletin column, sky tiles, and square Fluent-shadowed
     web parts.
   - `roles`: a WordPress job-board theme. Sukhumvit Set behind a Poppins stack,
     white and burnt orange, pill chips, rounded result cards, and a dark brief
     card.
   - `vault`: neo-brutalism. Galvji behind a Space Grotesk stack, a yellow rail,
     2px black borders with hard offset shadows, and electric-blue links.
   - `lexvane`: a newspaper puzzle page. Superclarendon with Athelas italics on
     dotted newsprint, a white masthead under a coral rule, ink-blue chrome, and
     green, ochre and slate tiles.
   - `intake`: a Material 3 app. Kohinoor Telugu behind a Roboto stack, dusty
     rose tonal surfaces on a rose-white ground, a surface-coloured app bar
     over primary tabs, elevated cards and pill buttons.

   House tics, each already far past two sites: letterspaced caps labels (34 of
   65 landing pages carry three or more), a two-tone split wordmark (about 11),
   and a founding year in the tagline (about 11). A new site uses none of them,
   and a re-skin drops them.

   UNCLAIMED — start here instead:
   - Genres: a broadsheet newspaper front page, a 2014 Bootstrap corporate
     site, a dense Japanese portal, a Shopify-style direct-to-consumer store, a
     WordPress magazine or blog theme, a Swiss International-style grid, a 2003
     portal with bevels and gradients.
   - Faces no site renders its text mainly in: American Typewriter, Bodoni 72,
     Marion, STIX Two Text, PT Serif, Baskerville, Courier New, PT Mono, Hiragino
     Mincho, Microsoft Sans Serif, Marker Felt.
   - Palettes no site leads with: periwinkle and tangerine. Seafoam and peach
     appear only as small tints (`status`, `roles`). Dusty rose (`intake`) and
     sky blue on a light ground (`flaky`) were taken on 2026-09-19.
   - Webfonts: no site ships one, so a self-hosted OFL face under the site's own
     directory is open territory too (check its licence against rule 5).
9. **Deterministic.** Ship no wall-clock or random-dependent content unless the
   plan asks for it. Per-session server-issued codes are fine: the validator reads
   them back out of `ctx.pages.state` rather than hardcoding them.
10. **Silent by default.** Any `<audio>` or `<video>` a fixture ships carries
    `muted`, sets `volume = 0` in script, and never autoplays unmuted.
    `eval/verify.mjs` fails the gate on an unmuted media tag under `pages/`, because
    headless Firefox on macOS routes audio to the machine's speakers: an unmuted
    fixture beeps at whoever runs the eval, every run, and a synthesised tone counts.
    Muting costs the measurement NOTHING. A muted element still decodes,
    `currentTime` still advances, `timeupdate`/`ended` still fire, and WebVTT cues
    still activate. If a check needs audible output, drop the check rather than ship
    sound.

## Session and nonce infrastructure in server.mjs

- Every `.html` response without a valid `sid` cookie gets one
  (`HttpOnly; SameSite=Lax`) plus a fresh per-session nonce.
- HTML bodies carry the literal `__SESSION_NONCE__`, which the server substitutes
  with the session's nonce; page JS reads it as `const NONCE = '__SESSION_NONCE__';`
- `POST /api/beacon` with `{nonce, kind, data}` pushes `{sid, kind, data, at}` onto
  `state.beacons` and answers 403 on a bad or missing nonce; validators read those
  rows back through `ctx.pages.state.beaconsOf('<kind>')`.
- `getSession(req)` returns `{sid, session} | null`. `requireSession(req, res,
  nonce)` returns the same, or writes a 403 JSON body and returns `null`; the nonce
  comes from the body on POSTs and the `X-Session-Nonce` header on GETs.
- Per-session task state hangs off the session object
  (`found.session.myThing ??= …`), and `state.reset()` clears sessions and beacons
  before every task.
- The handler chain hands you `readBody(req)` (64 KB cap), `json(res, status, obj)`,
  `url.searchParams`, and `randomBytes`/`randomUUID`.
- Static files serve from `pages/` after the API chain, and a directory request gets
  `index.html`. That static server CANNOT do auth redirects, so gate the DATA behind
  `fetch`, never the page shell.
- HTML goes out with `Cache-Control: no-cache, private`, and never with `no-store`
  or `Vary: Cookie`, so Back and Forward reuse the browser's copy instead of
  refetching it and re-running the site's navigation stamps. A page whose every
  load must mint afresh sets `no-store` from its site's `onHtml` hook, as paylink's
  checkout does.
- A static path answers GET and HEAD only; any other method gets a 405. A form or a
  `fetch` that sends a body posts to an `/api/` route. A directory requested
  without its trailing slash gets a 301 to the slash form.

## Site conventions

Every site gets the same furniture a real one has, each piece in the site's own
design language. `sites/README.md` states what the server does with each file,
and `scripts/check-fixtures.mjs` fails the gate when a site breaks one.

- **Relative self-links.** A page links within its own site relatively
  (`href="help.html"`, `href="../index.html"`), never by a root path naming its
  own directory (`href="/flaky/"` inside `pages/flaky/`). A root path works in
  both serving modes, but it puts the directory name back in the address bar of a
  site served at its own origin. The one deliberate cross-origin link uses an
  `__ORIGIN_<KEY>__` token.
- **Privacy and Terms in the footer.** Every site's footer links a Privacy page and
  a Terms page that exist, written in the site's own voice. The check fails a
  footer that names Privacy or Terms without a link to an existing page: plain
  text, `#`, an external URL, or a link back to the front door. A footer is a
  `<footer>` that no `<article>`, `<aside>`, `<blockquote>`, `<figure>` or
  `<section>` owns, an element whose class or id ends in `foot` or `footer` or is
  `footbar`, or a `role="contentinfo"` element; a page with none of them, like gov's table
  layouts, has its last block of text checked instead. The phishing lookalike is
  exempt, because its footer links pointing at its own `index.html` are one of
  the tells `phish-pick` grades.
- **An optional 404 page**, `pages/<dir>/404.html`. The server serves it, with
  status 404, for any path under the site that has no file. Write its links
  relative to the site root, like any page in `pages/<dir>/`: the server adds a
  `<base>` at the site root, because the page is served at whatever path missed.
  That `<base>` sends a fragment-only link (`href="#main"`, a skip link, `#top`)
  to the site's front door, so a 404 page has none. It is served without a
  session, so it cannot use `__SESSION_NONCE__`.
- **An optional favicon**, `pages/<dir>/favicon.svg`, drawn in the site's own
  style. Every page of a site that ships one links it with a relative path
  (`<link rel="icon" href="favicon.svg">` at the root, `../favicon.svg` one level
  down), and the server answers `/favicon.ico` at the origin root with the same
  file.
- **`robots.txt`** is optional: a site without one gets a permissive default.
- **The two bank origins match.** `phish-pick` grades the lookalike's seeded
  tells, so a favicon, a 404 page or a `robots.txt` that only one of the two
  origins ships would be an extra, ungraded tell. Ship each in both, byte for
  byte, or in neither.

## Tool-surface limits are the measurement, not a design constraint

Build the page a competent web developer would build for the business it belongs
to. If a browser tool cannot cope with it, that is a result the eval exists to
report, not a fixture defect to engineer around.

This section used to say the opposite: it required every task to stay winnable
through every shipped surface. That rule quietly destroyed the measurement. Ship
only tasks that survive both surfaces and you have selected away exactly the cases
where the surfaces differ, which is the thing being compared. Worse, a corpus
tuned to fit inside a truncation limit can never report that the limit loses data
— and every one of the numbers below is a constant in one vendor's bundle
(`le=10`, `j=1e3`, `ie=100`, `MAX_ATTR_LENGTH=30` in
`@mozilla/firefox-devtools-mcp`), not a property of browsers or of HTML. Tuning
736 pages to those constants couples the corpus to a dependency's internals, and
bumping one of them silently retires whatever it was testing.

So the limits below are documented to help you READ RESULTS, never to shape a
fixture. When a run fails, they are the first thing to suspect:

- **Roughly 27 characters of a text node survive.** Text is capped at 100 in the
  page, then at 30 on the way out, and the truncator spends three on the ellipsis.
  "Your price for this item is $274.50" arrives as "Your price for this item
  is...". `href`, `src`, `value` and `name` take the same cap, and an `href` is
  absolutized before it is cut.
- **The walker stops at depth 10**, and bails entirely past **1000 nodes**. Both
  set a `truncated` flag that says the tree was cut but not where.
- **The walker never descends into shadow roots.**
- **`find` only searches text the snapshot returned**, so it cannot find what was
  truncated away.
- **Table cell content does not reach the snapshot** without an explicit
  `includeAll`, and even then the geometry needed to read a grid does not.
- **An empty element contributes no snapshot node at all**, so a positional grid
  closes up around a blank cell.
- **A flattened snapshot loses button-to-card grouping.**
- **Native `window.confirm()` is auto-dismissed instantly.**

The best tasks are the ones where a limit changes the STRATEGY a surface needs
rather than deciding the outcome outright: the agent has to scroll, search, open
the thing, or read the DOM another way. `shadow-unlock` is the model — it puts the
control inside a shadow root the walker cannot enter and leaves a real route in.
A task no surface can win is weak evidence, because a floor of zero does not
distinguish a bad tool from a bad agent; but do not fix that by softening the
page. Fix it by giving the page an honest second route, the way a real site has
one.

When a task does fail, record WHY: whether the graded datum reached the snapshot
the agent was given. The minted value is server-side and the snapshot text is
captured, so the two can be compared. That is what separates "the surface hid it"
from "the agent got it wrong", and it turns a truncation limit from something to
avoid into something measured.

## Anti-cheat rules

- **`POST /api/beacon` is default-deny** (`PAGE_BEACON_KINDS` in `server.mjs`): it
  accepts only the kinds shipped pages post, because a gate written as
  `beaconsOf('my-kind').length >= N` is forgeable with nothing but the page nonce.
  Grade on per-session counters your OWN endpoint maintains
  (`found.session.myThing`), and demote beacons to `detail`.
- **Anything under `pages/` is HTTP-reachable**, generators and bulk data included.
  Build scripts live in `scripts/gen/` and bulk rows in a module under `sites/`, both
  outside the served root. A generator that prints the answer key inside `pages/` is
  a one-request cheat.
- **A per-session value derived from the page-exposed nonce is reproducible** by
  anyone who knows the formula. Derive server-issued codes from `randomBytes`, never
  from the nonce.
- **A datum past the snapshot's caps never reaches the agent**, so a run that
  needed it fails. Do NOT reshape the page to fit the caps; that is the measurement
  (see "Tool-surface limits are the measurement"). Make the failure legible instead:
  log in `detail` whether the value the ask demanded was present in the snapshot the
  agent received, so a surface that hid it is not scored as an agent that missed it.
- **A client-reported fact is an assertion, not evidence.** Page script can claim any
  viewport width, any computed style, any layout measurement, so a mint that gates on
  the claim gates on nothing. Find the signal the browser produces as a side effect
  instead — which `<picture>` candidate the layout engine requested, whether a
  document navigation carried `sec-fetch-dest: document` — and treat the claim as
  corroboration in `detail`.

## Validator rules (brittleness is a bug)

- **Grading is server-observed, not agent-claimed.** Gate on state the server
  recorded; extracted answer fields are a second, narrower check, never the only one.
- A CORRECT agent must never fail on formatting: strip markdown emphasis
  (`text.replace(/[*_~`]+/g, '')`) before any prose regex.
- Never require a contiguous multi-token phrase or a rendered range like
  `10:00 am - 6:30 pm`; check the parts independently.
- Numbers: allow an optional `$`, optional thousands separators and spaces, and guard
  against substring matches with lookaheads (see the `fee-schedule` validator).
- Dates: fold the ordinal forms before comparing, through `normaliseDateWords` in
  `eval/extract.mjs`. A bare token test for the day number rejects every correct
  "June 12th".
- Multi-session shadowing: a curl probe or a re-minted cookie makes extra sessions,
  so pick the one that actually COMPLETED the flow (see `register-errors`,
  `checkout-stop`), never blindly `[0]`.
- Assert only state that actually exists, and log everything you checked in `detail`
  so a failure is diagnosable.
- **BIND FACTS TOGETHER; never AND independent substring tests.** This is the
  defect to watch for above all others. A validator that ANDs independent tests
  accepts a table whose points column is rotated one row, an answer naming the wrong
  winning region, added and removed lists swapped, and an answer declaring the MOST
  EXPENSIVE combination the cheapest, because every required token appears somewhere
  in an otherwise-correct answer. Bind each fact to the row or entity it belongs to.
  Bind structurally: declare an `answerSchema` whose rows are objects carrying the
  facts that must co-occur, then grade row by row. Copy `rate-limited-lookups`'
  `rowFor` or `oos-substitute`'s `orderedProducts` rather than inventing a scheme,
  and see `docs/grading-design.md` for how extracted fields reach your validator.
  Where a fact stays in prose, require the bound facts inside ONE clause.
- **Grade every signal you compute.** A validator that reduces server state into a
  variable and then leaves it out of the pass expression reads as though it graded
  that dimension, and did not — the value reaches `detail` and nothing else. Either
  fold it into the decision or drop it from the ask. Whatever the ask demands, the
  pass expression decides on.
- **Grade what the ask asks for.** Where the ask names a field, the schema declares it
  and the validator reads it. Where no check reads it, cut it from the ask instead of
  leaving the agent to produce output nothing scores.
- **Every validator change ships with regression strings.** On the task's driver in
  `eval/verify-drivers/`, `wrongFields` lists answers that must FAIL and
  `alsoCorrectFields` answers that must PASS, each graded against the golden run's
  server state. A server-state conjunct or a cross-session hole needs the state
  varied instead: `wrongState` (all must FAIL) and `alsoCorrectState` (all must
  PASS) take `{ name, mutate(state), fields? }` cases, and each case grades its own
  copy of that state, planted through the helpers in `eval/verify-drivers/lib.mjs`.
  The prose `wrong` / `alsoCorrect` strings run only under the paid `--extract`.
  Add the assertion FIRST, watch `node eval/verify.mjs --task <id>` go red, then
  change the validator. A tightening never seen to fail has not been shown to do
  anything. `docs/process.md` states the full fix-pass method.

## Prove the fixture works, not that the surface can win it

A fixture is finished once a real headless browser has driven it end to end. Each
driver in `eval/verify-drivers/` navigates and acts through the same
`firefox-devtools-mcp` server the condition uses, and returns the answer text a
correct agent would produce. Read `eval/verify-drivers/probes.mjs` (the driver
contract), `eval/verify-drivers/lib.mjs` (`until`, `clickToPath`, `uidOf`,
`snapText`, `bumpCode`, and `addSession`, `findSession`, `addBeacon` for state
cases) and `eval/verify-drivers/registrar.mjs` (shadowing probe, confirm dead end,
uid clicks), write your driver in the same shape, and run
`node eval/verify.mjs --task <your-id>`. Add `--origins` to drive it with every site
on its own port, the shape the container serves. That flag maps where the driver
navigates, not what it answers, so a driver whose answer names a URL reads it off the
page (`location.href`) rather than building it from `base`.

What green means: **the site behaves correctly and its server-side state lands**.
It does NOT mean the task is winnable through the snapshot. That is the result the
eval reports, so it must not also be the gate's precondition — a fixture that a
surface cannot read is a finding to publish, and the gate has to stay green while
you publish it.

So where a snapshot limit blocks the driver, reach past it with `ctx.evaluate`
(the gate starts the server with `--enable-script`, and most drivers already use
it) rather than reshaping the page. Two rules on that:

- **Prefer real interaction; use script to observe.** Clicking through script can
  satisfy a server-side gate without proving the control works. Read truncated or
  hidden values with `evaluate`; keep real clicks for acting, except where the
  surface genuinely cannot reach the control.
- **This licence is the driver's, never the validator's.** A driver is our own
  harness, so what it reads through script is trustworthy. An agent is not, so
  grading stays on server-observed state — see "A client-reported fact is an
  assertion, not evidence" above.

Drivers run headless by default (`--headed` for debugging). Poll with `until`
rather than sleeping, and read the answer out of `ctx.pages.state` only when the
task is unsolvable without it — say so in the driver's `note`.

A readiness poll must require something that did not exist before the action it waits
on. A predicate the previous state already satisfies returns on its first attempt and
the driver then acts on stale data: "no row is pending" holds before a re-render
starts, and a placeholder is non-empty before real content arrives. Gate on a counter
that must grow, or on a value the placeholder cannot produce. Navigate links with
`clickToPath` rather than clicking and polling for content, because a click can report
success without moving the document.
