# Working on zoo-sites

This repository holds two things: 66 locally-served simulated origins, across 53
fixture trees under `pages/` with their backends in `sites/`, and a browser-agent
eval over them in `eval/`. The eval runs 94 tasks — 86 web, 5 devtools, 3 basic
smoke — and grades each on what the site's server observed, not on what the agent
claimed. The tool surface is a configurable condition, so the same 94 tasks measure
whichever stdio MCP browser server you point them at. The eval measures how that
surface shapes a run rather than scoring models, and the signal lives in efficiency
and in the rare failure, not in the pass rate.

This document covers both halves, because a fixture edit and a validator edit break
each other. `eval/README.md` is the shorter orientation if you only want to run the
eval.

## The gate

```sh
node eval/verify.mjs                              # full gate, under 2 min, no API budget
node eval/verify.mjs --task cart-math,pr-review   # narrow while iterating
node eval/verify.mjs --list                       # every task, and its driver kind
node eval/verify.mjs --origins                    # every site on its own port, the container's shape
```

Run the gate after touching any fixture, validator, or server code, and get it
green before committing. It drives 91 golden paths through real headless Firefox
and this repo's MCP client, asserting per task that the validator accepts a
correct answer and rejects a wrong one. Nothing else catches a well-meaning edit
that silently breaks a task, and a restyle can change measured behaviour with no
logic change at all. Validators that reject correct answers are the defect to
watch for most closely. `node eval/verify.mjs --extract` adds the real extraction model
over driver answers and costs money, so it sits outside the free gate.

The default gate serves every site under a path prefix on one port. The container
(`serve.mjs`) serves each site on its own port with the site's directory at `/`, so
a bug that only exists there, such as a Referer check that expects the prefix, passes
the default gate. `--origins` runs the gate in the container's shape: each worker
binds every origin on an ephemeral port, and the asks carry the origin URLs.
Only navigation is mapped: `goto` sends a driver's single-origin path to the site
that owns it, so a driver runs in both modes without an edit. The answer a driver
returns is not mapped. A driver that builds an answer value from `helpers.base` or
a prefixed path such as `/bank/caldmoor-bank-login/` still reports the
single-origin answer. The validator accepts that answer, and the task goes green,
while an agent that reports the origin URL it actually read fails. A green
`--origins` run therefore proves the sites and their server state work in the
container's shape, not that every task grades an origin-mode answer correctly. A
driver whose answer names a URL proves the second only when it reads the URL off
the page (`location.href`) or out of the ask.

Read the failures block, never the exit status of a piped gate: `node eval/verify.mjs
| tail` reports tail's status, which hides a red gate.

## Read before you edit

- **Fixtures** (`pages/`): `docs/authoring-fixtures.md` — hard rules, the session
  and nonce infrastructure already in `server.mjs`, why tool-surface limits are the
  measurement rather than a design constraint, validator rules.
- **Validators** (`eval/tasks/`, `eval/answers.mjs`): "Fixing a defect" below. Work
  test-first; skipping it introduces mis-grades faster than it lands fixes.
- **Shared files** (`eval/run.mjs`, `eval/answers.mjs`, `server.mjs`): one writer at a time;
  see "Fixing a defect", rule 2.
- **Results** (`eval/results/run-<timestamp>/`): "Reading results honestly" before
  quoting a number or reading a difference between two runs as a result.

`docs/authoring-fixtures.md` states the hard rules in one copy, so no second list
can drift against it. In outline: ground truth stays off `pages/`, no page implies
it is a test fixture, brands and identifiers stay verifiably fictional, media stays
silent, and each site carries its own design language. Each binds every fixture and
every validator.

## Local setup

```sh
npm install
npx playwright install firefox
node eval/verify.mjs
```

Node 20 or newer; CI pins 22. `npm install` fetches harness dependencies only; the
site server itself uses node builtins. The `firefox-devtools-mcp` condition and the gate resolve
`firefox-devtools-mcp` in this order:

1. `--mcp-command "<cmd>"` (`eval/run.mjs` only)
2. `FIREFOX_DEVTOOLS_MCP=/path/to/checkout`, a checkout's repo root, whose
   `dist/index.js` is used; the checkout must have been built (`npm run build`)
3. the `@mozilla/firefox-devtools-mcp` dependency installed by `npm install`

