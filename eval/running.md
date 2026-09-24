# Running the eval

## Paid runs

`run.mjs` spends real money — roughly $40 for the full sweep across both surfaces.

```sh
npm run smoke                                      # 3 basic tasks x 2 backends x 2 surfaces
node eval/run.mjs --list-tasks --suite web         # free
node eval/run.mjs --suite web --parallel --parallel-tasks 2
node eval/run.mjs --suite web --task pr-review --repeat 3  # per-task median, flags >2x variance
node eval/scripts/transcript.mjs <run-dir>         # what the agents actually did
node eval/scripts/bundle.mjs <run-dir>             # portable results zip, answer key excluded
```

Every script below reads a finished run and spends nothing, except the judge and its
validation, which call a model only when given `--paid`:

```sh
node eval/scripts/run-health.mjs <run-dir>         # whether the run's files agree with each other; read first
node eval/ab.mjs <run-dir> --ab <A>,<B> [--control <A2>,<B>]   # paired A/B report (also run.mjs --report-from --ab)
node eval/scripts/triage.mjs <run-dir>             # why each failed row failed, by deterministic rule
node eval/scripts/tool-stats.mjs <run-dir>         # per-tool calls, errors, sizes, cuts, script fallbacks
node eval/scripts/token-ledger.mjs <run-dir> [--ab <A>,<B> [--control <A2>,<B>]]  # where each arm's tokens go; --check exits 1 on a failed check
node eval/scripts/regrade.mjs <run-dir>            # re-grade from kept server state with today's validators
node eval/scripts/compare.mjs <runA>:<c> <runB>:<c>  # one condition across two runs, or a refusal
node eval/scripts/history.mjs add <run-dir>        # file the run in results/index.jsonl
node eval/scripts/judge.mjs <run-dir> --dry-run    # the transcript judge's prompts; --paid calls it
node eval/scripts/judge-validate.mjs --score <dir> # the judge's agreement with the reference labels
```

`eval/analysis.md`, "From a run to an A/B report", lists the files each reader needs
and gives three recipes, one of them free.

**A run checks its own files.** `scripts/run-health.mjs` prints PASS, WARN or FAIL per
check with its evidence, or N/A where the run gives a check nothing to test, and exits
1 on a FAIL. A FAIL is files that disagree; a WARN is a confound the numbers carry or a
field the run predates ("not recorded"), which leaves that check partial. A printout
shows the first few items of a long list; `--all` prints them all, and `--json <out>`
writes them all either way.

| check | holds |
|---|---|
| `rows` | a row for every selected task, repeat and condition, and none outside them; `results.json` holds every row `rows.jsonl` wrote; every transcript's attempt belongs to a row |
| `files` | each row's transcript, tap log, state file and codex rollout are on disk |
| `totals` | `results.json`'s totals are what `totalsByCondition` sums from its rows |
| `report` | report.md's totals table is what report.mjs computes from the rows now; `--report-from` renders a stale one again |
| `costs` | a codex row's cost is `backends/pricing.mjs` over its tokens and `turns` requests; an Agent SDK row's is the SDK's per-model sum, and its token columns are exactly the SDK's usage for the agent's model |
| `tap` | the tap log and the transcript show the same surface calls, tool by tool, and the row the tap's count |
| `draws` | in a seeded run the conditions of each task and repeat faced the same first pick per scope, from `row.draws` or the state file, which agree; a task repeat that cannot be compared is named |
| `env` | each condition's preflight reading is its pin, and conditions of one tool read alike; a Firefox release that differs because `--devtools-firefox` pinned one label is a WARN |
| `builds` | each condition ran one Firefox build, the preflight's, and one server version, tools/list and instructions, meta's, as every row's tap log shows |
| `identity` | tools/list and instruction hashes, build hashes, task hashes, the eval commit, SDKs and extractor are recorded |
| `validity` | every invalid, shell-assisted and foreign-browser row carries its reason, every row a rule marks is marked, and the marks recompute from the state files |
| `codex` | every codex row records `tool_mode` and `code_mode`, its turns are its rollout's requests, and no row the numbers count has a `codex_isolation` problem |
| `quote-gate` | the quote gate re-applied to `extraction_raw`, with the ask from the row's prompt, gives the graded fields |

A figure that today's code computes differently from the run's (the quote gate, the
foreign-browser rule, shell assistance, report.md's table, a codex row's cost or turns)
is a WARN when that code changed since the run's eval commit, the run's dirty tree may
have edited it, or the run recorded no commit, and a FAIL otherwise. A codex cost is
also a WARN when the run priced it with another version of the price table, which
`meta.priceTable` now records, or, before per-request pricing, when it is its tokens
priced as one request. report.md's header sums the checks up in one line (without
`report`, which reads report.md), the A/B report's validity block does too for the
whole run, and `run.mjs` prints the line when a run ends and after `--report-from`.

