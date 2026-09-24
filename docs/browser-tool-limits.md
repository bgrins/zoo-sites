# Browser tool limits

These are observations of `@mozilla/firefox-devtools-mcp` 0.10.3, not limits
of browsers or HTML. The 0.9.15 comparison is historical. Recheck them when
the tool changes, and use them to interpret results, not to design fixtures.
An agent may have other ways to read a page, such as page text or DOM scripting.

- **Snapshot text reaches roughly 27 characters.** Text is capped at 100 in
  the page, then at 30 on the way out, with three characters spent on the
  ellipsis. `href`, `src`, `value` and `name` take the same cap; an `href` is
  made absolute before it is cut.
- **The walker stops at depth 10** and bails past **1000 nodes**. Both set a
  `truncated` flag without saying where the tree was cut.
- **The walker does not descend into shadow roots.**
- **Same-origin frame content needs `includeAll`** in 0.10.3; 0.9.15 walked it
  by default. Cross-origin frames are childless leaves in both.
- **`find` searches only text returned by the snapshot.** It cannot find text
  truncated out of that snapshot.
- **Table cells need `includeAll`** to reach the snapshot; even then, the
  geometry needed to read a grid does not come through.
- **Empty elements contribute no snapshot node**, so a positional grid closes
  up around a blank cell.
- **Flattened snapshots lose button-to-card grouping.**
- **Native `window.confirm()` is auto-dismissed instantly.**

See `eval/spikes/README.md` for the free probes and `eval/running.md` for how
tool builds are identified and compared.
