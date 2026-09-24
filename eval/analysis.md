# Analyzing eval runs

## From a run to an A/B report

Every reader takes a run directory, which `run.mjs` prints at the end as
`run dir: <path>`. The readers take the rows from `results.json`, or, for a run killed
before it wrote one, from `meta.json` and `rows.jsonl` (`run-files.mjs` `readRun`).
`judge.mjs` alone needs `results.json`, and `--report-from` rewrites `report.md` from a
killed run without writing one. What the rows do not carry, the readers read from four
directories beside them, and a reader reads a row without the file it lacks:

| directory | holds | read by |
|---|---|---|
| `transcripts/` | each attempt's message stream | `transcript.mjs`, `bundle.mjs`, `tool-stats.mjs`, `triage.mjs`, `surface-reach.mjs`, `run-health.mjs` and `judge.mjs`; `ab.mjs` and `report.mjs` through triage, and for rows older than the telemetry fields; `ab.mjs` and `run.mjs` through `run-health.mjs`; `token-ledger.mjs`, and `ab.mjs` and `report.mjs` through it, for an Agent SDK row's per-request usage |
| `tool-calls/` | each attempt's tap log | `judge.mjs` and `run-health.mjs`, `ab.mjs` and `run.mjs` through it, and `report.mjs`'s foreign-browser check of rows older than `foreign_browser` |
| `states/` | the server state each row was graded on | `regrade.mjs`, `triage.mjs`, `surface-reach.mjs`, `run-health.mjs`, `judge.mjs`, and `report.mjs`'s GUESSED check and its foreign-browser check of rows older than `foreign_browser`; `ab.mjs`, `report.mjs`, `compare.mjs` and `history.mjs` for the shell assistance of rows older than `shell_assisted` |
| `rollouts/` | each codex attempt's session rollout | `report.mjs`, `ab.mjs`, `compare.mjs`, `triage.mjs`, `history.mjs` and `judge.mjs`, for a codex row's `code_mode` and turns; `tool-stats.mjs` and `surface-reach.mjs`, for its `code_mode` alone; `run-health.mjs`, for the totals it holds report.md to and for whether a row's turns could be its rollout's requests; `token-ledger.mjs`, and `ab.mjs` and `report.mjs` through it, for its per-request usage |

**Free: two labels on one build.** The scripted backend answers each task with its
golden-path driver, so this run costs nothing and takes under a minute. Its usage is a
stand-in, so the ratios it reports measure no build; the run proves that a run's files
read end to end, and it is the one recipe that needs no API key.

```sh
node eval/run.mjs --backend scripted --suite web --task checkout-stop,cart-math,qty-limit,kanban-triage \
  --devtools-build a=dep --devtools-build b=dep \
  --conditions firefox-devtools-mcp@a,firefox-devtools-mcp@b --seed free-1 --interleave --repeat 2
node eval/ab.mjs eval/results/<run> --ab firefox-devtools-mcp@a,firefox-devtools-mcp@b
node eval/scripts/tool-stats.mjs eval/results/<run>
node eval/scripts/triage.mjs eval/results/<run>
```

`ab.mjs` prints the report (`--out <file>` writes it) and reads 1.000 [no CI under 6
tasks] here: the stand-in usage ties for two labels of one build on these four tasks,
where an agent's A/A does not, and four tasks are too few for an interval ("Budget").
`triage.mjs` prints `no failed rows`.

**Paid: firefox-devtools-mcp against playwright-mcp.** The default conditions are
firefox-devtools-mcp, resolved in the order in `eval/running.md`, and playwright-mcp, so the run names
neither. The web suite's 188 rows cost about $12 on codex luna: in the codex A/A sweep
(`run-2026-09-21T20-45-38-866Z`) its 94 tasks cost $7.13 on firefox-devtools-mcp 0.10.3
and $4.97 on playwright-mcp. The codex sweep's 188 web rows, 0.9.15 against
playwright-mcp (`run-2026-09-20T17-48-17-298Z`), cost $9.91.

```sh
node eval/run.mjs --suite web --backend codex --model codex=gpt-5.6-luna --effort medium \
  --seed ab-1 --interleave --parallel --parallel-tasks 2
node eval/ab.mjs eval/results/<run> --ab firefox-devtools-mcp,playwright-mcp
```

The two arms are different tools, so the run holds no A/A pair: read the minimum
detectable effect the report prints. The tool names give each arm away, so a judge run
over this pair is unblinded. The two arms also run two Firefox builds, which the report
flags as `ENV-MISMATCH`; add `--devtools-firefox playwright` to the run to put both on
Playwright's build, and that line goes away. `LAUNCH-PREFS` stays either way, since the
two launchers set different prefs on any build (`eval/running.md`, "What a paid run pins").