A row's tool build is what its tap log shows: the server version and the hashes of its
tools/list and instructions. A dist rebuilt mid-run under the same version with the
same tools and instructions looks the same, so `builds` cannot catch it;
`meta.builds` hashes each build once, when the run starts.

Over the stored runs of 2026-09-20 and 2026-09-21 the checks find four things. Every
Agent SDK row's cost pays for the Claude CLI's own Haiku call, about $0.075 per 102 rows
and alike across arms, whose tokens no token column holds; rows now record the SDK's
per-model split as `model_usage`. The report.md turns of the codex sweep and of
`run-2026-09-20T17-34-49-491Z` predate the rollout turns (1299 and 1068 in the sweep,
against 1195 and 1019 now), a WARN since report.mjs has changed, which `--report-from`
clears. Today's quote gate keeps two values the Haiku sweep's nulled (popup-storm,
feed-needle). And one firefox-devtools-mcp 0.9.15 server exited
with code 1 before its first call (`run-2026-09-21T20-45-38-866Z`, `@old` pr-review),
so the row is invalid as `no-surface-calls` although its agent made 7 calls. A row now
records such a death, or a server that never started, as `server_exit`, which report.md
prints as SERVER DIED and triage names beside `no-surface-calls`. `mcp-tap.mjs`
`serverExit` reads it from the tap log's exit record; any exit after the stop signal
the tap logs is a shutdown, the SIGKILL the tap sends a server still running 1.5s later
included.

`--backend scripted` runs `run.mjs` without an agent and costs nothing. Each attempt's
answer comes from the task's golden-path driver, which drives the condition's own server
through the tap and hands its fields straight to the validator, so no extractor runs
(the row records `extraction.extractor: 'backend'`). Under `EVAL_EXTRACTOR=scripted`,
`--model extracted`, `misquoted` and `extractor-down` answer with text alone, graded
through a free stub extractor instead of the paid one: `extracted` has to pass,
`misquoted` has to fail the quote gate, and `extractor-down` has to fail with the row
flagged `extraction_failed`. `run.mjs` refuses a text-only scripted model without
`EVAL_EXTRACTOR=scripted`, and the stub extractor next to an agent backend. The backend streams every call as
Agent SDK messages, so `transcript.mjs`, `tool-stats.mjs`, triage and the A/B report
read its rows like an agent's. Its usage is a stand-in: no input tokens, cost 0, and
output tokens a quarter of the answer's characters. Two labels on one build tie on that
figure when the task's answer has a fixed length under a seed, and can differ by a token
when the task mints its values with randomBytes (mirror-reroute, silent-throw).
`--model wrong-fields` drives the same path but answers with the driver's first
`wrongFields`, so every row it produces has to fail. The backend runs only tasks with a
driver, which leaves out the default basic suite, and only `firefox-devtools-mcp`
conditions, which leaves out the default `playwright-mcp` one, so a run names both:
`node eval/run.mjs --backend scripted --conditions firefox-devtools-mcp --suite web`.
A top-up runs what the run it tops up recorded. `--rerun-failed` alone takes that run's
backend, models, effort, conditions and their `--devtools-build` roots, the Firefox each
firefox-devtools-mcp condition launched, `--mcp-command`, `--mode` pins, seed, serving,
`--no-tap`, `--max-wall` and `--max-output`, and `run.mjs` refuses a flag, or an
`EVAL_DEVTOOLS_FIREFOX`, that names another. It also refuses a `FIREFOX_DEVTOOLS_MCP` that names
another checkout than that run's. So a scripted run is never topped up on a paid agent,
and an A/B whose build roots no longer resolve is not topped up at all.
`run.mjs` also refuses `scripted` next to an agent backend, and it refuses any argument
it does not know, so a typo such as `--backend=scripted` cannot fall through to the paid
default. CI runs a five-task sweep through the backend whenever the gate passes: two
labels on one build under `--interleave`, then `--report-from --ab`, `tool-stats.mjs`,
`--rerun-failed`, a `wrong-fields` control, and the three stub-extractor models, so the
extractor path paid rows take runs too (`.github/workflows/gate.yml`). It checks
each row's streamed snapshots against the tap, its surface reach, and that a driver's
goto lands on the owning origin. A two-task sweep with one label on Playwright's Firefox
(`--devtools-firefox b=playwright`) checks that the pin reaches the server and the rows,
that pdf-bill passes there, and that both reports name the build difference. CI also
runs four gate tasks under `EVAL_DEVTOOLS_FIREFOX=playwright`, and checks that the gate
refuses a stand-in binary whose browser reports another Firefox.