Without one of the last two the gate throws before its first task, naming the path
it looked for. Export the env var to measure your own build of
`firefox-devtools-mcp` in both the gate and paid runs; pass `--mcp-command` to
measure another MCP browser server in place of the built-in one.

Browsing the sites needs none of that. Both servers bind `127.0.0.1`; keep them
off public networks, for the reasons README gives under "Do not serve these
fixtures on a public network". The index and the contact sheet are dev-only and
404 during real runs, because the index names each task's trick.

```sh
node server.mjs --port 8907   # / is a generated index, /_preview a contact sheet
node serve.mjs                # every origin on its own port (the container shape)
```

## Paid runs

`eval/run.mjs` spends real money against a real API. Preview for free with
`--list-tasks`, then develop against a single `--task`.

```sh
node eval/run.mjs --suite web --list-tasks                     # free
node eval/run.mjs --suite web --parallel --parallel-tasks 2    # ~$15-25
node eval/run.mjs --suite all --parallel --parallel-tasks 4    # ~$40, the full sweep
```

The full sweep runs every task in every configured condition. Its cost varies by
several dollars between runs at identical work, so treat the figure as a budget
rather than a measurement — see "Reading results honestly".

## Proposing a new task

A task is five artifacts: a fixture, server state, a task entry, its answer key,
and a golden-path driver.

1. **Fixture** under `pages/<site>/`: its own design language, no test-harness
   tells.
2. **Server state** in `sites/<site>.mjs`, registered in `sites/index.mjs`, per the
   module contract in `sites/README.md`. The graded value is minted here.
3. **Task entry** in the family module under `eval/tasks/web/` (or
   `eval/tasks/devtools.mjs`): `{ id, ask, answerSchema, validate }`, with the answer
   key in `eval/answers.mjs`. A pure-extraction task adds `truth: { kind: 'static',
   reason }` (see "Fixing a defect", rule 1). `eval/tasks/web.mjs` concatenates the
   families, so it needs no edit unless the task starts a new one. Build URLs from the `origins.<key>`
   templates; a new origin is a `manifest.mjs` entry keyed by domain, with its
   `dir` under `pages/`. Per-task turn limits are deliberately absent: runaway
   protection lives in `--max-wall` and `--max-output`.
4. **Golden-path driver** in `eval/verify-drivers/<family>.mjs`, merged by
   `eval/verify-drivers/index.mjs`: it navigates, clicks by uid, and returns the answer
   a correct agent would produce, having genuinely satisfied the server-observed
   gates. `eval/verify-drivers/probes.mjs` is the contract; `eval/verify-drivers/registrar.mjs`
   is the quality bar.

**A task without a driver cannot be gated** and will not be accepted. A task whose
success is prose or judgment marks its driver `canned: true`: the interaction is
real and the prose supplied, proving that the validator accepts a correct answer
rather than that a driver can compose one.

Self-test both halves first. Over curl with a cookie jar and a nonce scraped from
the served HTML, drive the happy path end to end, confirm a forged nonce and a
sessionless request each get a 403, and confirm the graded ground truth is absent
from disk (`grep -rniE '<the strings>' pages/` returns nothing). Then run
`node eval/verify.mjs --task <your-id>`. `docs/task-ideas.md` holds the queue of
planned tasks with their implementation plans.

## Building a wave of tasks

Tasks land in waves, and a wave has a fixed shape. One agent writing a task
unsupervised produces cheatable tasks and brittle validators, so every stage below
exists to catch a specific class of that.

1. **Implement.** One author per fixture group, in parallel, writes the fixture
   pages plus a spec at `staging/<ID>.md` carrying one paste-ready fenced code
   block per destination file: the `sites/` handler, the `eval/answers.mjs` entry, the
   task entry, the driver. Implementers do not touch the shared files.
