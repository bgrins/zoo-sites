# Capability spikes

A spike drives one browser capability through each condition's MCP server, outside
any task, and records what the page and the server saw. Agent runs cannot find a
broken tool, because an agent routes around it; a spike can ("Spikes find what runs
cannot" in `docs/process.md`). Each script here backs a claim in `docs/process.md` or
an entry in `docs/task-ideas.md`, and the entry names the script.

Spikes serve their own bare probe pages from an in-process loopback server. They
never touch `pages/`, never start `server.mjs`, and cost nothing. playwright-mcp's
snapshots and downloads go to a temporary directory that each run removes.

## Running one

```sh
node eval/spikes/controls.mjs
```

Every finding prints on one line, `same` or `CHANGED`, next to the value the script
last measured. The header line names the tool and Firefox versions the run used, and
the exit status is 1 when any finding changed. `lib.mjs` holds the shared plumbing:
each condition spawned the way `eval/run.mjs` spawns it, the probe server and its
input-event logger, and the finding log.

## After a version bump

When `@mozilla/firefox-devtools-mcp`, `@playwright/mcp` or either Firefox changes:

1. Run every spike:
   `for f in eval/spikes/*.mjs; do case $f in *lib.mjs|*gate-time.mjs) ;; *) node $f || echo "CHANGED: $f";; esac; done`
2. For each CHANGED line, decide whether the tool changed or the probe broke. Rerun
   it alone first, since a loaded machine can shift a timing-sensitive probe.
3. Update the measured value in the script and the versions in its header comment.
4. Fix every doc line that cites the old behaviour: grep `docs/` for the script's
   name, and reread the task entries that depend on it.

## The spikes

Measured on firefox-devtools-mcp 0.9.15 (system Firefox 156.0) and @playwright/mcp
0.0.78 (its bundled Firefox 152.0), macOS, 2026-09-19.

| Script | Measured | Backs |
|---|---|---|
| `tools.mjs` | devtools has 44 tools and no key-press tool; playwright has 24, `browser_press_key` among them. 27 devtools tools are called by no driver, `accept_dialog`, `hover_by_uid`, `list_downloads`, `navigate_history` and `set_download_behavior` among them; registrar-purge's driver calls `dismiss_dialog`, which on 0.9.15 finds nothing to dismiss. `node eval/spikes/tools.mjs <tool>` prints a tool's schema. | task-ideas.md next round |
| `keys.mjs` | devtools `fill_by_uid` types one trusted keydown per character, and passes a WebDriver key codepoint through as a key: U+E007 in a field submits its form, U+E004 moves focus, and U+E007 or U+E00D filled into a button activates it. playwright `browser_press_key` Tab moves focus, and Enter or Space activates the focused button. | process.md, T061 |
| `controls.mjs` | devtools `fill`: `type=date` takes an ISO value and silently stays empty for the locale's typed order (03/04/2027); `datetime-local` given ISO silently stores a wrong date (7030-02-02T04:15 for 2027-03-04T15:00), and only the locale's typed order (03/04/2027 03:00 PM) lands; `type=range` silently keeps its value; `select[multiple]` ends with one option selected, an unmatched value silently selects the first option, and an empty value selects all. playwright `browser_fill_form` takes ISO for date, time and datetime-local, a typed display order fails loudly with "Malformed value", and `browser_select_option` takes a list. | process.md, T137 |
| `pointer.mjs` | devtools `drag_by_uid_to_uid` sends only untrusted dragstart and drop, so a pointer-event sortable list stays unchanged while the tool reports success; HTML5 drop works on both. playwright `browser_drag` sends trusted pointer events past a 6px threshold. Hover opens a 250ms hover-intent menu on both, and a hovercard's text reaches the devtools snapshot cut to "On call until 18:40, pager ...". playwright right-click fires a trusted contextmenu, but a `popover=auto` menu opened from it is closed again when the click returns; Shift-click carries `shiftKey`. | T138, T139, T144 |
| `leave.mjs` | devtools `navigate_page` and `click_by_uid` leave a dirty form past its beforeunload guard with no signal. playwright `browser_navigate` does the same; `browser_click` raises a modal state and refuses other tools until `browser_handle_dialog`. | T133 |
| `post-history.mjs` | devtools has no reload tool. A reload through script leaves Firefox's resend prompt pending, and `accept_dialog` then re-POSTs; `navigate_history` back onto the POST entry returns a tool error; `navigate_page` to the receipt URL sends a GET. playwright shows the resend prompt as a modal state, accepting it re-POSTs, and `browser_navigate_back` onto the POST entry fails with NS_ERROR_DOCUMENT_NOT_CACHED. | T135 |
| `documents.mjs` | devtools: an attachment click's result says nothing about a download, and `list_downloads` names the file; with download prefs seeded into the profile the file lands in that directory. An inline PDF opens in pdf.js, the snapshot is truncated, and the text layer reads through script. A visually hidden file input under a styled label is absent from the snapshot even with `includeAll`, so `upload_file_by_uid` has nothing to target. playwright: the click result names the saved path; an inline PDF becomes a download and the tab stays put; clicking the label opens a file-chooser modal state that `browser_file_upload` answers, for paths under its cwd or `--output-dir`. | T136, T140, download dir |
| `frames.mjs` | devtools reads a same-origin frame, but renders a cross-origin frame as a childless leaf, and script sees `contentDocument` null. playwright descends into both, and types and clicks inside the cross-origin one. | T146 |
| `clipboard.mjs` | playwright copy and paste through `browser_press_key` delivers a trusted paste carrying the TSV. A synthetic ClipboardEvent through devtools `evaluate_script` arrives untrusted with empty clipboardData. | T147 |
| `contenteditable.mjs` | devtools `fill_by_uid` replaces the editor's content, one trusted `insertText` beforeinput per character. playwright `browser_type` replaces it with one `insertCompositionText`; with `slowly` it types per character at the caret and keeps the content. Shift+ArrowLeft through `browser_press_key` selects text. | T148 |
| `reused-row.mjs` | After an in-place re-render, both surfaces click the node's new occupant (build-4194, not the 4193 the snapshot named). playwright's result names the row it hit; devtools' does not. | T134 |
| `icons.mjs` | devtools' default snapshot omits empty icon-font elements, titled or not, and a select's options; `includeAll` shows `i "Archive"` and a bare `i`. playwright shows the titled icon as `generic "Archive"`, the stripped one as an unnamed generic, and lists the options. | T143 |
| `cache.mjs` | On both surfaces, navigating again to a `max-age=300` URL, or clicking a link to it, reuses the cached response without reaching the server; a reload through script reaches it; an ETag page navigated twice sends If-None-Match. | T142 |
| `env.mjs` | devtools: Firefox 156, 1366x683 viewport, the host's colour scheme. playwright: Firefox 152, 1280x720, light. Both en-US with the host time zone, Accept-Language `en-US,en;q=0.9`. Time zone and colour scheme compare against the host's own values (the scheme on macOS only), so another machine prints `same` for them. | env pins |
| `cors.mjs` | Both consoles name the CORS failure and the allowed origin; devtools' network list shows the OPTIONS preflight and playwright's does not; the server sees only the preflight. | T149 |
| `geolocation.mjs` | `getCurrentPosition` with an 8s timeout neither resolves nor errors within 9.5s on either surface. | T145 |
| `vhosts.mjs` | Both browsers reach `alpha.localhost` and `beta.localhost` on one 127.0.0.1 port, keep a cookie per host, and treat each as a secure context. | host-routed serving |
| `probes.mjs` | 32 probes of the limits the docs, the drivers and the devtools-mcp roadmap rely on, in about 18s per build: the 27-character text, name and href cut, the walker's 100-character text cap, depth 10 and 1000-node caps, the 100-line default window and 500-line cap, table cells, empty elements, inline text, shadow roots, labels, checkbox state and select options missing from the default snapshot, confirm and prompt auto-dismissed, HTML5 drop at 0,0 and the pointer-drag no-op, range fill missing, date fill landing, the ~500 px viewport clamp, `isXHR` matching nothing, no response bodies, the 5s default and 10s hard evaluate timeout, a repeated `data-testid` clicking the first card, stale uids, the uid-only click reply, and a console error without its stack. Each prints HOLDS or CHANGED against the documented behaviour. `--build [label=]<root\|dep>` repeats for a column per build, `--out` writes JSON, `--compare <json>` prints what moved. It replaces the limit assertions news-extract, fee-schedule, formula-repair and registrar-purge used to make. | authoring-fixtures.md tool limits, devtools-mcp roadmap |
| `gate-time.mjs` | The full gate: 101s at the default `--jobs` (4 on 14 cores) and 212s with `--jobs 1`, both starting at load averages of 7 to 10 from other gates on the machine; live-auction alone takes 70s. A later `--jobs 2` run took 128s at load 18 to 25. It prints timings rather than findings. | process.md |

The 2026-09-19 review reported that devtools `fill` selects every option of a
`select[multiple]`. `controls.mjs` reproduces that only for an empty value.