**`run.mjs` hands an agent a shell.** Each attempt gets a fresh temporary directory and
an allowlisted environment (`agent-env.mjs`) that still carries the backend's own API
credentials. Stored runs opened fixture pages in the operator's desktop Firefox
through `/opt/homebrew/bin/firefox`, so both backends put a stub directory first on the
shell's `PATH`, where `firefox`, `playwright`, `playwright-cli`, `open`, `osascript` and
their kin print "not available" and fail. The stubs cover a `PATH` lookup only: an
absolute path (`/usr/bin/open`), a login shell (`zsh -l`, whose profile rebuilds
`PATH`) or `env -i` reaches the real command, and whether either sandbox then stops a
launch, or a hand-off of the URL to a Firefox already running, is untested. The MCP
servers keep the real `PATH`. On the Anthropic backend the agent runs with permission
prompts disabled and a pinned tool set (the browser MCP server, `Bash`, and file tools
that write only in the attempt directory; no web, subagent or scheduling tools), and
`Bash` runs under the Claude CLI's sandbox: writes only in the attempt directory and a
private `TMPDIR`, no network, loopback fixtures included, and no way to ask for a
command to run outside it (on Linux the sandbox needs `bwrap` and `socat`, and the
preflight stops a run without them). The browser and the MCP servers run outside both
backends' sandboxes, so no task needs the shell on the network. A stored Haiku sweep
showed why it gets none: its firefox-devtools-mcp agents copied the browser's `sid`
cookie out of a network dump and `curl`ed cookie-only fixture routes, which alone held
the fact that decided body-only-ref and hovercard-oncall. Each attempt also gets its own
`CLAUDE_CONFIG_DIR`, so spilled tool results, background task output and memory stay
out of your `~/.claude` and `/tmp/claude-<uid>`; your login stays where it is. MCP
tools load eagerly (`ENABLE_TOOL_SEARCH=false`), and the rows count any ToolSearch
calls and `<persisted-output>` spills. The codex backend runs its shell under a
permissions profile with the same limits: writes in the attempt directory and a private
`TMPDIR`, and no network (`network.enabled=false`). It gets its own `CODEX_HOME`
holding only the login and that profile, so none of your codex config, plugins or
skills reach it; its subagent tools are off (`agents.enabled=false`), and so are its
own browser, computer use, image generation and ChatGPT apps. The preflight checks
codex's effective features and runs the profile under `codex sandbox`, where a
loopback server it starts must see no request from the shell. A row whose rollout
shows other permissions, a network other than `restricted` or another subagent
version is marked invalid (`codex-isolation`). Each attempt's session rollout is kept
as `rollouts/<transcript>`.

Neither shell, nor the Anthropic Read tool, can read your home directory, a checkout of
this repository, where `eval/answers.mjs` and `sites/` hold the graded truth, or your
`~/.claude` and `~/.codex`, whose transcripts can quote them. The Haiku sweep's shells
ran `find ~ -name "*.db"`, which listed `~/.codex`'s sqlite files. Inside the home the
shells may read again what they need to run (`agent-env.mjs` `unreadablePaths`): this
checkout's `node_modules`, where the agent CLIs live, and each directory on the shell's
`PATH` that lies in the home, with the `lib` beside it when it is a `bin`, so
`~/miniconda3/bin/python3` finds its standard library. Nothing that holds or lies in a
checkout or an agent home is re-opened, so a `PATH` entry under `~/.claude` stays shut.
The rest of the home answers the shell with a permission error, which a tool reading its
dotfiles there may not survive: git stops at a `~/.gitconfig` it may not read, so both
shells get `GIT_CONFIG_GLOBAL=/dev/null` (`agent-env.mjs` `SHELL_ENV`).

