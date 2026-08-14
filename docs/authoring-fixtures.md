# Authoring fixtures and validators

A fixture is a simulated site under `pages/`. A validator is the function in
`eval/tasks/` that grades a task on what that site's server observed.
`docs/process.md` covers the gate, the fix-pass method, and who owns which file.
Every path below is relative to the repo root.

The eval measures how the browser tool surface shapes a run, not how capable the
agent is, across two conditions: `mcp` (`firefox-devtools-mcp` over stdio) and
`playwright` (the vendored `@playwright/mcp`). Design a task for the band where the
surface decides the outcome: winnable through every shipped surface, yet not so easy
that every surface wins it identically. For scale: 94 tasks (86 web, 5 devtools, 3
basic smoke) run against 66 origins served from 53 fixture trees under `pages/`, and
`eval/verify.mjs` gates 91 of them with one deterministic driver each.

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
   ALREADY CLAIMED — pick something different: Georgia/serif + sage green
   (`pages/forms/kestrel/brochure.html`), Helvetica/Arial + slate blue (`biglist`,
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

## Tool-surface constraints a task must stay winnable within

A browser agent reads a page through an accessibility snapshot that drops and
truncates more than you expect. Design a task to stay winnable under these
constraints, never to turn on one:

- **Only 27 characters of a text node survive.** Text is capped twice on the way
  out: at 100 characters, then at 30 by a truncator that spends three on the
  ellipsis (`MAX_ATTR_LENGTH` is 30, `truncate()` takes the other 3). A graded datum
  must sit inside the first 27 characters of its node, not the first 30: "Your price
  for this item is $274.50" truncates to "Your price for this item is...", losing
  the number. `href`, `src`, `value` and `name` take the same 27-character cap, and
  an `href` is absolutized before it is cut, so a URL never disambiguates anything.
  An agent may echo a truncated string verbatim, so never require a long contiguous
  string in an answer.
- **The walker stops at depth 10** and truncates deep DOMs and iframes.
- **The walker never descends into shadow roots.**
- **`find` only searches the text the snapshot returned.** It misses text past 100
  characters in one node, and the snapshot's line cap hides a node past that cap, so
  never put a task's only affordance at the bottom of a long page.
- **Table cell content does not reach the snapshot** without an explicit
  `includeAll`, and even then the geometry needed to read a grid does not.
- **An empty element contributes no snapshot node at all.** Blank layout cells vanish
  and a positional grid closes up around the gap: a calendar whose first day should
  be inset by its weekday offset reads as starting on the first column. Name what a
  cell means rather than leaving it to position — `pages/cabins/index.html` puts the
  weekday in each day button's accessible name.
- **A flattened snapshot loses button-to-card grouping**, which is what makes a bare
  "Add to cart" ambiguous.
- **Native `window.confirm()` is auto-dismissed instantly**, so use an in-page modal
  for any dialog task.

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
- **Anything the validator reads out of the snapshot dies at the 27-character cap**
  above: design the fixture around the cap, not around what the page renders.
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

## Prove the fixture through the MCP surface

A fixture is finished once a real headless browser has driven it end to end through
the MCP surface. Each driver in `eval/verify-drivers/` navigates, snapshots, and clicks
by uid through the same `firefox-devtools-mcp` server the `mcp` condition uses, and
returns the answer text a correct agent would produce. Read
`eval/verify-drivers/probes.mjs` (the driver contract), `eval/verify-drivers/lib.mjs`
(`until`, `clickToPath`, `uidOf`, `snapText`, `bumpCode`) and
`eval/verify-drivers/registrar.mjs` (shadowing probe, confirm dead end, uid clicks,
snapshot-visibility assertion), write your driver in the same shape, and run
`node eval/verify.mjs --task <your-id>`.

That driver IS the self-test: `eval/mcp-stdio.mjs` is a library with no entrypoint, and
no shell command drives the browser. Drive the whole solution path, confirming that
the page works, that server-side state lands, and that the task is winnable through
the snapshot and `find` surface. Drivers run headless by default (`--headed` for
debugging). Poll with `until` rather than sleeping, and read the answer out of
`ctx.pages.state` only when the task is unsolvable without it — say so in the
driver's `note`.

A readiness poll must require something that did not exist before the action it waits
on. A predicate the previous state already satisfies returns on its first attempt and
the driver then acts on stale data: "no row is pending" holds before a re-render
starts, and a placeholder is non-empty before real content arrives. Gate on a counter
that must grow, or on a value the placeholder cannot produce. Navigate links with
`clickToPath` rather than clicking and polling for content, because a click can report
success without moving the document.
