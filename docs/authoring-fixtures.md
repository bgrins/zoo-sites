# Authoring fixtures and validators

A fixture is a simulated site under `pages/`. A validator is the function in
`eval/tasks/` that grades server-observed work or an extraction from published content.
`docs/process.md` covers the gate, the fix-pass method, and who owns which file.
Every path below is relative to the repo root.

The eval measures how the browser tool surface shapes a run, not how capable the
agent is, across two conditions: `firefox-devtools-mcp` (over stdio) and
`playwright-mcp` (the vendored `@playwright/mcp`). Build each fixture as the real
site it imitates, and let the surfaces succeed or fail against it on their own: a
task that one surface loses is a finding, not a bug to author away. See
"Tool-surface limits are the measurement" below. For scale: 102 tasks (94 web, 5
devtools, 3 basic smoke) run against 67 origins served from 54 fixture trees under
`pages/`, and `eval/verify.mjs` gates 99 of them with one deterministic driver each.

## Where to look first

1. For unbuilt tasks, start with the `### <ID> — …` plan in `docs/task-ideas.md`
   (Fixture / Server / Ask / Validator). For shipped tasks the plan is gone;
   their fixture, site module, validator and driver are the specification.
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

Apply the fixture rules to pages and site modules, and the validator rules to
grading. The stated exceptions matter.