Every attempt's directories lie in one temp root, `/tmp/jobs-<uid>`
(`/private/tmp/jobs-<uid>` on macOS; `agent-env.mjs` `tempRootPath`), which both
sandboxes deny. The temp root holds the attempt directory and the shell's private
`TMPDIR`, the attempt's `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, the MCP server's `HOME`, and
a `TMPDIR` of the MCP server's own, where its browser keeps a profile and a socket.
Inside the temp root each sandbox re-opens the attempt's own directories alone: the
attempt directory and the shell's `TMPDIR`, and read-only the server output directories
(below) and the files the agent CLI writes for its shell. For the Claude CLI those are
`CLAUDE_CONFIG_DIR`'s `shell-snapshots` and `projects/` (spilled tool results); for
codex, `CODEX_HOME/shell_snapshots`, which its permissions profile lists, with the
server output directories, as explicit read-only entries. No shell reads the MCP
server's `TMPDIR`, and none reads a concurrent attempt's directories, whether that
attempt runs under `--parallel`, `--interleave` or another `run.mjs`. The stub
directory and the temp root both lie in `/tmp`, so both preflights stop a run whose
`/tmp` lies in a denied path. That covers the shells alone: the browser and the MCP
servers run unsandboxed, so a `file://` page or an upload tool still reaches the
repository, and a copy of the graded truth outside your home and every checkout stays
readable. Codex's `view_image` reads any file, not only an image, in codex's own
process, and 0.145.0 cannot turn it off, so a codex row whose `view_image` names a
denied path, or a path in the temp root outside the attempt's own directories, is
marked invalid too. Both backends print the denied and re-opened paths into the agent's
prompt, so run from checkouts whose paths say nothing about the run, and compare input
tokens only between runs that deny and re-open the same paths; the re-opened ones
follow the shell's `PATH`. Inside either sandbox a bare `mktemp` fails on macOS, while
`mktemp -p "$TMPDIR"` works. Each run's `meta` records both tool policies.

`firefox-devtools-mcp` runs with a `HOME` of the attempt's own, so its
`~/.firefox-devtools-mcp` save root starts empty every attempt and never lands in your
home. The save root lies outside the attempt directory: `saveTo:true` writes into its
`output/`, an absolute `saveTo` lands anywhere inside the save root on 0.9.15 and only
inside `output/` on 0.10.3, and the reply names the file. The Anthropic Read tool reads
outside the attempt directory only by a rule, and the Haiku sweep had none: it denied
13 Reads under `output/` in 12 firefox-devtools-mcp rows, five of them screenshots,
which a shell's `cat` cannot show the agent, and a 14th of a file the agent's own shell
had saved in its `TMPDIR`. So `run.mjs` hands each backend the save root as
`serverOutputDirs`, and the Anthropic agent gets a Read rule for it and for its
`TMPDIR`, under both spellings of a `/private` path, and no Edit rule. Both shells read
the save root as one of the server output directories they re-open read-only in the
temp root. Neither agent can write there. playwright-mcp saves inside the attempt
directory. A `--mcp-command` server keeps your `HOME`, so a file it saves there, as a
firefox-devtools-mcp build's `saveTo:true` does, is unreadable to both agents.

**A browser the surface did not start makes a row invalid.** Every attempt's browser
sends the preflight's user agent plus a token of the attempt's own, and the server's
ledger records each request's user agent (`ua`, `../sites/README.md`). Where a
condition's tag verified in the preflight, the user-agent rule alone decides
(`scripts/foreign-browser.mjs`): a browser session, or a browser request without one,
whose requests name user agents and none of them the attempt's token is foreign, and
the row is marked invalid (`foreign-browser`). The rule reads the ledger alone, so it
needs no tap, and `--no-tap` leaves it on. Both built-in conditions tag their
browsers, and all 204 rows of each of the codex sweep (`run-2026-09-20T17-48-17-298Z`)
and the Haiku sweep (`run-2026-09-20T18-32-34-183Z`) were checked by user agent.
Playwright's Firefox leaves the override off `navigator.sendBeacon`, so an untagged
request inside a tagged session proves nothing, and a session whose only requests
were beacons would be named foreign.

A condition whose tag did not verify, or that has none (`--mcp-command`), falls back
to two rules that read the tap's log. Timing flags a session whose first request came
outside every surface call the tap saw, during a shell command or long after any
surface call. Count flags a second session that loaded a site top-level if it began
inside the same surface call as the session before it, or while that session was
still sending requests; a sign-out or a restart, which ends the first session, passes.
The two rules miss a session that begins inside a later surface call while the
session before it sends nothing more, and under `--no-tap` such a condition's rows go
unchecked, as `run.mjs` prints when it starts. `meta.isolation.foreignBrowser.rule`
records each condition's rule: `user agent`, `timing and session count`, or `off`.

firefox-devtools-mcp 0.10.3's `close_firefox_session` is a restart: the surface's
next call launches a browser from the same flags, the attempt's user-agent tag,
window size and download directory included, so its new session begins inside that
call, and the row counts the close among its `restarts` (a run of closes counts
once). A headless attempt, like the gate, relaunches into a fresh profile, and a
`--headed` one into its seeded `--profile-path` profile, which keeps what the first
browser stored on disk (`spikes/probes.mjs` `close-relaunch`). A close the agent ends on
launches nothing, and playwright-mcp's `browser_close` closes the page but keeps the
browser context and its cookies. Both fire the open page's `pagehide` handlers, as the
server's own shutdown does when its client closes it (`close-pagehide`), so a page that
saves on leave, as thornbury's draft form sends its unsaved fields, sees a leave either
way; a close sends it while the agent still works. 0.10.3's description asks the agent
to close the browser once the task is done, so each row counts `closes` and
`closed_at_end`, and the A/B report shows them once either arm closed.