**Paid: build against build, with an A/A copy.** Three labels run in one seeded,
interleaved run: `new`, the dependency, and `old` and `aa`, two labels of the baseline's
`<root>` (a built checkout, or any directory holding `dist/index.js`). Step 4 of
"Measuring a tool change" runs the same layout as `cand`, `base` and `aa`, with the
dependency as the baseline. The A/A copy belongs to the baseline, since `--control`
takes the baseline's copy and the same baseline as `--ab`'s B. `ab.mjs` checks the
labels, not the builds, so a copy of A's build passes as the control, and its band
and the token ledger's A2-B column measure the effect again. With 0.9.15 as `<root>`,
the codex output ratio includes the catalog cut that "Codex drives the browser from
scripts" describes, since the 0.10.3 arm sees only part of its catalog.

```sh
node eval/run.mjs --suite web --backend codex --model codex=gpt-5.6-luna --effort medium \
  --devtools-build new=dep --devtools-build old=<root> --devtools-build aa=<root> \
  --conditions firefox-devtools-mcp@new,firefox-devtools-mcp@old,firefox-devtools-mcp@aa \
  --task <area tasks>,checkout-stop,cart-math,qty-limit,kanban-triage \
  --repeat 3 --seed build-1 --interleave --parallel --parallel-tasks 2
node eval/run.mjs --report-from eval/results/<run> \
  --ab firefox-devtools-mcp@new,firefox-devtools-mcp@old \
  --control firefox-devtools-mcp@aa,firefox-devtools-mcp@old
node eval/scripts/token-ledger.mjs eval/results/<run> --ab firefox-devtools-mcp@new,firefox-devtools-mcp@old \
  --control firefox-devtools-mcp@aa,firefox-devtools-mcp@old --check
node eval/scripts/judge.mjs eval/results/<run> --mode pairs \
  --ab firefox-devtools-mcp@aa,firefox-devtools-mcp@old \
  --out eval/results/<run>/diagnoses-aa.json --paid --budget 2
node eval/scripts/judge.mjs eval/results/<run> --mode pairs \
  --ab firefox-devtools-mcp@new,firefox-devtools-mcp@old --paid --budget 5
```

`--report-from` writes `ab--firefox-devtools-mcp@new--firefox-devtools-mcp@old.md`
beside `report.md`, and "Measuring a tool change" below gives its ship rule. It also
prints the judge's standing questions the run can answer (`--ask gap` and `tokens` for
the `--ab` arms, `failures`, and `blinding` for two builds), one paid call each, which
explain the report's gap from the rows' files ("The transcript judge"). The judge
reads the A/A pairs first, where every `surface` driver is noise, into a file of their
own, then the build pairs into `diagnoses.json`. Pair mode judges the pairs with a
failure or a 1.5x output gap, and `--all` adds the rest. Both arms of each pair are
builds of one tool, so the judge relabels them X and Y ("The transcript judge").
`--budget` starts no item once the calls so far cost that many dollars; a pair costs
$0.08 to $0.10. Each paid command has a free preview: `--list-tasks` for either run,
and `--dry-run` in place of `--paid` for the judge, which prints the prompts and runs
the sandbox check.

### Where the tokens go

`scripts/token-ledger.mjs` splits each row's input into what it paid for, and the A/B
report and report.md print its section, "Where the tokens go". A row's total input is
the sum of every model request's input, and each request carries again what the
requests before it read, so a 1,000-token reply that arrives after the 3rd of 12
requests costs 9,000 input tokens. The ledger reads each request's own usage, from a
codex rollout's `token_count` events and an Agent SDK transcript's per-message usage
and `message_delta` events, and splits the sum four ways:

| part | what it holds | source |
|---|---|---|
| prefix x requests | the first request's input, which every later request carries: the system prompt, the tool definitions, the server's instructions, the task prompt | measured; the definitions and instructions inside it are estimated from `meta`'s characters, and codex code mode sends neither in it |
| replies, by tool | each reply's tokens times the requests that carried it; a codex script's output splits among its MCP calls by their reply characters, and a script that read `ALL_TOOLS` counts as `(catalog)` | measured from the growth between two requests, less the agent's own output, when it lies within 0.5x to 2x the reply's character estimate plus 50 tokens a reply of framing; estimated otherwise |
| the agent's own earlier output | its output, read again by every later request | measured; codex re-reads a request's reasoning, and the Claude CLI does not |
| other growth | what the backend dropped or added besides | measured remainder |