1. **Keep interaction-task ground truth off `pages/`.** Mint codes, messages and
   figures per session in `sites/`, or grade what the server observed ("the server
   saw a compliant submission"). Assume the agent can `cat` and `grep` everything
   under `pages/`. A pure-extraction task is different: its published document or
   table is meant to contain the answer. Make the source of truth clear; keep
   unpublished answer-only artifacts outside `pages/`. The validator may compare
   against `eval/answers.mjs` or derive its expectation from published data.
2. **Nothing under `pages/` may say or imply a site is a test fixture.** No
   disclaimer that the site is fictional, simulated, a test fixture, or built for
   browser automation. Titles, headings, body copy and footers read as a real
   company's — appropriate legal links, address and support contact. Any Privacy
   and Terms links lead to pages that exist, written in the site's own voice
   (see "Site conventions" below).
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
     `(555) 01x-xxxx`, which puts 555 in the area-code slot.
   - Company, charity, VAT and regulator register numbers must be unmistakable
     sentinels — `company number 00000000`, `VAT 000 0000 00`, `Registered
     charity 0000000`, `firm reference 000000`. A well-formed registration number
     belongs to a real registrant, so never invent a plausible one.
5. **No emoji anywhere** — code, comments, log messages, strings, documentation.
   Write original content; use third-party assets only when their licences allow
   redistribution and keep their required attribution and licence text.
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

   See `docs/site-design-audit.md` for the dated style census and ideas for
   designs not yet in use. Re-measure as sites change; the audit is a starting
   point, not a permanent list of forbidden choices.
9. **Deterministic.** Ship no wall-clock or random-dependent content unless the
   plan asks for it. Per-session server-issued codes are fine: the validator reads
   them back out of `ctx.pages.state` rather than hardcoding them.
   - A date that has to stay ahead of the run is the exception: a notice in force,
     a booking, an appointment, a deadline, an embargo, a validity window. A fixed
     one ages, and an agent that compares it with today reaches a different
     answer: the 2026-09-20 sweep read locale-notice's closure as expired, because
     its page says notices withdraw on their stated end date. Mint such a date in
     `sites/` as a day offset from the day the session opened, in UTC, and render
     it into the page, as `sites/intl.mjs` and `sites/forms.mjs` (the Nerrow
     Strait calendar) do; `utcDay` and `dayText` in `sites/lib.mjs` count and
     print the days. Move everything the date drags with it: its weekday, the
     month and year words around it, and the dates it sits between. A history of
     dates that ends in one, like a bill run ending in a due date, moves as a
     whole, and moving it in whole weeks keeps every weekday: `sites/utility.mjs`
     anchors the pdf-bill account's bills on a Thursday a few weeks before the
     session. The driver then checks each rendered date against today, as the
     `locale-notice`, `abstract-length` and `pdf-bill` drivers do, so a date that
     stops moving turns the gate red.
   - A date the ask dictates cannot move without changing the task, so set it
     years ahead and have the driver guard it, as the `form-gauntlet` driver
     guards `ANSWERS.form.fields.date`: it prints a note from a year out and
     fails the gate once the date is under a quarter away. That is the one place
     the wall clock alone may turn the gate red, because a dictated date that has
     aged is a broken task: the ask's first date, `2026-08-12`, passed with
     nothing in the gate to say so.
   - A date already in the past when the site shows it (a run log, a changelog,
     an effective date) is history and stays static.
10. **Silent by default.** Any `<audio>` or `<video>` a fixture ships carries
    `muted`, sets `volume = 0` in script, and never autoplays unmuted.
    `eval/verify.mjs` fails the gate on an unmuted media tag under `pages/`, because
    headless Firefox on macOS routes audio to the machine's speakers: an unmuted
    fixture beeps at whoever runs the eval, every run, and a synthesised tone counts.
    For the shipped tasks, muting preserves the measurement: a muted element
    still decodes, `currentTime` advances, `timeupdate`/`ended` fire, and WebVTT
    cues activate. If a check needs audible output, drop the check rather than
    ship sound.

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

Give each site the furniture its genre calls for, in its own design language.
`sites/README.md` states what the server does with each file. The static checker
fails broken links and warns about missing legal-page links.

- **Relative self-links.** A page links within its own site relatively
  (`href="help.html"`, `href="../index.html"`), never by a root path naming its
  own directory (`href="/flaky/"` inside `pages/flaky/`). A root path works in
  both serving modes, but it puts the directory name back in the address bar of a
  site served at its own origin. Deliberate cross-origin links use an
  `__ORIGIN_<KEY>__` token.
- **Privacy and Terms in the footer.** A real site's footer usually links to
  Privacy and Terms pages in its own voice. The checker warns if a site has no
  such links; it fails a footer that names Privacy or Terms without a link to
  an existing page. Plain text, `#`, an external URL or a link back to the front
  door does not count. A footer is a `<footer>` that no `<article>`, `<aside>`,
  `<blockquote>`, `<figure>` or
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

Do not tune pages to one vendor's snapshot caps; that would hide the differences
this eval exists to measure. The observed limits of firefox-devtools-mcp 0.10.3
are in `docs/browser-tool-limits.md`. They help interpret a failure, not decide
how a site should look, and can change with a tool upgrade.

The best tasks are the ones where a limit changes the strategy a surface needs
rather than deciding the outcome outright: the agent has to scroll, search, open
the thing, or read the DOM another way. `shadow-unlock` is the model — it puts the
control inside a shadow root the walker cannot enter and leaves a real route in.
A task no surface can win is weak evidence, because a floor of zero does not
distinguish a bad tool from a bad agent; but do not fix that by softening the
page. Fix it by giving the page an honest second route, the way a real site has
one.

When a task fails, record whether the graded datum reached the snapshot the
agent received and whether another available tool could read it. Compare the
minted value with the captured snapshot text; do not mistake a clipped snapshot
for proof that the agent could never reach the value.

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
- **A client-reported fact is an assertion, not evidence.** Page script can claim any
  viewport width, computed style or layout measurement. A requested `<picture>`
  candidate or `sec-fetch-dest: document` is stronger evidence against ordinary
  page script, but a shell client can forge headers and requests. Treat these as
  signals within the task's threat model, not proof of a real browser action;
  record the uncertainty in `detail`.

## Validator rules (brittleness is a bug)

- **For interaction tasks, grade server-observed work, not just agent claims.**
  Extracted answer fields provide a second check. Pure extraction tasks may grade
  published content directly; identify them as static truth.
- A CORRECT agent must never fail on formatting: strip markdown emphasis
  (`text.replace(/[*_~`]+/g, '')`) before any prose regex.
- Never require a contiguous multi-token phrase or a rendered range like
  `10:00 am - 6:30 pm`; check the parts independently.
- Numbers: allow an optional `$`, optional thousands separators and spaces, and guard
  against substring matches with lookaheads (see the `fee-schedule` validator).
- Dates: fold the ordinal forms before comparing, through `normaliseDateWords` in
  `eval/extract.mjs`. A bare token test for the day number rejects every correct
  "June 12th".
- A free-text field matched against page wording reads its verified quote too:
  `quoteOf(container, key)` in `eval/extract.mjs` exposes it. Check the extracted
  value and quote separately, as `phish-pick` does. Use `quotedFields` in
  `eval/verify-drivers/quotes-lib.mjs` to test quote cases; the quote-gate
  exceptions and rationale are in `docs/grading-design.md`.
- Multi-session shadowing: a curl probe or a re-minted cookie makes extra sessions,
  so pick the one that actually COMPLETED the flow (see `register-errors`,
  `checkout-stop`), never blindly `[0]`.
- Assert only state that actually exists, and log everything you checked in `detail`
  so a failure is diagnosable.
- **Bind related facts together.** Independent substring tests accept a table
  with a rotated column or an answer that swaps added and removed items. Use an
  `answerSchema` with objects whose row or entity carries the facts that must
  co-occur, then grade each one. See `rate-limited-lookups`' `rowFor`,
  `oos-substitute`'s `orderedProducts` and `docs/grading-design.md`. If a fact
  stays in prose, require its related facts inside one clause.
- **Grade every signal you compute.** A validator that reduces server state into a
  variable and then leaves it out of the pass expression reads as though it graded
  that dimension, and did not — the value reaches `detail` and nothing else. Either
  fold it into the decision or drop it from the ask. Whatever the ask demands, the
  pass expression decides on.
- **Grade what the ask asks for.** Where the ask names a field, the schema declares it
  and the validator reads it. Where no check reads it, cut it from the ask instead of
  leaving the agent to produce output nothing scores.
- **Every validator change gets regression cases.** In its driver, `wrongFields`
  must fail and `alsoCorrectFields` must pass against the golden server state.
  For server-state or cross-session bugs use `wrongState` and
  `alsoCorrectState`; for extractor or quote-gate bugs use `wrongExtraction`
  and `alsoCorrectExtraction`. Prose `wrong` / `alsoCorrect` strings only run
  under paid `--extract`. Add the failing case first and watch
  `node eval/verify.mjs --task <id>` go red before fixing the validator.
  `docs/process.md` gives the case formats and full fix-pass method.

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

What green means: **the site behaves and its server state or published data grades correctly**.
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
  harness, so it can use script to inspect a page. For interaction tasks, the
  validator still grades server-observed work; for pure extraction, it grades
  published content. See "A client-reported fact is an assertion, not evidence"
  above.

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