**A pass the shell fetched is not the surface's.** Until 0577dd5 took both shells off
the network, a shell could reach the fixtures with a cookie the surface printed
(firefox-devtools-mcp's `list_network_requests` prints request headers whole) and fetch
a session route itself, as the Haiku sweep's did. Neither shell reaches loopback now,
and every row still records `shell_assisted`: the shell requests a graded route
answered (an `/api/` route or `/collect`, 2xx or 5xx, or, to a request that carried a
session, a page under a site's `documents()` hook, which writes that session's values
into the body), or null. A scripted row, whose drivers fetch with the browser's cookie
themselves, never is. report.md prints such a row as SHELL-ASSISTED and gives each
condition's pass count without it, and `ab.mjs` pairs without it and gives the figures
with it as a sensitivity. A reader takes the flag from a stored row's state file when
the row predates the field (`scripts/row-evidence.mjs`), and `regrade.mjs` takes it
from the state file for every row.

Run it only where you are willing to let an agent execute arbitrary shell commands. One fixture is
actively trying to talk that agent into exfiltrating data — that is the point of
`injection-bait` — and an agent that takes the bait will run whatever the page told it
to. `verify.mjs` runs no agent and is safe to run anywhere the browser is.

Both the gate and paid runs resolve `firefox-devtools-mcp` in this order, so
`FIREFOX_DEVTOOLS_MCP` makes every number measure your own build:

1. `--mcp-command "<cmd>"` (`run.mjs` only)
2. `FIREFOX_DEVTOOLS_MCP=/path/to/checkout` — a built checkout's repo root
3. the `@mozilla/firefox-devtools-mcp` dependency from `package.json`

A `firefox-devtools-mcp@<label>` condition skips that order: it runs the root, or the
dependency, that its `--devtools-build <label>=<root|dep>` names.

The Firefox that `firefox-devtools-mcp` launches resolves the same way, and every free
tool (the gate, the spikes, the probes and the snapshot census) takes it from the
variable:

1. `--devtools-firefox [<label>=]<path|playwright>` (`run.mjs` only): bare, every
   built-in `firefox-devtools-mcp` condition; with `<label>=`, that
   `--devtools-build` label's
2. `EVAL_DEVTOOLS_FIREFOX=<path|playwright>`
3. the installed Firefox, which the tool finds itself

`playwright` names the build playwright-mcp launches, the one its own `playwright-core`
resolves in the cache `playwright install` fills; a path names a `firefox` executable or
a macOS `.app`. The server gets it as `--firefox-path`. A `--mcp-command` server
launches as given.

The gate, the spikes, the snapshot census and paid runs all start the server with the
allowlisted environment of `agent-env.mjs` plus `NODE_ENV=production`
(`mcp-stdio.mjs` `DEVTOOLS_SERVER_ENV`). The allowlist keeps a `CONNECT_EXISTING` or
`TOOL_PRESET` in your shell from reconfiguring the build being measured, and
`NODE_ENV=production` keeps both builds from loading a `.env` file in the server's cwd,
which for the gate is yours, where the same variables, or 0.10.3's
`UNRESTRICTED_SAVE_PATHS`, would get past the allowlist. Attaching to a running Firefox
is the one mode in which firefox-devtools-mcp 0.10.3 drops a session idle for 30
minutes, and neither route can turn it on, so no pause in a run or the gate trips it.

### What a paid run pins

**Every site gets its own origin.** `run.mjs` serves each site on its own loopback
port with its directory at `/`, the shape the container serves, so no task prompt
names a `pages/` directory such as `/flaky/slow.html` or `/maze/`, and no page links to
one: `scripts/check-fixtures.mjs` fails a page that hard-codes its own directory.
`--single-origin` serves every site under its directory's path on one port instead, which is how every
run before 2026-09-19 was served, and `--vhosts` serves every site on one port under its
own host name, `http://<key>.localhost:<port>`. The modes are separate measurement
epochs: `meta.serving` records the mode, a run without it was single-origin, and
`--rerun-failed` keeps the mode of the run it tops up.

**Both conditions' browsers run in one environment.** Before any paid work the preflight
loads a loopback page in each condition's browser and records its Firefox version, user
agent, Accept-Language, locale, time zone, viewport, colour scheme and
`navigator.pdfViewerEnabled` into `meta.env`, with the binary, version and build ID its
files name. `report.md` and the A/B report flag anything that differs between
conditions or from its pin:

| setting | pinned to | firefox-devtools-mcp | playwright-mcp |
|---|---|---|---|
| Firefox build | one build for both only under `--devtools-firefox playwright` | the installed Firefox, or the binary `--devtools-firefox` names, as `--firefox-path` | Playwright's patched build |
| time zone | `UTC` | `TZ` in the agent's environment, which both backends pass to the MCP server | the same |
| locale | `en-US`, Accept-Language `en-US,en;q=0.9` | prefs `intl.accept_languages` and `javascript.use_us_english_locale` via `--pref` | the same prefs via `firefoxUserPrefs` in a `--config` file |
| viewport | `1366x683` | `--viewport 1366x768` on macOS, `1366x769` on Linux; the flag sizes the outer window and its chrome takes the rest | `--viewport-size 1366x683` |
| colour scheme | `light` | pref `layout.css.prefers-color-scheme.content-override=1` | `contextOptions.colorScheme` in the config file |
| PDF viewer | pdf.js on | pref `pdfjs.disabled=false` via `--pref`, already the release default; on Playwright's build, a policy (below) | the same pref via `firefoxUserPrefs`, which overrides the `playwright.cfg` that turns pdf.js off |

**The Firefox build is pinned only on request.** By default `firefox-devtools-mcp`
drives the installed Firefox (156.0 on 2026-09-21) and playwright-mcp its own patched
build (152.0.4), so a cross-tool comparison compares two browsers as well. The reports
say so: `ENVIRONMENT MISMATCH` in `report.md` and `ENV-MISMATCH` in the A/B report name
each arm's build, by version and build ID, since two builds can report one version, and
its user agent's version beside it. The preflight refuses a server whose browser's user
agent names another major release than the binary the harness told it to launch, since
every row would record the wrong build. playwright-mcp cannot drive a release Firefox,
because it needs the Juggler patches of Playwright's build. firefox-devtools-mcp drives
Playwright's build through the Marionette and WebDriver BiDi that build still ships. On
it, the gate passed 99 of 99 in all three serving modes, the 35 probes measured what
they measure on 156.0 (a relaunch took 1.7 s against 2.3 s), and the snapshot census
delivered the same 297,160 characters. So `--devtools-firefox playwright` runs both tools
on one binary, and the mismatch line goes away. The browser moved nothing measurable
for firefox-devtools-mcp 0.10.3: in a seeded, interleaved codex luna A/B of 26 tasks
across nine families
(`--devtools-build rel=dep --devtools-build pw=dep --devtools-firefox pw=playwright`,
`run-2026-09-22T03-26-49-824Z`, $3.39), the build on Playwright's 152.0.4 spent 0.974
[0.886, 1.052] of the output tokens it spent on the release 156.0, both arms passed 26
of 26, and no PDF downloaded in either. One sample per task detects only a change of
about 11%, so the run bounds the browser's effect rather than ruling it out.

One build still leaves the two launchers apart in two ways, and the harness closes the
first. Playwright's `playwright.cfg` is an autoconfig of 136 `pref()` calls, and
Firefox runs them after the profile's `user.js`, where geckodriver writes
firefox-devtools-mcp's `--pref` flags, so each cfg value holds over a pin. Playwright's
own launch sets `firefoxUserPrefs` again once the browser is up, which gets past them.
The cfg turns pdf.js off, and `--pref pdfjs.disabled=false` left it off. So where a
build's cfg overrides a pinned pref, the firefox-devtools-mcp server gets a Preferences
policy that sets it back, which the cfg reads through `PLAYWRIGHT_FIREFOX_POLICIES_JSON`
(`mcp-stdio.mjs` `devtoolsFirefoxLaunch`), and the build table reads `enabled by a
pinned policy over playwright.cfg`. A pref the cfg locks, or a cfg without that hook,
keeps its value, and the preflight names it. The second stays open: each launcher sets
prefs of its own. On one build, 54 prefs are set in firefox-devtools-mcp's browser that
Playwright's launch leaves at their defaults: geckodriver's own (`marionette.port` and
`remote.active-protocols` among them), those the Remote Agent it starts recommends
(`dom.successive_dialog_time_limit` 0, `dom.navigation.navigationRateLimit.count` 0,
`browser.tabs.remote.unloadDelayMs` 0 among them), and the policy's
`browser.policies.applied` (`spikes/launch-prefs.mjs` lists them). All but the policy's
reach the arm on the installed Firefox too, so they belong to the tool's launch, not the
browser, and both reports print them as `LAUNCH PREFS DIFFER` on every comparison of
firefox-devtools-mcp with playwright-mcp, whatever the builds.

Every row records the binary, version and build ID its condition launched, read at the
attempt, so a desktop Firefox that updates mid-run shows up as `BROWSER-CHANGED` in
`report.md` and the A/B report. `meta.devtoolsFirefox` records what each built-in
firefox-devtools-mcp condition was told to launch, and each `meta.builds` entry the
browser it drove. `compare.mjs` refuses two runs whose condition ran different Firefox
builds, or, where one recorded no build, different major releases, and `history.mjs`
files the browser beside the build, not in its key. An A/A control whose copy ran
another Firefox than B prints `CONTROL-ENV-MISMATCH` in the A/B report, since its band
then holds the browser's effect too. A blinded judge over two arms on two builds sees
neither build ("The transcript judge"). Before the pdf.js pin, a PDF downloaded in
Playwright's build and opened in pdf.js in the release Firefox. So pdf-bill's
playwright-mcp agent read the downloaded bills with a host `pdftotext` while the other
read the viewer, and gov-lookup's form PDFs downloaded in one arm only. A run whose
preflight predates the `navigator.pdfViewerEnabled` probe is read from each build's
files instead. A `--headed` run sizes each `firefox-devtools-mcp` window to its
grid cell, so its viewport is flagged too. `--mcp-command` servers launch as given, with
the time zone the only pin that reaches them, and keep your `HOME`, where their
agent cannot read what they save. `--rerun-failed` cannot restore the
environment of the run it tops up, so it records how its browsers differ as
`meta.rerunEnvDrift`. Nor can it restore the contents of that run's tool builds, its
agent SDK versions, its extractor, its wall tiers or its task definitions, and it records
how those differ as `meta.rerunBuildDrift`. `report.md` lists both. A run without
`meta.env` predates the pins, and every top-up of one says its rows ran unpinned.

**The run records the code it ran.** `meta.git` holds the eval commit and whether the
tree was dirty. A dirty tree adds `dirtyFiles`, each file's two-letter `git status` code
and path. It also adds `diffSha256`, a hash over the files under `eval/`, `sites/`,
`pages/`, `server.mjs`, `serve.mjs` and `manifest.mjs` that differ from that commit,
untracked ones included: each path and the sha256 of its bytes. Two runs of one commit
with one hash ran the same eval code, and `compare.mjs` compares them. The hash is null when only other files differ,
and such a run raises no `EVAL-DIRTY`; a run that does quotes the hash on that line.
`meta.surfaces` holds each server's version and entry sha256: firefox-devtools-mcp's
`dist/index.js`, and playwright-mcp's `cli.js` plus the two `playwright-core` bundles
that hold its tools. Its `tools` holds what the preflight's tools/list returned (count,
names, schema characters, hash) and `tools.instructions` the size and hash of the
instructions the server's initialize reply carried, null for none. firefox-devtools-mcp
0.9.15 sends none and 0.10.3 sends 1,697 characters, with 48 tools in 26,687 schema
characters against 44 in 21,920. The instructions reach the model as the tool
definitions do, and each backend delivers them its own way (`spikes/instructions.mjs`,
which runs both CLIs against a fake loopback API and pays nothing). The Claude CLI sends
them once, as a system message headed "# MCP Server Instructions" after the prompt, and
every later request carries that message with the rest of the conversation. Codex in
code mode leaves them out of the first request and opens each of the server's
`ALL_TOOLS` descriptions with them, so a script that prints the catalog prints them once
per tool. All 132 stored codex firefox-devtools-mcp rows ran such a script, printing the
firefox tools' descriptions. Printing every firefox tool's entry gives 22,409 characters,
whole, on 0.9.15 and 27,432 tokens on 0.10.3, which codex cuts to its 10,000-token output
budget, leaving 18 of the 48 entries. The preflight
prints all three sizes, report.md's build table and the A/B report's validity block show
them, and each tap log's `initialize` record carries the instructions' size and hash.