Output splits into reasoning, measured, and text and tool-call arguments, a measured
total split by characters. Input splits into uncached tokens, cache writes and cache
reads, each measured and priced from genai-prices. Every figure names its source: M
measured, E estimated (3.5 characters a token on codex, 2.7 on the Claude CLI), M/E a
measured total split by an estimate. A reply measured whole also gives its characters
a token, which ran 3.1 to 3.4 for codex's snapshots and 2.6 to 2.7 for Haiku's in the
2026-09-21 sweeps. A codex cut is counted in codex's own unit, UTF-8 bytes over 4, and
the part it removed is converted to model tokens at the rate of the text it kept, an
estimate. A transcript `message_delta` with no assistant message before it is a request
of its own, one that wrote nothing visible. A row with no rollout, or whose transcript
keeps no `message_delta` (the 2026-08 runs), stays out of the ledger rather than being
estimated from the tap's reply sizes: without each request's own input, nothing would
tie that estimate to the row's usage.

Six checks run on every arm:

- each row's per-request records add up to its recorded usage exactly;
- the parts add up to the records, which the telescoping sum makes true unless the
  code that splits it is wrong;
- other growth stays within 5% of the arm's total input;
- the growth measured at least 90% of the replies' estimated tokens;
- replies of 1,000 characters or more that the growth measured whole ran 0.75x to
  1.33x the estimate's characters a token (these two catch replies read onto the wrong
  request, which the in-band rule would otherwise absorb);
- the priced cost classes, with the Claude CLI's side requests, lie within 1% of the
  recorded cost. A codex row's `cost_usd` is priced from the same table, so on codex
  this checks only the split into classes.

A check with nothing to check is printed as skipped, with the reason: no price for the
model, a row with no recorded cost, no long reply measured whole. `--check` exits 1
when a check fails or an arm has no row the ledger can read. report.md and the A/B
report put a failed check in their validity block as TOKENS-CHECK, and a row whose
first request went out before its MCP server connected, so that request carried none of
the server's tools, as LATE-SERVER. `rule-checks.mjs` runs the ledger on synthetic
rollouts and transcripts in the free gate, the rendered A/B section included. Every arm
with rollouts or transcripts in the runs since 2026-09-20 passes every check it can
run. Other growth stays at 0.02% or less on codex and 0.1% to 0.7% on Haiku, and the
growth measured at least 99.1% of the replies' estimated tokens. The long replies it
measured whole ran 3.3 to 4.1 characters a token on codex and 2.5 to 2.9 on Haiku.

In the A/B report each A-B difference carries a 95% bootstrap interval over tasks, its
percentiles expanded for the task count as the primary's are, and under 6 tasks it has
none. With `--control`, B's A/A copy's difference from B, A2-B, stands beside it with
its own interval, starred where A-B lies inside that interval: that part of A-B is no
larger than a copy of B's difference from B. A part's share of A-B is given only when
the total input difference's interval excludes 0 and the total lies outside the copy's
interval; otherwise the section says why. It also names the three tasks that move the
total most, since a few long tasks carry a mean.

The stored sweeps say where the input went:

- **0.10.3 against 0.9.15 on codex is catalog and prefix.** In the A/A sweep
  (`run-2026-09-21T20-45-38-866Z`, `--ab @old,@new --control @aa,@new`), `@new` read
  113,288 more input tokens a row than `@old` (95% interval +88,145 to +141,838). Its
  `@aa` copy read 2,349 more than `@new`, with an interval of −26,997 to +32,541 that
  the build difference lies far outside. Catalog prints carry 77.8% of the difference:
  2.56 a row against 1.04, each carried by every later request. The prefix of the 2.67
  extra requests carries 22.1%, at an unchanged 9,383 tokens a request. The snapshot
  and script differences are not the build's. 0.9.15's snapshot replies cost 5,248
  more a row, with an interval that holds 0. Its script replies cost 3,742 more, with
  an interval of +18 to +7,630 whose lower bound falls either side of 0 from one
  bootstrap seed to the next, and that difference lies inside the copy's interval
  (−1,773 to +5,392). 0.10.3 reads pages with `get_page_text` too (+5.5%), so its
  snapshots and page text together cost 43,379 input tokens a row against 0.9.15's
  42,354 in snapshots. Codex cut one catalog print a row on 0.10.3, 27,708 tokens whole
  by its count, of which it removed 17,708, about 16,100 model tokens. Against its
  instructions-off copy (`run-2026-09-21T22-50-33-204Z`), 0.10.3 read 103,274 more a
  row (+29,582 to +168,045): 73.8% catalog and 21.8% prefix.
