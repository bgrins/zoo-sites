# Browser tool limits

These are observations of `@mozilla/firefox-mcp` 0.11.0 (formerly
`@mozilla/firefox-devtools-mcp`), not limits of browsers or HTML. Comparisons
with 0.9.15, 0.10.3 and 0.10.7 are historical. Recheck them when
the tool changes, and use them to interpret results, not to design fixtures.
An agent may have other ways to read a page, such as page text or DOM scripting.

- **Snapshot text reaches roughly 27 characters.** Text is capped at 100 in
  the page, then at 30 on the way out, with three characters spent on the
  ellipsis. `href`, `src`, `value` and `name` take the same cap; an `href` is
  made absolute before it is cut.
- **The walker stops at depth 10** and bails past **1000 nodes**. Both set a
  `truncated` flag without saying where the tree was cut.
- **The walker descends into open shadow roots** from 0.11.0; through 0.10.7 it
  never did.
- **Same-origin frame content reaches the default snapshot** in 0.11.0, as in
  0.9.15, and the tools act on uids inside it; 0.10.3 to 0.10.7 showed it only
  under `includeAll`. Cross-origin frames are childless leaves in all four.
- **`find` searches only text returned by the snapshot.** It cannot find text
  truncated out of that snapshot.
- **Table cells need `includeAll`** to reach the snapshot; even then, the
  geometry needed to read a grid does not come through.
- **Empty elements contribute no snapshot node**, so a positional grid closes
  up around a blank cell.
- **Flattened snapshots lose button-to-card grouping.**
- **Native dialogs stay open until `accept_dialog` or `dismiss_dialog`** from
  0.11.0. The click that opened one replies `Dialog opened while tool was
  running: ...`, and other tools are refused while it is open. Firefox's resend
  prompt (`confirmEx`) is the exception: neither tool can answer it, and it
  swallows clicks until a navigation clears it. Through 0.10.7, `confirm()` and
  `prompt()` were dismissed at once and `alert()` did not block.
- **Clicks do not wait** (0.10.5 on): a click on a submit button returns before
  the response loads, a click on an element another element covers lands on the
  cover and reports success, and an element a scroll container clips but the
  window does not is missed.

See `eval/spikes/README.md` for the free probes and `eval/running.md` for how
tool builds are identified and compared.