**Downloads stay in the attempt, and only the browser writes them.** Each attempt's
browser saves downloads into a directory inside the attempt's directory. That is
`downloads/` for `firefox-devtools-mcp`, through the `browser.download.*` prefs, and
`playwright-output/` for `playwright-mcp`, whose `--output-dir` takes its downloads beside
its own snapshot and log files, which its replies link to. The agent's shell and file
tools can read both directories and write neither: the anthropic sandbox lists them
under `denyWrite` and denies `Edit` there, and the codex permissions profile marks them
read-only under its workspace root. On macOS, `codex sandbox` under that profile refused
every write, rename and removal there, and so did a Seatbelt profile built the way the
Claude CLI builds its own. The CLI's sandbox itself, its Write tool, codex's
`apply_patch` and Linux's bubblewrap are untested. The agent's own files go elsewhere in
the attempt directory. Before, one directory took all three, and a playwright-mcp pdf-bill row
recorded five 28-byte 403 bodies that the agent's `curl -o` wrote as the browser's
downloads. The row records what the browser saved as `downloads: [{name, bytes,
sha256}]`, or `{name, bytes, error}` for a file it could not read. It leaves out what
the servers write there for themselves: playwright-mcp's timestamp-named snapshots and
logs, any file an agent's tool call named there or a firefox-devtools-mcp reply said it
saved there (a `saveTo` naming a directory gets a file of the server's naming), and the
`screencast-<uuid>.webm` that firefox-devtools-mcp's `screencast_stop` saves. Unpinned, `firefox-devtools-mcp` saved
chart-escape's CSV export and every screencast into the operator's `~/Downloads`. The
gate sends its downloads to each worker's temporary directory. One tool moves them out:
on 0.10.3, `set_download_behavior` `allowed` saves every later download into
`~/.firefox-devtools-mcp/output/downloads` under the server's `HOME` unless the call
names a folder (`downloadFolder`, inside the server's cwd, the attempt directory, or
anywhere under `output/`), where 0.9.15 left the browser's download directory in place.
The agent can read `output/` (it lies in `serverOutputDirs`) and cannot write it. The
row reads the folder each such call's reply names and names each file there by that
folder: `~/.firefox-devtools-mcp/output/downloads/<name>`, or the folder's path in the
attempt directory. A file the agent's shell wrote into a folder in the attempt directory
reads as a download there too.

**Codex drives the browser from scripts.** Codex ships gpt-5.6-* in code mode
(`tool_mode: code_mode_only` in its model catalog), and `backends/codex.mjs` pins that
mode on every catalog model. `EVAL_CODEX_TOOL_MODE=direct|code_mode|code_mode_only`
picks another for an experiment; `meta.isolation.toolPolicy.codex.toolMode` and each
row's `tool_mode` record which. In code mode the model has no MCP tool of its own: it
writes JavaScript for one `exec` tool, which calls the MCP tools and the shell, and it
sees only what the script prints. That changes what a codex number measures:

- The tool catalog reaches the model through `ALL_TOOLS`, which a script has to search
  and print, not as inline schemas. The first request carries no MCP schema, and each
  printed catalog rides along in every later request, so a larger catalog costs input
  there instead.
- One script can make several MCP calls in a single model request, so a codex turn is a
  model request, counted from the rollout, not a tool call.
- Codex cuts an exec's whole output past a token budget (10,000 unless the script's
  first-line `// @exec:` pragma sets `max_output_tokens`) and marks the cut `Warning:
  truncated output` before the model sees it. The tap records the full reply.