- **On Haiku only the prefix and the reply sizes hold.** In
  `run-2026-09-21T21-33-39-412Z`, 0.10.3's first request is 3,212 tokens larger than
  playwright-mcp's (3,210 for the `@aa` copy), its tool definitions and server
  instructions, which costs 61,329 input tokens a row over its requests (55,576 for the
  copy). Its snapshot reply is smaller, 1,325 tokens a call (1,340 for the copy) against
  `browser_snapshot`'s 2,121, and it takes more, 5.88 and 5.53 a row against 3.92. The
  total does not hold: `@new` read 133,687 more input tokens a row than playwright-mcp,
  `@aa` 43,419, and `@new` 90,268 more than `@aa`, the same build. Each interval holds
  0, two tasks (hovercard-oncall and room-booking) carry 90% of the `@new`-`@aa`
  difference, and the section gives no share.
- **The Claude CLI adds what no token column shows.** Each Haiku row's side requests
  take about 650 input and 17 output tokens, which `cost_usd` holds and the token
  columns do not ($0.0007 a row). The step after a request that thinks grows a median
  161 to 166 tokens less than that request's visible output and replies, whatever the
  thinking's length, which is most of a Haiku arm's negative other growth. Every such
  request in the 2026-09-21 sweep was a row's first, and in the 2026-09-20 sweep the two
  that were not fell short as much, so thinking looks like the cause, but what the next
  request drops is unexplained. And one playwright-mcp row (checkout-stop) sent its
  first request before its server connected, so that request carried no MCP tool.

## Measuring a tool change

A firefox-devtools-mcp developer uses the eval to learn whether a build changed what
agents spend and whether it broke anything. Each step below is cheaper than the next,
so a change that fails a free step never reaches a paid one.

0. **Once: take a clean baseline.** Run a seeded web sweep with an A/A pair, two
   conditions of the same build, so the noise between identical arms is measured
   rather than assumed. For 0.10.3 the A/A sweeps measured it, on codex
   (`run-2026-09-21T20-45-38-866Z`) and on Haiku (`run-2026-09-21T21-33-39-412Z`),
   and "Budget" gives their σ; take a new baseline when the build, the backend or the
   model changes. The 2026-09-20 sweeps (`run-2026-09-20T17-48-17-298Z`,
   `run-2026-09-20T18-32-34-183Z`) ran 0.9.15 against playwright-mcp with no A/A pair,
   and every codex run before `CODEX_HOME` isolation (b9ff01d) is contaminated.

   ```sh
   node eval/run.mjs --suite web --backend codex --model codex=gpt-5.6-luna --effort medium \
     --devtools-build base=dep --devtools-build aa=dep \
     --conditions firefox-devtools-mcp@base,firefox-devtools-mcp@aa,playwright-mcp \
     --seed baseline-1 --interleave --parallel --parallel-tasks 2
   ```
1. **Build the candidate** in a firefox-devtools-mcp checkout, `$FDM` below.
2. **Run the free gate twice:** `FIREFOX_DEVTOOLS_MCP=$FDM node eval/verify.mjs`. A red
   task means the build broke a tool. No driver asserts a tool limit any more, so a
   build that lifts one stays green and shows up in step 3 instead. Twice, because one
   run can flake.
3. **Run the free bench.** `node eval/spikes/probes.mjs --build base=dep --build cand=$FDM`
   prints `HOLDS` or `CHANGED` per documented tool limit, and the spikes
   (`eval/spikes/README.md`) print `same` or `CHANGED` per behaviour; the probe or spike
   covering the changed behaviour must print `CHANGED`. The snapshot census
   (`node eval/scripts/snapshot-census.mjs --build base=dep --build cand=$FDM`)
   measures how much of each page's text reaches a snapshot, and must move within
   its size budget. The probes, the spikes and the census read `EVAL_DEVTOOLS_FIREFOX`,
   as the gate does, and the probes and the census say when a `--compare` baseline ran
   another Firefox. A latency claim needs three gate repeats per build: navigate_page
   p50 has swung from 100 to 36 ms between two builds that differed only in the
   snapshot formatter.
