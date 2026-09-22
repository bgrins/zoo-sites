// Per-tool telemetry recovered from stored transcripts: calls, errors, output
// characters and latency per tool, snapshot sizes and cuts, script fallbacks,
// and the friction counters run.mjs records on new rows. A run whose rows carry
// `tools`, `snapshot` and `friction` from the MCP tap does not need this; every
// run before the tap does, and so does any run whose tap numbers are in doubt.
//
//   node eval/scripts/tool-stats.mjs <run-dir> [--condition <c>] [--json <out>]
//
// Codex events carry no timestamps, so p50_ms is null for every codex row.
// Agent SDK rows time each call from its tool_use message to its tool_result.
// A codex row folds in what its rollout says its exec cells did (code_mode,
// read from rollouts/ for a row that predates it), as report.mjs does.

import { realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCallRecorder, malformedUid, NO_SUCH_TOOL, PAGE_CLOSE_TOOL, PAGE_TEXT_TOOL, readsPage, restartCount, scriptedWrite,
  scriptSleeps, STALE, uidShapeOf, withCodeMode,
} from '../mcp-tap.mjs';
import { rowEvents, SURFACE_SERVER, toolCalls } from './events.mjs';
import { codeModeOf } from './row-evidence.mjs';
import { isRunDir, readRun } from '../run-files.mjs';

export const SNAPSHOT_TOOL = /^(take_snapshot|browser_snapshot)$/;
export const SCRIPT_TOOL = /^(evaluate_script|browser_evaluate|browser_run_code\w*)$/;
// Both surfaces' page actions: firefox-devtools-mcp's, then playwright-mcp's.
export const ACTION_TOOL =
  /^(click_by_uid|fill_by_uid|fill_form_by_uid|navigate_page|navigate_history|hover_by_uid|drag_by_uid_to_uid|select_option|press_key|type_text|browser_click|browser_type|browser_fill_form|browser_navigate|browser_navigate_back|browser_hover|browser_drag|browser_select_option|browser_press_key)$/;
const CLICK_TOOL = /^(click_by_uid|browser_click)$/;
const WAIT_TOOL = /wait/i;

// Error signatures, matched on what a surface call returned. The stale-uid one
// is the tap's, so the two readings of a row count the same replies.
export const SIGNATURES = {
  browserLost: /ECONNREFUSED|marionette|unexpectedly closed|Process \(pid|session deleted|NoSuchWindow|browsing context/i,
  staleUid: STALE,
  timeout: /Timeout \d+ms exceeded|timed out/i,
  emptyDialogError: /Failed to (accept|dismiss) dialog: ?$/m,
};

const median = (values) => {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// firefox-devtools-mcp's snapshot quotes each node's text and href and cuts the
// quoted value at 27 characters plus "..." (MAX_ATTR_LENGTH=30 in 0.9.15 and
// 0.10.3).
function snapshotCuts(text) {
  const cut = { texts: 0, text_cut: 0, hrefs: 0, href_cut: 0, cut_values: [] };
  for (const m of text.matchAll(/ text="([^"]*)"/g)) {
    cut.texts++;
    if (m[1].endsWith('...')) {
      cut.text_cut++;
      cut.cut_values.push(m[1].slice(0, -3));
    }
  }
  for (const m of text.matchAll(/ href="([^"]*)"/g)) {
    cut.hrefs++;
    if (m[1].endsWith('...')) {
      cut.href_cut++;
      cut.cut_values.push(m[1].slice(0, -3));
    }
  }
  return cut;
}

