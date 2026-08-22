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
   contact.
3. **Every page starts with `<!doctype html>` and carries `<meta charset="utf-8">`.**
   Fixtures under `pages/gov/` are the exception: that site is deliberately legacy
   HTML 4.01 (`<font>`, tables, spacer gifs), so match the neighbours.
   `pages/gov/handbook.html` is the one modern page in that tree.
4. **Brands, domains, phone numbers and identifiers must be verifiably fictional.**
   Search a brand against the real world before you use it, and reject any hit in
   the same sector as the fixture. Coin a word rather than borrowing a placename or
   a surname: invented consonant clusters come back with no hits, while real places
   and family names collide.
   - Domains: RFC 2606 reserved only — `<brand>.example`, `<brand>.example.net`,
     `example.com`. A fictional state's portal still uses one, e.g.
     `qta.gov.example`.
   - Phone numbers: reserved fiction ranges only. Ofcom's UK drama ranges, which
     the fixtures use as `0113/0117/0151/0161 496 0xxx`, `0808 157 0xxx`,
     `01632 960xxx` and `03069 990xxx`; or the NANP `(555) 01xx` block on US
     sites.
   - Company and VAT numbers must be unmistakable sentinels — `company number
     00000000`, `VAT 000 0000 00`. A well-formed registration number belongs to a
     real company, so never invent a plausible one.
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
   ALREADY CLAIMED — pick something different: Optima + Avenir Next Condensed
   caps, cream and rust (`pages/forms/kestrel/`), Helvetica/Arial + slate blue (`biglist`,
   `ledger`), Segoe UI + cool grey (`filemgr`, `shadow`, `bank`), Verdana + orange
   (`news/`), legacy HTML 4.01 tables + `<font>` (`gov/`), marketplace yellow
   (`shop/voltro`).
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
- **Every validator change ships with regression strings.** `eval/verify.mjs` takes
  `wrong` as a string OR an array (all must FAIL) and `alsoCorrect` as an array (all
  must PASS) on the task's driver in `eval/verify-drivers/`; schema tasks use
  `wrongFields` / `alsoCorrectFields`. Add the string FIRST, watch
  `node eval/verify.mjs --task <id>` go red, then change the validator. A tightening
  never seen to fail has not been shown to do anything. `docs/process.md` states the
  full fix-pass method.

## Prove the fixture works, not that the surface can win it

A fixture is finished once a real headless browser has driven it end to end. Each
driver in `eval/verify-drivers/` navigates and acts through the same
`firefox-devtools-mcp` server the condition uses, and returns the answer text a
correct agent would produce. Read `eval/verify-drivers/probes.mjs` (the driver
contract), `eval/verify-drivers/lib.mjs` (`until`, `clickToPath`, `uidOf`,
`snapText`, `bumpCode`) and `eval/verify-drivers/registrar.mjs` (shadowing probe,
confirm dead end, uid clicks), write your driver in the same shape, and run
`node eval/verify.mjs --task <your-id>`.

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