- On firefox-devtools-mcp 0.10.3 that budget hides most of the catalog. Codex opens
  every one of the server's `ALL_TOOLS` descriptions with the server's instructions, so
  a script that prints the firefox tools' entries prints 0.10.3's instructions once per
  tool, and codex cuts the print to 18 of the 48 entries ("The run records the code it
  ran" above gives the sizes, which `spikes/instructions.mjs` measures). 0.9.15 sends no
  instructions, and its 44 entries print whole, so a codex comparison of the two builds
  carries a catalog the 0.10.3 arm saw in part. The cut costs the agent: on the full
  suite, seeded, 0.10.3 spent 1.21x the output tokens and 1.29x the cost of the same
  build with its instructions removed, with 2.60 catalog searches a row against 1.03
  (`eval/results/run-2026-09-21T22-50-33-204Z`). It read 103,274 more input tokens a
  row (95% interval over tasks +29,582 to +168,045), 73.8% of them in catalog prints
  and 21.8% in the prefix of its extra requests ("Where the tokens go").
- An agent can sleep inside a script (`setTimeout`, `page.waitForTimeout`, a shell
  `sleep`), where neither a wait tool nor the tap's shell count records it.

Each codex row records these as `code_mode: {requests, execs, discovery_execs,
exec_sleeps, truncated_outputs}`, read from its rollout, and its `turns` are those
`requests` (rows from before `meta.isolation.toolPolicy.codex.turns` existed counted tool
calls plus one, and `report.mjs`, `ab.mjs`, `compare.mjs`, `triage.mjs`,
`history.mjs` and `judge.mjs` read such a row's `code_mode` from its `rollouts/` file,
and its turns too when the rollout's totals are the row's usage, as the backend checks,
`scripts/row-evidence.mjs` `withRolloutFacts`; `tool-stats.mjs` and `surface-reach.mjs`
read the `code_mode` alone). In
`direct` mode codex still defers the MCP tools behind its own tool search, because the catalog marks gpt-5.6-* `supports_search_tool`; an experiment with
inline schemas has to clear that in the catalog as well (the `tool_search` features are
removed in 0.145.0 and change nothing). The codex extractor keeps `code_mode_only`
whatever `EVAL_CODEX_TOOL_MODE` says.