// A script "recovers" a cut when its result carries the cut value's opening
// followed by more text rather than the ellipsis: the agent scripted its way
// to what the snapshot withheld.
function recoversCut(scriptText, cutValues) {
  for (const head of cutValues) {
    if (head.length < 12) continue;
    let from = 0;
    for (;;) {
      const at = scriptText.indexOf(head, from);
      if (at === -1) break;
      const next = scriptText.slice(at + head.length, at + head.length + 3);
      if (next && next !== '...' && !/^["\s]/.test(next)) return true;
      from = at + 1;
    }
  }
  return false;
}

// The same shape the MCP tap writes on a new row (`tools`, `snapshot`,
// `friction`, `surface_calls`, `foreign_tools`), plus what only a transcript
// shows. `server` is the condition's own browser server.
export function rowToolStats(events, { server = SURFACE_SERVER } = {}) {
  const calls = toolCalls(events);
  // The Claude CLI answers a call to a tool the server lacks itself, so that
  // call never reached the surface.
  const unknown = (c) => c.isError && NO_SUCH_TOOL.test(c.text);
  const surface = calls.filter((c) => c.server === server && !unknown(c));
  const foreign = {};
  for (const c of calls) {
    if (c.server && c.server !== server) foreign[c.server] = (foreign[c.server] ?? 0) + 1;
  }
  const tools = {};
  const ms = {};
  for (const c of surface) {
    const t = (tools[c.tool] ??= { calls: 0, errors: 0, chars: 0, max_chars: 0, p50_ms: null });
    t.calls++;
    t.errors += c.isError ? 1 : 0;
    t.chars += c.text.length;
    t.max_chars = Math.max(t.max_chars, c.text.length);
    if (c.ms != null) (ms[c.tool] ??= []).push(c.ms);
  }
  for (const [tool, list] of Object.entries(ms)) tools[tool].p50_ms = median(list);

  const snapshot = {
    calls: 0, chars: 0, truncated: 0, texts: 0, text_cut: 0, hrefs: 0, href_cut: 0,
    line_cut: 0, dom_truncated: 0, sizes: [],
  };
  const friction = {
    actions: 0, act_then_snap: 0, act_then_read: 0, clicks: 0, click_then_snap: 0, eval_calls: 0, scripted_writes: 0,
    eval_after_cut: 0, eval_straight_after_cut: 0, eval_recovers_cut: 0,
    page_text_reads: 0, page_text_chars: 0, page_text_recovers_cut: 0,
    stale_uid: 0, malformed_uid: 0, restarts: restartCount(surface.map((c) => c.tool)),
    closes: surface.filter((c) => PAGE_CLOSE_TOOL.test(c.tool)).length,
    closed_at_end: PAGE_CLOSE_TOOL.test(surface.at(-1)?.tool ?? '') ? 1 : 0,
    browser_lost: 0, sleeps: 0, script_sleeps: 0,
    unknown_tools: calls.filter((c) => c.server === server && unknown(c)).length,
  };
  const signatures = Object.fromEntries(Object.keys(SIGNATURES).map((k) => [k, 0]));
  let lastCut = [];
  let lastSnapshotId = 0;
  let malformedStale = 0;
  // The uid shape the snapshots so far printed, as the tap's recorder reads it.
  let uidShape = null;
  surface.forEach((c, i) => {
    const prev = surface[i - 1];
    const next = surface[i + 1];
    const snapNext = !!next && SNAPSHOT_TOOL.test(next.tool);
    if (ACTION_TOOL.test(c.tool)) {
      friction.actions++;
      if (snapNext) friction.act_then_snap++;
      if (next && readsPage(next.tool, scriptedWrite(next.tool, next.args))) friction.act_then_read++;
    }
    if (CLICK_TOOL.test(c.tool)) {
      friction.clicks++;
      if (snapNext) friction.click_then_snap++;
    }
    if (SNAPSHOT_TOOL.test(c.tool)) {
      const cut = snapshotCuts(c.text);
      const lineCut = /\[\+\d+ lines/.test(c.text);
      const domCut = c.text.includes('[DOM truncated]');
      snapshot.calls++;
      snapshot.chars += c.text.length;
      snapshot.sizes.push(c.text.length);
      snapshot.texts += cut.texts;
      snapshot.text_cut += cut.text_cut;
      snapshot.hrefs += cut.hrefs;
      snapshot.href_cut += cut.href_cut;
      snapshot.line_cut += lineCut ? 1 : 0;
      snapshot.dom_truncated += domCut ? 1 : 0;
      if (cut.text_cut || cut.href_cut || lineCut || domCut) snapshot.truncated++;
      lastCut = cut.cut_values;
      // A snapshot numbered 1 after a higher one is firefox-devtools-mcp's
      // silent relaunch: the browser died and came back on about:blank. From
      // 0.10.0 a snapshot carries no id, and no reply shows a silent relaunch.
      const id = Number(/Snapshot \(id=(\d+)\)/.exec(c.text)?.[1] ?? NaN);
      if (id === 1 && lastSnapshotId > 1) friction.restarts++;
      if (Number.isFinite(id)) lastSnapshotId = id;
    }
    if (SCRIPT_TOOL.test(c.tool)) {
      friction.eval_calls++;
      // Nearly every 0.9.15 snapshot cuts some href, so eval_after_cut is close
      // to eval_calls; the straight-after and recovered counts are the telling ones.
      if (lastCut.length) {
        friction.eval_after_cut++;
        if (prev && SNAPSHOT_TOOL.test(prev.tool)) friction.eval_straight_after_cut++;
        if (recoversCut(c.text, lastCut)) friction.eval_recovers_cut++;
      }
      friction.script_sleeps += scriptSleeps(c.detail);
      if (scriptedWrite(c.tool, c.args)) friction.scripted_writes++;
    }
    // get_page_text reads the text a snapshot cut as a script does, without
    // counting as one.
    if (PAGE_TEXT_TOOL.test(c.tool)) {
      friction.page_text_reads++;
      friction.page_text_chars += c.text.length;
      if (lastCut.length && recoversCut(c.text, lastCut)) friction.page_text_recovers_cut++;
    }
    if (WAIT_TOOL.test(c.tool)) friction.sleeps++;
    for (const [k, re] of Object.entries(SIGNATURES)) {
      if (re.test(c.text)) signatures[k]++;
    }
    // firefox-devtools-mcp answers a malformed uid ("uid=1_59") with its
    // stale text, playwright-mcp a malformed ref with a selector error
    // (mcp-tap.mjs malformedUid); only the former comes out of stale_uid.
    if (c.isError && malformedUid(c.args, uidShape)) {
      friction.malformed_uid++;
      if (SIGNATURES.staleUid.test(c.text)) malformedStale++;
    }
    if (SNAPSHOT_TOOL.test(c.tool) && !c.isError) uidShape = uidShapeOf(c.text) ?? uidShape;
  });
  friction.sleeps += friction.script_sleeps;
  friction.stale_uid = signatures.staleUid - malformedStale;
  friction.browser_lost = signatures.browserLost;
  const shell = calls.filter((c) => c.tool === 'shell' || c.tool === 'Bash');
  friction.sleeps += shell.filter((c) => /(^|[;&|\s])sleep\s+\d/.test(c.detail)).length;
  // Snapshot files the agent read back through the Read tool or its shell,
  // which the tap's recorder tells apart (mcp-tap.mjs).
  const recorder = createCallRecorder(server);
  for (const e of events) recorder.observe(e);
  const files = recorder.summary().snapshot;
  snapshot.file_reads = files.file_reads;
  snapshot.file_chars = files.file_chars;
  snapshot.chars += files.file_chars;
  return {
    surface_calls: surface.length,
    surface_errors: surface.filter((c) => c.isError).length,
    foreign_tools: Object.values(foreign).reduce((a, b) => a + b, 0),
    foreign_servers: foreign,
    shell_calls: shell.length,
    tools,
    snapshot,
    friction,
    signatures,
  };
}

// Rows of a run with their stats, for every row whose transcript is on disk.
export function runToolStats(runDir, results) {
  return results.map((row) => {
    const events = rowEvents(runDir, row);
    const stats = events ? rowToolStats(events) : null;
    const codeMode = codeModeOf(row, runDir);
    if (stats && codeMode) stats.friction = withCodeMode(stats.friction, codeMode);
    return { row, stats };
  });
}

// A condition's rows summed, the per-tool table a report prints.
export function sumToolStats(statsList) {
  const out = {
    rows: 0, surface_calls: 0, surface_errors: 0, foreign_tools: 0, foreign_rows: 0,
    no_surface_rows: 0, shell_calls: 0, script_rows: 0, foreign_servers: {}, tools: {},
    snapshot: {}, friction: {}, signatures: {}, snapshot_sizes: [],
  };
  const ms = {};
  for (const s of statsList) {
    if (!s) continue;
    out.rows++;
    out.surface_calls += s.surface_calls;
    out.surface_errors += s.surface_errors;
    out.foreign_tools += s.foreign_tools;
    out.foreign_rows += s.foreign_tools ? 1 : 0;
    out.no_surface_rows += s.surface_calls ? 0 : 1;
    out.shell_calls += s.shell_calls;
    out.script_rows += s.friction.eval_calls ? 1 : 0;
    for (const [k, v] of Object.entries(s.foreign_servers)) out.foreign_servers[k] = (out.foreign_servers[k] ?? 0) + v;
    for (const [tool, t] of Object.entries(s.tools)) {
      const o = (out.tools[tool] ??= { calls: 0, errors: 0, chars: 0, max_chars: 0, rows: 0 });
      o.calls += t.calls;
      o.errors += t.errors;
      o.chars += t.chars;
      o.max_chars = Math.max(o.max_chars, t.max_chars);
      o.rows++;
      if (t.p50_ms != null) (ms[tool] ??= []).push(t.p50_ms);
    }
    for (const group of ['snapshot', 'friction', 'signatures']) {
      for (const [k, v] of Object.entries(s[group])) {
        if (typeof v === 'number') out[group][k] = (out[group][k] ?? 0) + v;
      }
    }
    out.snapshot_sizes.push(...s.snapshot.sizes);
  }
  for (const [tool, list] of Object.entries(ms)) out.tools[tool].p50_ms = median(list);
  return out;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const quantile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};

export function formatConditionStats(condition, t) {
  const lines = [
    `== ${condition}: ${t.rows} rows, ${t.surface_calls} surface calls ` +
      `(${t.surface_errors} errors), ${t.shell_calls} shell commands`,
    `   rows that never called the surface: ${t.no_surface_rows}; rows calling another MCP server: ` +
      `${t.foreign_rows} (${t.foreign_tools} calls: ${JSON.stringify(t.foreign_servers)})`,
    `   ${'tool'.padEnd(26)} ${'calls'.padStart(5)} ${'rows'.padStart(4)} ${'err'.padStart(4)} ` +
      `${'err/100'.padStart(7)} ${'chars'.padStart(9)} ${'avg'.padStart(6)} ${'max'.padStart(7)} ${'p50 ms'.padStart(7)}`,
  ];
  for (const [tool, s] of Object.entries(t.tools).sort((a, b) => b[1].calls - a[1].calls)) {
    lines.push(
      `   ${tool.padEnd(26)} ${String(s.calls).padStart(5)} ${String(s.rows).padStart(4)} ` +
        `${String(s.errors).padStart(4)} ${((100 * s.errors) / s.calls).toFixed(1).padStart(7)} ` +
        `${String(s.chars).padStart(9)} ${String(Math.round(s.chars / s.calls)).padStart(6)} ` +
        `${String(s.max_chars).padStart(7)} ${String(s.p50_ms ?? 'n/a').padStart(7)}`
    );
  }
  const sn = t.snapshot;
  const fr = t.friction;
  if (sn.calls) {
    lines.push(
      `   snapshots: ${sn.calls}, chars p50 ${quantile(t.snapshot_sizes, 0.5)} p90 ${quantile(t.snapshot_sizes, 0.9)} ` +
        `max ${Math.max(...t.snapshot_sizes)}; with a cut ${sn.truncated}; text values cut ` +
        `${sn.text_cut}/${sn.texts} (${pct(sn.text_cut, sn.texts)}); hrefs cut ${sn.href_cut}/${sn.hrefs} ` +
        `(${pct(sn.href_cut, sn.hrefs)}); line-cut ${sn.line_cut}; DOM-truncated ${sn.dom_truncated}` +
        (sn.file_reads ? `; ${sn.file_reads} snapshot file(s) read back, ${sn.file_chars} chars, counted in the chars` : '')
    );
  }
  lines.push(
    `   scripts: ${fr.eval_calls ?? 0} calls in ${t.script_rows} rows, ${fr.scripted_writes ?? 0} of them writing the page; after an earlier snapshot in the row cut some value ` +
      `${fr.eval_after_cut ?? 0} (straight after it ${fr.eval_straight_after_cut ?? 0}); returned a cut value in full ${fr.eval_recovers_cut ?? 0}` +
      (fr.page_text_reads
        ? `; page text reads ${fr.page_text_reads} (${fr.page_text_chars ?? 0} chars), returning a cut value in full ${fr.page_text_recovers_cut ?? 0}`
        : ''),
    `   action then snapshot: ${fr.act_then_snap ?? 0}/${fr.actions ?? 0} (${pct(fr.act_then_snap, fr.actions)}); ` +
      `action then any read (snapshot, page text, a script that writes nothing): ${fr.act_then_read ?? 0}/${fr.actions ?? 0} (${pct(fr.act_then_read, fr.actions)}); ` +
      `click then snapshot ${fr.click_then_snap ?? 0}/${fr.clicks ?? 0} (${pct(fr.click_then_snap, fr.clicks)})`,
    `   stale uid ${fr.stale_uid ?? 0}, malformed uid or ref ${fr.malformed_uid ?? 0}, restarts ${fr.restarts ?? 0}` +
      (fr.closes ? ` (browser closes ${fr.closes}, ${fr.closed_at_end ?? 0} as a row's last call)` : '') +
      `, browser lost ${fr.browser_lost ?? 0}, ` +
      `timeouts ${t.signatures.timeout ?? 0}, empty dialog errors ${t.signatures.emptyDialogError ?? 0}, waits ${fr.sleeps ?? 0}, ` +
      `calls to tools the server lacks ${fr.unknown_tools ?? 0}` +
      (fr.tool_search ? `, tool discovery ${fr.tool_search}` : '') +
      (fr.harness_truncated ? `, outputs the harness cut ${fr.harness_truncated}` : '')
  );
  return lines;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const dir = args.find((a, i) => !a.startsWith('--') && !['--condition', '--json'].includes(args[i - 1]));
  if (!dir || !isRunDir(dir)) {
    console.error('usage: node eval/scripts/tool-stats.mjs <run-dir> [--condition <c>] [--json <out>]');
    process.exit(1);
  }
  const { results } = readRun(dir);
  const only = flag('condition');
  const perRow = runToolStats(dir, results.filter((r) => !only || r.condition === only));
  const byCondition = {};
  for (const { row, stats } of perRow) (byCondition[row.condition] ??= []).push(stats);
  const missing = perRow.filter((p) => !p.stats).length;
  for (const [condition, list] of Object.entries(byCondition)) {
    console.log(formatConditionStats(condition, sumToolStats(list)).join('\n') + '\n');
  }
  if (missing) console.log(`${missing} row(s) have no transcript on disk and are left out.`);
  const out = flag('json');
  if (out) {
    const rows = perRow.map(({ row, stats }) => ({
      condition: row.condition, task: row.task, rep: row.rep ?? null, success: row.success,
      ...(stats ? { ...stats, snapshot: { ...stats.snapshot, sizes: undefined } } : { missing: true }),
    }));
    writeFileSync(resolve(out), JSON.stringify(rows, null, 1) + '\n');
    console.log(`wrote ${resolve(out)}`);
  }
}