2. **Spike the tool where a task depends on it behaving** (see "Spikes find what
   runs cannot"). A spike may conclude "do not ship this task", and that verdict is
   worth more than the task would have been.
3. **Adversarial review.** A second agent per group attacks cheatability, validator
   correctness, brittleness, realism and plan fidelity.
4. **Fix pass.** A third agent works the blockers and majors the review raises.
5. **Central integration.** One agent pastes the specs into the shared files,
   extracting the fenced blocks programmatically (see Traps).
6. **Golden paths green twice.** Once catches load races, twice catches flakiness.
7. **Acceptance.** `--repeat 3 --retries 3`, then medians with ranges, because a
   single sample decides nothing.
8. **Record and commit.** Mark shipped ideas in `docs/task-ideas.md` with the task
   id they became; keep the commit message terse and one line.

## Spikes find what runs cannot

The suite's own agent runs will not find a broken tool, because an agent that can
route around it will. A drag-based task whose page also offers a button gets solved
through the button, and the pass rate looks identical whether the drag tool works or
not. Only a deliberate capability spike distinguishes those.

So drive a capability through the tool surface before you build a task on it, and
spike the tools no task exercises. A tool that reports success while doing nothing
is the failure mode to expect, and `drag_by_uid_to_uid` is the standing example: it
sends only untrusted dragstart and drop events, so a pointer-driven list does not
move while the tool reports a drag. `set_viewport_size` silently clamps,
`evaluate_script` caps at 5s, and a wrapping label does not name an input. `fill` on
`type=range` silently keeps the old value. On `type=date` it takes an ISO value and
silently leaves the field empty for the locale's typed order (03/04/2027), and on
`datetime-local` it is the reverse: an ISO value silently stores a wrong date, and
only the locale's typed order lands. On `select[multiple]` it leaves one option selected. Design around each
rather than discovering it mid-build. A task built on a capability that does not work
grades the tool's bug instead of the agent.

The spikes live in `eval/spikes/`, one script per capability, each keyed to the tool
versions it was measured on; `eval/spikes/README.md` lists what each measured and
how to rerun them all after a version bump. No spike covers scroll or coordinate
clicks yet, and `eval/spikes/tools.mjs` lists every devtools tool no driver calls.

## Fixing a defect

Do not reuse the wave workflow on a validator. Parallel agents editing validators
introduce new false passes and new false fails faster than they close real ones,
and only a late adversarial pass catches it.

1. **Write the failing assertion first.** Add the mis-graded case to the task's
   driver as `wrongFields` (must fail) or `alsoCorrectFields` (must pass), run
   `eval/verify.mjs`, and confirm it goes **RED** naming that case. A fix whose test
   never failed first has not been shown to do anything. Use the field forms, not
   `wrong`/`alsoCorrect`: every gated task is a schema task, and the free gate only
   exercises the field arrays. The plain-string `wrong`/`alsoCorrect` arrays run
   under `--extract`, which costs API budget, so an assertion written there stays
   green in the gate you actually run.

   The field arrays vary only the answer, always against the golden run's server
   state, so they cannot catch a hole in the state half of a validator: a conjunct
   such as "no purchase" that has gone always-true, or a cross-session hole such as
   a purchase made under a second cookie. Write those as `wrongState` (must fail) or
   `alsoCorrectState` (must pass), a list of `{ name, mutate(state), fields? }`
   cases. Each case's `mutate` plants the hole in a copy of the golden state, and the
   validator grades that copy with the driver's own fields unless the case gives
   `fields`. `addSession`, `findSession` and `addBeacon` in
   `eval/verify-drivers/lib.mjs` cover the common plants, and the `lexvane-hard`
   driver is the worked example.

   The gate also grades every task against three generic state mutants, so a state
   half that reads nothing fails without anyone writing a case for it. Each mutant
   is a copy of the state, graded with the driver's own fields. `empty` is the state as `reset()`
   left it before the driver ran, `fresh` adds one session that never acted, and
   `shadow` is the golden state with an unused session minted ahead of the run's, the
   one a curl probe leaves. A task's truth is minted by default: `empty` and `fresh`
   must fail, and `shadow` must pass. A pure-extraction task whose answer is published
   page content (hard rule 1 in `docs/authoring-fixtures.md`) declares
   `truth: { kind: 'static', reason }` on its task entry instead (`{ kind: 'minted' }`
   states the default). The gate exempts a static task from the mutants and names it
   after the totals, but checks the declaration twice: the task must still pass
   `empty`, so a declaration the validator has outgrown fails, and its golden answer
   must carry no code the server minted into session state, so a holed validator
   cannot hide behind one. That second check sees only code-shaped values
   (`mintedValues` in `eval/surface-reach.mjs`), so never declare a task static to
   silence a mutant when the server mints its answer: there a surviving mutant is a
   validator hole.
2. **Serialise edits to `eval/run.mjs`, `eval/answers.mjs` and `server.mjs`.** Parallel agents
   cannot speed up a single-writer resource; they can only add a spec-then-integrate
   indirection, and that indirection is its own defect source — wrong line numbers,
   byte-identical anchors claimed twice, patches referencing variables absent from
   the target file. Partition by FILE, never by topic.
3. **Batch 3-5 fixes, gate, commit.** A green `eval/verify.mjs` between increments makes
   a bad fix cheap to abandon.
4. **The deliverable is a green gate, not a patch.** Report `eval/verify.mjs` output; a
   bespoke harness built alongside it is weaker than the gate it replaces.
5. **One decision per finding.** In a schema, never let a per-item verdict coexist
   with a separate blockers list: the two contradict each other and a task gets
   misread as safe.
6. **Never loosen a validator to make the suite green.** A fix that causes a failure
   you cannot resolve inside its own scope gets reverted and recorded as unlanded.
7. **Keep the adversarial pass, and tell the reviewer to refute.** A reviewer asked
   to "check this" produces agreement, so ask it to reproduce the defect and to treat
   anything it cannot reproduce as refuted. Expect it to refute roughly a third of
   severe claims. Have it read the tool-surface constraints in
   `docs/authoring-fixtures.md` first: re-reporting a constraint the fixtures
   deliberately design around is the most common false positive here.

Those assertions accumulate into the gate's memory. All 91 drivers carry them, and a
full run exercises 542 wrong answers and 136 wrong server states that must all fail,
and 390 accepted variants and 98 accepted states that must all pass, so a change that
re-breaks one fails the run and names it. The generic mutants add 158 erased states
that must fail and 79 shadow sessions that must be ignored, across the 79 minted-truth
tasks, and 12 tasks are static. Read the current counts off `node eval/verify.mjs`,
which prints them per task and totals them in its `cases exercised` line, the mutants
as `mutants killed` and `shadow sessions ignored`.

A review of N findings is a QUEUE. Rank it, work it in small verified increments,
and expect the tail to be wrong: cosmetic items reported once and never reproduced
are the bulk of any large review.

## Check the numbers you hand to someone else

The facts you carry into a work split are wrong more often than they feel, and a
count quoted from memory is wrong about as often as it is right.

So state a number only after running the command that produces it, and when someone
doing the work contradicts a number you gave them, measure it again yourself rather
than deferring either way. Either side can be the stale one: a number can be plainly
wrong, or it can have been right when measured and gone stale because the tree
changed underneath it.

Two fix shapes are worth knowing, because the plausible version of each does not
work:

- **A verdict window that absorbs a list does not bind it.** Grading a per-item list
  through a regexp window over prose adds false fails; making the list a graded
  schema field is the shape that works.
- **A gate scoped to one session is defeated by re-minting the session.** Count the
  thing across all sessions, in order, so that a session boundary buys nothing.

## Reading results honestly

- **Output tokens are the comparable efficiency metric.**
- **Turns compare only between runs whose backend counts a turn the same way.**
  Codex only approximates a turn, and surfaces pack different amounts of work into
  one call: a shell-driven surface measures about 1.21 browser operations per turn
  against 1.00 for a per-tool MCP surface.
- **Cost compares within one run and never between two.** Every condition in a run
  meets the same prompt cache, so a ratio there is fair; across runs, cache-creation
  volume swings enough to move a ratio from 1.03 to 1.50 at identical turn counts.
  Treat a run's cost as its budget, not its score.
- **A pass rate counts graded attempts.** A row marked `infra` never reached a
  grade, because an API or transport error outlived `--retries`; it sits in its own
  column. A wall-limit stop is NOT infra even though the harness retries it, since
  an agent that spends every retry on the clock really was too slow.
- **Always report median with range and the spread flag.** Identical repeats of one
  task have been observed at 7, 33 and 8 turns, and the `>2x spread` flag catches
  bugs a bare median hides.
- **Pass rate sits near the ceiling by design**, because the tasks are built so that
  efficiency discriminates. The failure is the interesting event; read the `detail`
  string, which names every sub-check.
- **A token comparison on a dense page means nothing unless you say whether a
  snapshot-only path existed.** An agent looks cheap there largely because it stops
  snapshotting and starts scripting — a fact about the path it took, not about the
  surface it took it through.

## Standing decisions

- **The suite targets the surface that ships.** Golden-path drivers target the
  current surface, and fixtures keep designing around the known constraints, so
  nothing here depends on an unshipped tool improvement. Point
  `FIREFOX_DEVTOOLS_MCP` at a local build to measure that build instead; the pinned
  package stays the default.
- **Server-observed grading beats agent claims**, always. A task graded on prose
  alone can be passed by asserting success.
- **Determinism stops at the mint.** `--seed` makes the difficulty draws
  deterministic and `--mode` pins one variant, but identifier mints stay on
  `randomBytes` regardless, so a run is reproducible and never forgeable.
- **Devtools-surface tasks live in their own suite** (`--suite devtools`), never
  mixed into the web suite.
- **`POST /api/beacon` is default-deny.** It accepts an arbitrary `kind`, so any
  gate written as `beaconsOf('k').length >= N` is forgeable by anything holding the
  page nonce. The allowlist in `server.mjs` is exhaustive and was derived, not
  guessed; regenerate it with both greps named in the comment above it, because some
  pages post through a helper.
- **The eval caps nothing a validator reads.** Validators grade beacon rows by
  absence and by order, and read sessions across cookies. Under a cap, anything
  holding a page nonce can flood the beacon log, and any client can mint sessions
  with cookieless page loads, until an incriminating row or session falls off the
  front. The caps in `server.mjs` apply only under `capped`,
  which `serve.mjs` sets for the standing habitat and the eval never does.
- **A readiness poll must require something that did not exist before the action.**
  A predicate the previous state already satisfies returns immediately and the driver
  acts on stale data: "no row is pending" is true before a re-render starts, and a
  placeholder is non-empty before real content arrives. Gate on a counter that must
  grow, or on a value the placeholder cannot produce.

## Traps

- A constant that looks arbitrary is usually load-bearing. `biglist-needle` scrolls
  by `250 * 40`, where 250 is the chunk size and 40 is the row pitch
  (`ROW_H` in `pages/biglist/app.js`, matching `.row { height: 40px }`). A jump to
  the bottom does not work either, because the list streams by scroll position and
  the search only covers batches already streamed. Find out why a working number
  works before improving it, and leave the reason in a comment.
- `eval/run.mjs` auto-runs `main()` on import. Import task definitions from
  `eval/tasks/{basic,web,devtools}.mjs`, never from the runner.
- Spec code blocks containing `\uXXXX` escapes must be extracted programmatically.
  Retyping turns them into raw Unicode characters: invisible and wrong.
- A run can emit **more than one SDK result message** when the agent uses a
  background task. `usage` is per-segment while cost and durations are cumulative,
  and the row carries `segments` when this happened. Summing them wrongly reports a
  many-turn run as a single turn.
- **Never close the last browser tab** — it bricks the instance.
- Viewport and tab state leak between tasks whenever a browser is shared. Paid runs
  get a fresh browser per task, but `eval/verify.mjs` reuses one browser per worker, so a
  driver that resizes the window or opens a tab must restore 1366x768 and close what
  it opened.
- `click_by_uid` can report a successful click that never navigated, and the uid can
  go stale. `clickToPath` in `eval/verify-drivers/lib.mjs` re-resolves a fresh uid per
  attempt and confirms the document changed; use it for link navigation rather than
  clicking and polling for content.

## Lessons the design encodes

- **The field is the claim.** Grading on extracted fields removes the need for
  clause-scoping, negation and window machinery. When a validator needs a regexp over
  prose to bind a fact to a conclusion, the fix is a schema field, not a better
  regexp. Schema `description` strings are the per-field instruction channel to the
  extractor ("name only, no title").
- **Grade every signal you compute.** A value that reaches only the `detail` string
  looks graded to whoever reads a passing row, and is not. Either fold it into the
  pass expression or state in a comment that it is telemetry.
- **Move-only surgery needs a real parser.** A regex and brace-counting codemod
  cannot see braces inside template literals; an acorn-based rewrite can. Run the
  gate after every batch, not at the end.
- **Audit references in both directions after moving code.** An extraction batch
  leaves helpers behind; a short identifier cross-check script finds them statically
  instead of at runtime.
- **Scope commits by path when agents run in parallel.** A blanket `git add -A`
  during a fan-out sweeps another agent's half-finished work into an unrelated
  commit.
- **Freeze lists beat trust.** Give design-pass agents an explicit "driver-frozen
  surfaces" list per site group.
- **Isolate the dispatcher.** A throwing site handler must not take down the shared
  pages server, so the dispatch loop 500s and keeps serving.