4. **Run a targeted paid A/B.** Pick the area suite the change targets plus the guard
   rails, and run the baseline, the candidate and, until the A/A noise is known, the
   baseline's copy as conditions of one seeded, interleaved run:

   ```sh
   node eval/run.mjs --suite web --backend codex --model codex=gpt-5.6-luna --effort medium \
     --devtools-build base=dep --devtools-build aa=dep --devtools-build cand=$FDM \
     --conditions firefox-devtools-mcp@base,firefox-devtools-mcp@aa,firefox-devtools-mcp@cand \
     --task <area tasks>,checkout-stop,cart-math,qty-limit,kanban-triage \
     --repeat 3 --seed cand-1 --interleave --parallel --parallel-tasks 2
   node eval/run.mjs --report-from eval/results/<run> \
     --ab firefox-devtools-mcp@cand,firefox-devtools-mcp@base \
     --control firefox-devtools-mcp@aa,firefox-devtools-mcp@base
   ```

   Every ratio in the A/B report is A/B, so put the candidate first and read under 1 as
   cheaper.
5. **Take the verdict from the A/B report.** Ship only when all of these hold:
   - the primary output-token CI lies below 1, and its estimate lies below the A/A band;
   - the mechanism the change targets moved (for the text cap: script calls per row);
   - no new failure that triage attributes to the tool;
   - no guard rail rises above the per-task A/A band, and at least one was paired;
   - total input is up no more than 20%, and the within-run cost is acceptable.

   The report ticks the mechanical checks; the mechanism and the cost still need a
   reader. Its "Where the tokens go" section shows which part of the input moved, so a
   change that shrank snapshots reads apart from one that cut requests.
6. **Before a release,** run the full web sweep of baseline against candidate at two
   repeats (376 rows, about $28 on codex luna). At the codex A/A noise floor its CI
   detects about a 5% suite-wide change, and the ship rule's two statistical checks
   about a 6% one ("Budget").
7. **File it:** `node eval/scripts/history.mjs add eval/results/<run>`.

**Budget.** The paired tasks a change needs follow from σ, the SD of the per-task log
output ratio between the two arms: n is the fewest tasks whose minimum detectable
effect, (t₀.₉₇₅ + t₀.₈₀)·σ/√n at n − 1 degrees of freedom, reaches |ln r| (80% power at
a two-sided 0.05 level). For large n that is ((1.96 + 0.84)·σ / |ln r|)², and the t
quantiles add two or three tasks to it. The A/A sweeps measured σ between two labels of
firefox-devtools-mcp 0.10.3 at one repeat per task, and their spend over their 204 A/A
rows gives a paired task's cost per arm:

| backend | σ, A/A | cost per paired task, per arm | from |
|---|---|---|---|
| codex, gpt-5.6-luna, effort medium | 0.252 | $0.075 | `run-2026-09-21T20-45-38-866Z`, `@aa` against `@new`, 102 tasks |
| anthropic, claude-haiku-4-5 | 0.422 | $0.101 | `run-2026-09-21T21-33-39-412Z`, `@aa` against `@new`, 102 tasks |

| output change to detect | codex tasks | codex cost, two arms | Haiku tasks | Haiku cost, two arms |
|---|---|---|---|---|
| −30% | 7 | about $1.1 | 14 | about $2.8 |
| −20% | 13 | about $2.0 | 31 | about $6.3 |
| −10% | 47 | about $7.1 | 128 | about $26 |
| −5% | 192 | about $29 | 533 | about $108 |

The A/B report prints the same plan from its A/A control's σ, or from its own pair's
when it has no control. `node eval/scripts/stats-checks.mjs` checks the interval, the
sign test, the MDE and the report's wiring of them against exact values and seeded
simulations of the two sweeps' A/A noise (`scripts/stats-aa.json`), and checks the
band against normal noise; the gate runs those checks. Run by hand, it then prints the
simulated rates, the kurtosis and the band's misses quoted below, and
`--repeats <run-dir>` prints the repeat SDs.

- **These are floors.** σ above is the noise between identical arms. A change that
  moves tasks unevenly adds its own spread: in the codex A/A sweep's run, the A/B
  report's SD line reads 0.293 for 0.9.15 against 0.10.3, and 0.389 for 0.10.3 against
  playwright-mcp.
- **Repeats are assumed to count at the noise floor.** No stored run repeats 0.10.3,
  so the evidence is indirect. In the acceptance runs, 8 tasks at three repeats on
  firefox-devtools-mcp 0.9.15 and playwright-mcp, a task's repeats in one arm have an
  SD in log output of 0.177 (firefox-devtools-mcp) and 0.167 (playwright-mcp) on codex
  (`run-2026-09-20T22-45-29-568Z`), and 0.243 and 0.291 on Haiku
  (`run-2026-09-20T22-52-41-101Z`), each over 16 degrees of freedom and so good to
  about ±35%. That is consistent with the 0.10.3 A/A σ/√2, 0.178 on codex and 0.298
  on Haiku. If it holds, r repeats give a task σ/√r, and 12 tasks at three repeats
  detect about what 36 tasks at one do (−12.1% against −11.4% on codex); the t
  quantile still counts tasks.
