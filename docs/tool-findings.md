# What the eval found about firefox-devtools-mcp 0.9.15

This file records the tool defects the eval has surfaced in `@mozilla/firefox-devtools-mcp`
0.9.15, the evidence behind each, and how a fixed build would show up in the eval. It
comes from the 2026-09-19 review, which read the stored transcripts, the tool's
`dist/` source and a set of free local probes. Line numbers refer to
`node_modules/@mozilla/firefox-devtools-mcp/dist/index.js` in 0.9.15.

## Read this first: the stored runs are contaminated

Every stored codex run predates the `CODEX_HOME` isolation fix (b9ff01d). Before it,
codex agents read the operator's `~/.codex`: its plugin skills and its own MCP
servers. In `run-2026-08-18T19-55-49-724Z`, the 172-row sweep most figures below come
from, 74 of 86 devtools rows and 70 of 86 playwright rows called another MCP server
(`node_repl` 140 and 129 times, a second firefox-devtools server 10 and 5 times), and 9
rows never called their own surface. No stored run records a seed, a build identity or
an eval commit.

So treat every figure here as a lead that names a defect, not as a measurement of its
size. A clean seeded baseline has to exist before any number is quoted; eval/README.md,
"Measuring a tool change", describes how to take one. The defects themselves stand on
firmer ground than the sizes, because each was also confirmed in the tool's source or
by a free probe.

Each finding carries tags for how it was confirmed: **[T]** in agent transcripts,
**[P]** by a free local probe or census, **[S]** from source only. The limits behind
the [P] findings are re-checked by `node eval/spikes/probes.mjs`: on 0.9.15 every one
of its 31 checks with a documented outcome prints HOLDS, so no finding below has
changed.

## The headline

- **The cost gap is real, and pass rate cannot see it.** On the 172-row sweep
  firefox-devtools-mcp spent 1.209x playwright-mcp's output tokens (geometric mean over
  86 tasks, 95% CI about [1.11, 1.32]), higher on 61 of 86 tasks (sign test
  p=0.0001). Pass rates were 79 and 74 of 86, and the 8-versus-3 discordant pairs give
  an exact McNemar p of 0.23. On the 78 pairs where both agents used their own surface
  the ratio is 1.222.
- **The mechanism is round trips and scripting, not snapshot size.** Devtools agents
  called `evaluate_script` 106 times in 44 rows, against 30 script calls in 13 rows for
  playwright. 346 of the 354 devtools snapshots cut something, so 95 of the 106 came
  after a cutting snapshot in the same row almost by default; the telling figures are
  that 37 came straight after one and 50 returned a cut value in full
  (`eval/scripts/tool-stats.mjs`).
- **Every stored failure has a deterministic explanation.** `eval/scripts/triage.mjs`
  classes all 19 failures of the sweep: 6 never called their surface, 4 are quote-gate
  nulls of a value the answer held, 8 failed alike in both arms, and 1 (mfa-login) is
  the surface cutting the graded value.

Reproduce them for free:

```sh
node eval/ab.mjs eval/results/run-2026-08-18T19-55-49-724Z --ab firefox-devtools-mcp,playwright-mcp
node eval/scripts/tool-stats.mjs eval/results/run-2026-08-18T19-55-49-724Z
node eval/scripts/triage.mjs eval/results/run-2026-08-18T19-55-49-724Z
```

## Findings, ranked

### 1. Snapshot text is cut at 27 characters [T][P]

- **Now:** the formatter cuts every name, text, href, src and value to 27 characters
  plus `...` (`MAX_ATTR_LENGTH = 30`, index.js:16609-16619), and the injected walker cuts
  text at 100 before that. Hrefs are made absolute first, so almost every link is cut.