- **Under 6 tasks there is no interval.** The report's interval resamples tasks, each
  task the mean of its repeats, and expands its percentiles for the task count. It
  covers 1 in 94-95% of simulated A/A runs at 36 and 102 tasks and at 12 tasks of three
  repeats, and in 92-94% at 6 to 12 tasks of one repeat, where the heavy tails below
  still show; the 8-task acceptance runs and most breakdown rows sit there. Its ends
  never leave the tasks' range, which holds the truth at most 50%, 75%, 88% and 94% of
  the time over 2 to 5 tasks, so the report prints the estimate alone there.
- **The MDE is a normal-noise figure.** At the MDE the report prints, the CI excludes 1
  in about 80% of simulated runs on codex at every design, and on Haiku at 36 tasks and
  more or at three repeats. On Haiku at 6 to 12 tasks of one repeat it excludes 1 in
  only 75-77%.
- **The ship rule needs more than the MDE.** The ship rule's two statistical checks,
  the CI below 1 and the estimate below the A/A CI, hold together in only 64-71% of
  simulated runs at the MDE. At 12 tasks and more they reach about 80% at 1.12 times
  the MDE's distance in log (x0.924 where the MDE reads x0.932 on 102 codex tasks, x0.866
  where it reads x0.879 on 12 codex tasks at three repeats), and with no effect they
  hold in about 1% of runs or fewer.
- **The per-task band assumes normal noise.** The band is the t range that holds 95%
  of one task's A/A log ratio at normal noise. The stored A/A ratios have heavier tails
  (kurtosis 4.4 on codex, 5.7 on Haiku, where normal noise gives 3): the band leaves
  out 6 of the 102 codex A/A tasks and 10 of the 102 Haiku ones, where normal noise
  would leave out 5. A guard rail just above the band is weaker evidence than its place
  suggests, most of all on Haiku.
- **Target the tasks the change affects.** A change that moves a quarter of the tasks
  is diluted fourfold in a full sweep; a 12-task area suite at three repeats measures
  it where a full sweep at one repeat cannot. The A/B report prints the minimum
  detectable effect for the run it read, and the tasks needed from its σ.
- **Pass rate is a guard, not an endpoint.** In the A/A sweeps 3 of 102 pairs disagree
  on pass on each backend, so a 5-point pass-rate change needs about 260 paired tasks
  before the exact McNemar test sees it 80% of the time, more than the suite holds.
  The report's McNemar counts tasks, not repeats: a task's repeats share its
  difficulty, so a task counts for the arm that passed more of them.

**First experiment: the snapshot text cap.** Raise `MAX_ATTR_LENGTH` from 30 to 200
and the walker's text cap from 100 to 2000.
The free census should move from about 18% of rendered characters to at least 45%,
with snapshot characters up no more than 20%, the gate should stay green, and the
probes should print `CHANGED` for the text, name, href and walker text caps. The paid
A/B is 12 of the 38 tasks `tasks/areas.json` tags `snapshot-text`, and the 4 guard
rails, at three repeats in three arms: 144 rows, about $11 on codex luna. At the codex
A/A noise floor its 12 target tasks detect about a 12% change, and the ship rule's two
statistical checks hold 80% of the time near a 13% one. It ships if the
candidate/baseline output CI lies below 1 and its estimate below the A/A band, script
calls per row fall by half, mfa-login passes 3 of 3,
`surface.truncated` reaches 0, input tokens rise no more than 20%, and no guard rail
rises above the band.

## Failure triage