- **Evidence:** 2,924 of 20,415 quoted text values and 3,779 of 3,937 hrefs in the
  sweep's 354 devtools snapshots were cut. mfa-login failed in both stored runs that
  include it: the snapshot said `text="Welcome back, Ops — vault t..."` and the agent
  answered "vault tethered" (the server's word was tundra), and in the other run "vault
  mo..." became "vault monitoring is nominal". 50 of the 106 scripts returned the full
  text of a value the preceding snapshot had cut. The free census (the review's
  coverage-size probe over 74 task entry pages) put 0.9.15 at 18.6% of rendered
  characters delivered verbatim, and a build with both caps raised at 45.3% for 19.1%
  more snapshot characters. `eval/scripts/snapshot-census.mjs` now covers 82 entry
  pages and puts 0.9.15 at 17.7%.
- **Proposed change:** raise the text cap to 200 or more, or make it a `take_snapshot`
  parameter; mark a cut as `…(+N)`; emit hrefs relative to the origin and uncut; raise
  the walker cap to 2000.
- **How the eval would show it:** on the snapshot-text area suite, `evaluate_script`
  calls per row fall by half or more, output tokens fall 10-25%, `surface.truncated`
  reaches 0 and mfa-login passes. Watch input tokens (snapshots grow about 20%) and the
  dense-page guard rails in eval/ab.mjs. No driver asserts the cut any more: the
  `text-cap`, `name-cap`, `href-cap` and `walker-text-cap` probes in
  `eval/spikes/probes.mjs` hold on 0.9.15 and print CHANGED on a fixed build, and the
  gate stays green.

### 2. Native dialogs are dismissed before the agent sees them [T][P]

- **Now:** no prompt behaviour is set, so WebDriver dismisses `confirm()` and
  `prompt()` at once; `accept_dialog` then fails with an empty message
  (index.js:16387-16399). `unhandledPromptBehavior` and `setAlertBehavior` appear
  nowhere in index.js.
- **Evidence:** registrar-purge took 31 turns against 9 and 2,907 output tokens against
  1,016; its 26 surface calls against playwright's 5 include `accept_dialog` failing 2 of
  2 times with `Error: Failed to accept dialog: `. A one-line prototype
  (`setAlertBehavior('ignore')`) makes `accept_dialog` work.
- **Proposed change:** set `unhandledPromptBehavior: 'ignore'`, subscribe to
  `userPromptOpened`, report the dialog in the reply of the action that opened it, and
  say "no dialog open" when none is.
- **How the eval would show it:** registrar-purge turns fall to about 9 and output by
  half or more. Three tasks raise a dialog: registrar-purge a `confirm()`,
  resend-receipt Firefox's resend prompt, and unsaved-leave a beforeunload prompt. None
  raises `alert()` or `prompt()`, so add those fixtures before an A/B. The
  `confirm-auto-dismiss`, `alert-auto-dismiss` and `prompt-auto-dismiss` probes in
  `eval/spikes/probes.mjs` measure today's dismissal, and registrar-purge's driver
  holds either way.

### 3. A crashed browser does not come back [T][S]

- **Now:** `restart_firefox` forgets the auto-detected binary and relaunches headed
  (`headless ?? false`, index.js:19741-19754); the next call relaunches silently to
  about:blank (index.js:17543-17549), with snapshot ids back at 1.
- **Evidence:** the sweep's devtools rows returned 10 browser-lost replies and 5
  relaunches or restarts; playwright's returned none. `restart_firefox` failed 1 of 2
  times. The 13 tasks whose devtools row had any failed surface call cost 1.61x
  playwright's output, against 1.15x for the other 73. room-booking took 66 turns
  against 16 after losing its Firefox.
- **Confound:** devtools drove the system Firefox 156 while playwright drives its own
  build, the sweep ran two tasks at a time, and the operator's own devtools server was
  running. Re-measure on a clean baseline before crediting the tool.
- **Proposed change:** reuse the original launch options on restart, and put "Firefox
  restarted, page state lost, was <url>" at the top of the next reply.
- **How the eval would show it:** browser-lost replies and restarts per row
  (`friction.restarts` on a new row), the repeat spread on room-booking, and a free
  kill-and-recover probe.

### 4. Fill reports success while setting the wrong value [T][P]

- **Now:** `fill_by_uid` clears and then types, with no read-back
  (index.js:16197-16209). Range inputs land on their midpoint. There is no
  `select_option` and no `press_key`.
- **Evidence:** `fill_form_by_uid` answered "filled 3 fields" on scene-calibrate and
  set the sliders to 50, 4600 and 15 instead of 57, 5700 and 13; the task took 15 turns
  against 9 and 2,033 output tokens against 958.
- **Proposed change:** fill by input type (the native setter, then input and change
  events), read the value back and fail on a mismatch, and add `select_option` and
  `press_key`.
- **How the eval would show it:** scene-calibrate, form-gauntlet, plan-picker,
  palette-checkout and office-finder; scripts that set values should fall to about 0.

### 5. The relevance filter drops inline and tabular text [P][T]

- **Now:** the injected walker keeps only a node's own text and drops `strong`, `b`,
  `code`, `td`, `dd`, `label`, `option` and `summary`, so `<strong>$274.50</strong>`
  renders as "Your total is  today", with no ellipsis to show the loss.
- **Evidence:** agents pass `includeAll` on most snapshots; on the census the full tree
  raises word recall from 0.54 to 0.62 for 14% more characters; the gate's telemetry
  (`verify.mjs --telemetry`) finds 99 of the 212 graded values its 99 drivers produce in
  no snapshot a driver takes.
- **Proposed change:** fold inline descendants' text into the parent, and always emit
  table cells, dd/dt, label, summary and option.
- **How the eval would show it:** fewer script rows on fee-schedule, ledger-sum,
  crm-join, roster-diff, oos-substitute, iframe-schedule and formula-repair. The
  `table-cells`, `inline-text` and `select-options` probes in `eval/spikes/probes.mjs`
  measure today's loss; the fee-schedule and formula-repair drivers no longer assert it.

### 6. Checked, disabled and selected state never reaches the snapshot [T][P]

- **Now:** state is read from `aria-*` only and printed only under `includeAttributes`
  (index.js:16539-16590); a checked and an unchecked checkbox are byte-identical.
- **Proposed change:** print checked, disabled, selected and `type=` by default.
- **How the eval would show it:** the state-reading scripts on consent-reject,
  unsub-dark-patterns, faceted-search and variant-matrix fall to 0.

### 7. `isXHR` never matches, and requests carry no bodies [T][P]

- **Now:** index.js:15571 tests CDP initiator names, which BiDi never sends; all three
  stored `list_network_requests {isXHR: true}` calls returned nothing, and a probe found
  0 of 2. `get_network_request` returns headers only.
- **Proposed change:** derive `isXHR` from the BiDi fields or the resource type, and
  capture response bodies up to a size cap.
- **How the eval would show it:** rename-rollback (2.43x output), registrar-purge, and
  the devtools suite, which has no stored agent runs yet.

### 8. Scripts die at 10 seconds, and there is no wait [T][P]

- **Now:** `sendBiDiCommand` rejects at a hard 10,000 ms whatever timeout is asked for
  (index.js:15324-15328), a timeout can take the browser down, and there is no
  `wait_for`.
- **Evidence:** live-auction took 58 turns against 12 and 2.35M total input tokens
  against 0.45M, for only 1.18x the output.
- **Proposed change:** pass the timeout through, abort the realm rather than the
  browser, and add `wait_for`.
- **How the eval would show it:** total input tokens, not output, on live-auction,
  embargo-wait, timeout-vs-slow and status-flash.

### 9. A uid resolves to the first CSS match, not to its element [P]

- **Now:** resolution re-queries a CSS path and takes the first match
  (index.js:16699-16751), so the third card's button clicks the first card and the reply
  still says `click <uid>`; uids inside iframes and shadow roots fail as "stale/invalid".
- **Evidence:** probes only; a prototype in-page element map passes the seat-picker and
  shadow-unlock drivers. The sweep's devtools rows saw 5 stale-uid replies.
- **Proposed change:** keep an in-page element map or use BiDi `sharedId`, with CSS as
  the fallback.
- **How the eval would show it:** no fixture repeats a `data-testid` yet, so one has to
  be added before the wrong-target rate can be measured; until then the
  `uid-repeated-selector` probe in `eval/spikes/probes.mjs` is the only measure. T134
  shipped as `reused-row`, but its misfire is an in-place re-render, which both
  surfaces click through (`eval/spikes/reused-row.mjs`), not a repeated selector.

### 10. Snapshots are cut by line count without saying where [T]

- **Now:** 100 lines by default, a 500-line cap, no offset, and a bare `[DOM truncated]`.
- **Evidence:** 61 of the sweep's 354 devtools snapshots were line-cut, 7 were
  DOM-truncated, and pr-review took 37 turns against 22.
- **Proposed change:** offset paging, a character budget, and a note naming the cut
  subtree.

### 11. Action replies carry no page state [T, mixed]

- **Now:** a click replies `click <uid>`, about 10 characters (index.js:18250), after
  one animation frame plus 50 ms (index.js:16289-16292), so it returns before a scripted
  navigation lands.
- **Evidence, and why it ranks low:** devtools agents took a snapshot after 218 of 250
  clicks, but playwright agents, whose click reply already carries the URL, title and
  modal state, did so after 151 of 189. After any action the rate is 71.4% in both
  (310 of 434 and 264 of 370). The gain is task-specific (faceted-search 2.78x).
- **How the eval would show it:** `friction.act_then_snap` per action falls below 0.5
  in the changed build; without that, the change saves nothing.

### 12. Small fixes

- `set_viewport_size` resizes the window: 320 and 480 both give a 500 px viewport,
  reported as done [P].
- `saveTo` refuses absolute paths under the server's own cwd or the temp dir (5 errors
  in the sweep) [T].
- Error messages drop their cause: stale uid, `accept_dialog` and `saveTo` [T].
- A web `--tools` preset: the harness's `--enable-script` loads 44 tools and 21,920
  schema characters (`toolsListInfo` in `eval/mcp-tap.mjs`), and 19 rarely used tools
  were called 4 times in 86 rows [S].
- Docs to fix in the tool: date fill works in Firefox 156 with ISO dates, and
  `evaluate_script`'s 5 s is a default capped at 10 s.

## What the eval cannot say yet

- **Nothing clean.** Re-baseline on a seeded, isolated run before quoting a size.
- **Nothing about latency from codex runs.** Codex events carry no timestamps; only
  the MCP tap on new rows, or Agent SDK transcripts, time a call.
- **No per-task ranking from one sample.** room-booking scores 5.52x in the sweep and
  1.09x as a median over three runs; read per-task figures with `--repeat 3`.