`eval/scripts/triage.mjs` names one class per failed row, first match wins, and never
changes a grade. `extraction` fires when a field is null although the answer holds its
value: the extractor's raw pair shows the quote gate nulled it, a passing arm's value
appears in the answer, the answer holds a code the server minted (from the state file)
or a value the validator's detail names, or the answer labels a value for the field
(`Title: ...` for `postTitle`). A label for a nested field has to name every key
below the top level, in the label or the heading above it: `perStore.Gadgetron.price`
needs `Gadgetron` beside `Price:`, where price-compare's lone `**Price:** $274.50` was
the winner's. A value the prompt carries is no evidence, since any
answer can repeat the ask; the prompt's URLs are left out of that test, and the value
must stand there as a whole token. When the task and the attempt's state are at hand,
triage re-runs the validator with the value written into the field, as `regrade.mjs`
does, and names `extraction` only if the row then passes. When the validator cannot be
re-run to the stored verdict, the rule stays silent if another `<name>Ok=false` check
in the detail, about none of the null fields, fails the row on its own. `paraphrase`
fires when the extractor reworded a value of three words or more that its quote gives
verbatim, and fewer than half of the value's words are in the quote, because
validators grade values. `surface-reach`, a tool class, fires only when a graded or
truth value reached the agent truncated, or when a claimed value is a cut a reply
showed, ending in its `...` (news-extract's and modal-escape's titles); a value the
agent shortened itself, from a reply that showed it whole, is not. `transcription`, an
agent class, fires next, on a claimed code one slip from a truth that a text reply
showed or that an image reply could have shown: one character dropped, added or
changed, or only characters a screenshot confuses (0 and O, 8 and B, 1 and I). A
truth under six characters or without both a letter and a digit is not tested, and a
row the validator still fails with the truth in the claim's place is not a slip.
resend-receipt's `CR-2026-26B0` against a listing that showed `CR-2026-26B0E`, and
hovercard-oncall's `PG-881956` read off a screenshot of `PG-8B1956`, both fire. A
truth value that no tool reply carried at all is listed as the contributing signal
`minted-absent`, because an agent that never opened the page leaves the same trace
as a surface that omitted the value, and one no text reply carried on a row whose
replies held an image is listed as `image-only`, with the peer comparison read as
text alone.
`surface-absent`, the other tool class, fires instead for a task that names its truth,
when the other surface under the same backend passed and received its own attempt's
truth, no arm passed on this surface (a shell-assisted pass counts for neither), and no reply of this row carried any of its
truth. For the generic minted codes that comparison is listed as contributing, beside
`minted-absent`. `harness-truncated` fires last, on a codex row whose outputs codex
cut before the model read them (`code_mode.truncated_outputs`), because a value a
reply carried may then never have reached the model.

`shell-assisted` fires before the answer is read at all, on a row whose agent's shell
got answers from a graded fixture route (`scripts/row-evidence.mjs`): its evidence is
not the surface's. `tool-errors`, the third tool class, fires on a surface error that
no later call made good, or one that carried the attempt's truth. A later success
makes an error good when it came from the same tool, from a tool of the same kind (a
fill, a pointer action, a key, a navigation to the same url, a dialog), or from a
script whose code does that job (a `.fill(` or `.value =`, a `.click(`, a
`keyboard.` call, a `.goto(` or `location =`, a dialog's `.accept(`), and a failed
script from any later script; a read-only tool's error is good after two later
successes. Only the attempt's truth marks an error as being about the graded value: a
value the answer claimed can be the agent's own mistake, and formula-repair's
`carried "e14"` was the cell its agent wrongly rewrote. Triage re-reads a row's
transcript with these rules rather than trusting the blame the row recorded.

An attempt's truth is the set of values its task names, when the task entry declares
`truth: { kind: 'minted', values: (state) => [...] }`, and otherwise the codes the
server minted into session state. A code in capitals is kept (LB-B151A0, VLT-FNYE, and
also a static SKU such as VAM-PRO in a cart, which its page renders). A lowercase code
is kept when its body is six or more hex characters (dpl-1c579d, and dpl-953568, a
draw that came out all digits) or holds a digit among five or more letters and digits.
A slug or enum in session state, such as `same-origin`, `on-file` or `rr-104`, is
neither. Only a task can name a truth that is not code-shaped: `mid-flight-rate` names
the rate it mints into one response body. Reach decodes the JSON string escapes of a
script's result, so a multi-line value that an `evaluate_script` or `browser_evaluate`
call returned reads as seen. It also reads playwright-mcp's YAML with a doubled quote
undone (`'Don''t'`) and HTML entities decoded, and matches a value of 12 characters or
more with punctuation and whitespace folded, so an answer that joins two page lines
with a comma (search-decoy's address) reads as seen. A value absent from every reply's
text while a reply carried an image reads as `image-only`, ahead of `derived` or
`paraphrased`, since a screenshot may have shown it (flaky-retry's total, room-booking's
PCR-076981). Reach reads the attempt's state wherever it has one: `run.mjs` passes it
when it records the row, and `surface-reach.mjs` and triage read it from a stored row's
state file. A value whose page the state names needs an image reply at or after a
load of that page: the object that holds the value also holds a string that the
ledger shows in a request path, as a pdf-bill bill's token is in its PDF's URL, so a
bill the agent never opened reads as `absent`. A value whose page the state does not
name, and every value on a row read without its state, needs only an image reply
somewhere in the row. playwright-mcp's
`### Ran Playwright code` section is not read at all: it echoes the agent's own
input, and pdf-bill's `fill('GW-B-A034C4')` read as the bill number reaching the
agent. A GUESSED pass in report.md needs the cut value to be what passed the row:
report.mjs re-runs the validator with the value cut back to the opening the surface
showed, and a row that still passes, such as embargo-wait, graded on the headline's
company names, is not guessed. `surface.absent` leaves out an answer value the agent
composed: reach reads a number it computed as `derived`, and prose of four words or
more as `paraphrased`. `node eval/surface-reach.mjs <run-dir>` re-reads a run with
these rules, and tallies the answers' values apart from the attempts' truth.

Friction also counts what the MCP stream hides. `sleeps` counts wait-tool calls, shell
`sleep`, and each delay of 500 ms or more inside a script call's function
(`setTimeout(r, 22000)`, `waitForTimeout(1200)`), which `script_sleeps` also counts on
its own; a row without `script_sleeps` predates that, and `report.mjs` re-reads its
sleeps from the transcript. A codex row's `code_mode` folds into the counters as
readers count them: `exec_sleeps` counts the delays in an exec cell's source, the ones
in an `evaluate_script` function it passes included, so it replaces `script_sleeps` in
`sleeps` when it is the larger; `discovery_execs` joins `tool_search`; and
`truncated_outputs` becomes `harness_truncated`. `noops` sums the validator's own
counts of actions that replied success and did not land, the detail keys ending in
`NoOps`, `noops` or `misses`; a miss also counts values the agent got wrong, so the
count is an upper bound on no-ops. `stale_uid` leaves out
`malformed_uid`, the calls whose uid argument firefox-devtools-mcp cannot parse
(`uid=1_59`), which it answers with its stale text. A uid is read against the shape
the row's own successful snapshots print: 0.9.15's `1_59`, 0.10's `e59`, so `e59` sent
to 0.9.15 is malformed and to 0.10 is a uid. On 0.10 a uid lives until its node leaves
the page, so a stale reply there means the node went, not that a later snapshot was
taken, and the A/B report says so when its arms straddle 0.10.
On playwright-mcp `malformed_uid`
counts a ref pasted with its wrapper (`[ref=e27]`, `ref=e29`, a whole snapshot line),
which it reads as a selector and fails with a selector error, so there it takes
nothing from `stale_uid`. `scripted_writes` counts the script calls
(`evaluate_script`, `browser_evaluate`, the page functions inside
`browser_run_code`) that wrote the page themselves: they assign a control's value,
selected or checked state, or call `click()`, `submit()`, `requestSubmit()` or
`dispatchEvent()`. It grades nothing; it shows a pass that went around the surface's
action tools, as every devtools native-permit row did for its datetimes and its
multi-select. A codex exec cell reaches the page only through the calls it makes,
which its stream shows one by one, so those are what it reads. `page_text_reads` and
`page_text_chars` count firefox-devtools-mcp 0.10's `get_page_text`, which returns
`document.body.innerText` (20,000 characters by default), the read a 0.9.15 agent made
through `evaluate_script`. It counts toward neither script calls nor snapshot figures,
so a build that adds it cannot look as if its agents stopped reading the page.
`act_then_snap` stays the snapshot-only rate the 2026-09-19 roadmap measured, and
`act_then_read` counts an action followed by any read of the page: a snapshot, a page
text read, or a script call that writes nothing, so the 0.9.15 innerText script and
0.10's `get_page_text` count alike. `tool-stats.mjs` also counts the page text reads
that returned a value a snapshot cut. Surface reach reads a value `get_page_text` cut at
its `maxLength`, which it marks with a `[+N chars hidden; ...]` footer rather than an
ellipsis, as `truncated`. `restarts` counts `restart_firefox` calls and every
`close_firefox_session` that a later, non-close call on the surface followed.
`snapshot.chars` counts the snapshot
files an agent read back through the Read tool or its shell (`snapshot.file_reads`,
`file_chars`), since playwright-mcp's action replies link a snapshot file rather than
print it; `output_file_reads` counts the other files a surface wrote that the agent
read back. `foreign_tools` counts calls to another MCP server only, and a call naming a
tool the row's own server lacks is `unknown_tools`; a row without `malformed_uid`,
written by an older recorder, counted both as foreign, so readers count
`foreign_servers` (`identity.mjs` `foreignCallsOf`). An Agent SDK row records `api_retries` and `api_retry_s`, the SDK's
own retries of a failed API request and the waits they added to wall time. The report
prints `harness_truncated`, `noops` and `scripted_writes` per row, and
`scripted_writes` per task in the medians table; the A/B mechanism table prints every one of these per condition, with
`n/a` for harness cuts when no row carries `code_mode`.
