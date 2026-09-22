// Whether a run's own files agree with each other: every row the run selected
// is there, each row's numbers recompute from what the row and its files hold,
// the conditions it pairs faced the same draws in the environment meta says,
// and report.md prints what report.mjs computes from results.json today. It
// reads the run and spends nothing.
//
//   node eval/scripts/run-health.mjs <run-dir>... [--all] [--json <out>]
//
// Each check prints PASS, WARN or FAIL with its evidence, or N/A when the run
// gives it nothing to test. FAIL means files that disagree, or a row that
// breaks a rule the reports rely on; WARN a confound the numbers carry, or a
// field the run predates ("not recorded"), which leaves the check partial.
// `--all` prints every evidence line rather than the first few, `--json`
// writes every line whether or not it printed them, and the exit status is 1
// when any check fails. report.mjs sums the checks up in one line
// of report.md's header, and run.mjs prints that line when a run ends.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceTokens } from '../backends/pricing.mjs';
import { enforceQuotes, normalise } from '../extract.mjs';
import { createCallRecorder, readTapLog, serverExit, serverExitText, tapSurfaceCalls, toolsListInfo } from '../mcp-tap.mjs';
import { ENV_COMPARED, PINNED, headline, totalsByCondition, totalsTableLines } from '../report.mjs';
import { isRunDir, parseTranscriptName, readRun } from '../run-files.mjs';
import { rowEvents, SURFACE_SERVER } from './events.mjs';
import { foreignBrowser } from './foreign-browser.mjs';
import { browserBuilds, buildName, drawKey, PRICING_COMMIT, runFlags } from './identity.mjs';
import { rolloutCoversRow, rowState, shellAssisted, shellAssistedOf } from './row-evidence.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The price table pricing.mjs reads, at the version this checkout resolves,
// which run.mjs records as meta.priceTable.
export const PRICE_TABLE = '@pydantic/genai-prices';
export const PRICE_TABLE_VERSION = (() => {
  for (let dir = REPO; ; dir = dirname(dir)) {
    const path = join(dir, 'node_modules', PRICE_TABLE, 'package.json');
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')).version ?? null;
      } catch {
        return null;
      }
    }
    if (dirname(dir) === dir) return null;
  }
})();
// The code report.md's totals table is computed by.
const REPORT_READER = ['eval/report.mjs', 'eval/scripts/row-evidence.mjs'];
const ORDER = ['PASS', 'N/A', 'WARN', 'FAIL'];
const worse = (a, b) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
const rowName = (r) => `${r.condition}/${r.task}${r.rep ? ` (r${r.rep})` : ''}`;
const keyOf = (condition, task, rep) => `${condition}|${task}#${rep ?? 1}`;
const rowKey = (r) => keyOf(r.condition, r.task, r.rep);
const money = (x) => `$${(Math.round(x * 10000) / 10000).toFixed(4)}`;
// Costs agree to a billionth of a dollar: both sides are sums of the same float
// products, and only the order of addition can differ.
const sameCost = (a, b) => a != null && b != null && Math.abs(a - b) <= 1e-9 + 1e-9 * Math.abs(b);
const backendOf = (r, meta) =>
  r.backend ?? (String(r.condition ?? '').includes('/') ? r.condition.split('/')[0] : String(meta.backend ?? '').split(',')[0] || null);
const bareCondition = (c) => String(c).split('/').pop();
const toolOf = (c) => bareCondition(c).split('@')[0];
const graded = (r) => !r.error && !r.infra && r.task !== '(condition)';
const counted = (list) => {
  const out = {};
  for (const x of list) out[x] = (out[x] ?? 0) + 1;
  return out;
};
const tally = (counts) =>
  Object.entries(counts)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
const TOKEN_KEYS = ['input_tokens', 'cache_creation', 'cache_read', 'output_tokens'];

// An evidence entry that lists `items` in full: one indented line each under
// `head`, or joined by `sep` after it when `inline`, then `tail`. A printout
// shows the first `n` of them (evidenceLines).
const listing = (head, items, { n = 8, inline = false, sep = ', ', tail = '' } = {}) => ({ head, items, n, inline, sep, tail });
export function evidenceLines(entry, all = false) {
  if (typeof entry === 'string') return [entry];
  const shown = all ? entry.items : entry.items.slice(0, entry.n);
  const more = entry.items.length - shown.length;
  const cut = more ? `... ${more} more (--all)` : '';
  if (entry.inline) return [`${entry.head}${[...shown, ...(cut ? [cut] : [])].join(entry.sep)}${entry.tail}`];
  return [entry.head, ...[...shown, ...(cut ? [cut] : [])].map((l) => `  ${l}`), ...(entry.tail ? [entry.tail] : [])];
}

// What a row's transcript, tap log and state file say, reduced to what the
// checks compare, so a run's files are read once and one at a time.
function rowFacts(dir, row) {
  const facts = {};
  const events = rowEvents(dir, row);
  if (events) {
    const recorder = createCallRecorder(SURFACE_SERVER);
    for (const e of events) recorder.observe(e);
    const s = recorder.summary();
    facts.stream = {
      calls: s.surface_calls,
      tools: Object.fromEntries(Object.entries(s.tools).map(([t, x]) => [t, x.calls])),
      shell: s.shell_windows,
      timed: events.some((e) => e?.timestamp),
    };
    const results = events.filter((e) => e?.type === 'result');
    if (results.length) {
      facts.sdk = { modelUsage: results.at(-1).modelUsage ?? null };
    }
  }
  const tapPath = row.transcript ? join(dir, 'tool-calls', row.transcript) : null;
  if (tapPath && existsSync(tapPath)) {
    const records = readTapLog(tapPath);
    const calls = tapSurfaceCalls(records);
    const init = records.find((r) => r.type === 'initialize');
    const list = records.find((r) => r.type === 'tools/list' && Array.isArray(r.tools));
    const exitAt = records.findIndex((r) => r.type === 'exit');
    facts.tap = {
      calls: calls.length,
      tools: counted(calls.map((c) => c.tool)),
      version: init ? init.serverInfo?.version ?? null : undefined,
      instructions: init ? ('instructions' in init ? init.instructions?.sha256 ?? null : undefined) : undefined,
      toolsHash: list ? toolsListInfo(list.tools).hash : undefined,
      died: serverExit(records),
      killed: records[exitAt]?.by === 'harness',
      stopKilled: records[exitAt]?.signal === 'SIGKILL' && records.slice(0, exitAt).some((r) => r.type === 'signal'),
      windows: records.filter((r) => r.type === 'call' && r.at != null).map((r) => [r.at, r.at + (r.ms ?? 0)]),
    };
  }
  const state = rowState(row, dir);
  if (state) {
    facts.state = {
      draws: Array.isArray(state.draws) ? JSON.parse(JSON.stringify(Array.from(state.draws))) : null,
      shell: Array.isArray(state.ledger) ? shellAssisted(state.ledger, { backend: row.backend }) : undefined,
    };
    // The user-agent rule reads the ledger and the token alone, so it re-runs
    // exactly; the timing rules also need each shell command's times, which a
    // codex transcript does not keep.
    if (Array.isArray(state.ledger) && (row.foreign_browser?.method === 'user agent' || facts.stream?.timed)) {
      try {
        facts.state.foreign = foreignBrowser(state.ledger, {
          windows: facts.tap?.windows ?? null,
          shell: facts.stream?.shell ?? [],
          token: row.browser?.tag ?? null,
        });
      } catch (error) {
        facts.state.foreign = { error: String(error?.message ?? error) };
      }
    }
  }
  if (facts.tap) delete facts.tap.windows;
  if (facts.stream) delete facts.stream.shell;
  return facts;
}

// The row labels a run's conditions give: meta.conditions, with the backend
// prefix a run of several backends puts on them. Null when meta lacks them.
function conditionsOf(meta) {
  const backends = String(meta.backend ?? '').split(',').filter(Boolean);
  const bare = meta.conditions ? String(meta.conditions).split(',').filter(Boolean) : null;
  if (!bare) return null;
  return backends.length > 1 ? backends.flatMap((b) => bare.map((c) => `${b}/${c}`)) : bare;
}
const rowConditions = (results) => [...new Set(results.filter((r) => r.task !== '(condition)').map((r) => r.condition))];

// Every selected task and repeat has one row per condition, and no row sits
// outside that grid; results.json holds every row rows.jsonl wrote; and every
// attempt a transcript records belongs to a row.
function checkRows({ dir, meta, results, hasJson }) {
  const evidence = [];
  let status = 'PASS';
  const recorded = conditionsOf(meta);
  const conditions = recorded ?? rowConditions(results);
  const tasks = Array.isArray(meta.tasks) ? meta.tasks : [...new Set(results.map((r) => r.task).filter((t) => t !== '(condition)'))];
  const repeat = meta.repeat ?? Math.max(1, ...results.map((r) => r.rep ?? 1));
  const unrecorded = [!recorded && 'meta.conditions', !Array.isArray(meta.tasks) && 'meta.tasks'].filter(Boolean);
  if (unrecorded.length) {
    status = 'WARN';
    evidence.push(`${unrecorded.join(' and ')} not recorded: the grid is the conditions and tasks the rows name`);
  }
  const seen = counted(results.filter((r) => r.task !== '(condition)').map(rowKey));
  const expected = conditions.flatMap((c) => tasks.flatMap((t) => Array.from({ length: repeat }, (_, i) => keyOf(c, t, i + 1))));
  const missing = expected.filter((k) => !seen[k]);
  const doubled = Object.entries(seen).filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  const outside = Object.keys(seen).filter((k) => !expected.includes(k));
  const failedArms = results.filter((r) => r.task === '(condition)');
  const show = (k) => k.replace('|', '/').replace(/#(\d+)$/, (_, n) => (repeat > 1 ? ` (r${n})` : ''));
  if (missing.length) {
    status = 'FAIL';
    const byCondition = counted(missing.map((k) => k.split('|')[0]));
    evidence.push(
      listing(`${missing.length} missing row(s) (${tally(byCondition)}): `, missing.map(show), {
        n: 12,
        inline: true,
        tail: Array.isArray(meta.tasks) ? `; node eval/run.mjs --rerun-failed ${dir} runs them` : '',
      })
    );
  }
  if (doubled.length) {
    status = 'FAIL';
    evidence.push(listing('rows recorded more than once: ', doubled.map(show), { n: 12, inline: true }));
  }
  if (outside.length) {
    status = 'FAIL';
    evidence.push(listing('rows outside the selected tasks, repeats and conditions: ', outside.map(show), { n: 12, inline: true }));
  }
  for (const r of failedArms) {
    status = 'FAIL';
    evidence.push(`condition ${r.condition} failed as a whole: ${r.error}`);
  }
  for (const [key, why] of [['interrupted', 'the run was interrupted'], ['failed', 'the run stopped on an error']]) {
    if (!meta[key]) continue;
    status = 'FAIL';
    evidence.push(
      key === 'interrupted' && meta.interrupted === 'killed' && !hasJson
        ? 'the run was killed before it wrote results.json: its rows are read from rows.jsonl'
        : `${why} (${meta[key]})${meta.unsettled ? `, ${meta.unsettled} attempt(s) still running when it wrote its rows` : ''}`
    );
  }
  const jsonl = join(dir, 'rows.jsonl');
  if (hasJson && existsSync(jsonl)) {
    const written = counted(readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return rowKey(JSON.parse(l));
      } catch {
        return '(unparsable line)';
      }
    }));
    const kept = counted(results.map(rowKey));
    const lost = Object.keys(written).filter((k) => (kept[k] ?? 0) < written[k]);
    const extra = Object.keys(kept).filter((k) => (written[k] ?? 0) < kept[k]);
    if (lost.length || extra.length) {
      status = 'FAIL';
      if (lost.length) evidence.push(listing(`rows.jsonl holds ${lost.length} row(s) results.json lacks: `, lost.map(show), { n: 10, inline: true }));
      if (extra.length) evidence.push(listing(`results.json holds ${extra.length} row(s) rows.jsonl never wrote: `, extra.map(show), { n: 10, inline: true }));
    }
  } else if (hasJson) {
    status = worse(status, 'WARN');
    evidence.push('rows.jsonl not recorded (the run predates it), so results.json is not checked against the rows as they finished');
  }
  const transcripts = existsSync(join(dir, 'transcripts')) ? readdirSync(join(dir, 'transcripts')).filter((f) => f.endsWith('.jsonl')) : [];
  const byKey = new Map(results.map((r) => [rowKey(r), r]));
  const orphans = [];
  const later = [];
  let discarded = 0;
  for (const file of transcripts) {
    const t = parseTranscriptName(file);
    const row = byKey.get(keyOf(t.label, t.task, t.rep));
    if (!row) {
      orphans.push(file);
      continue;
    }
    const gradedAttempt = row.transcript ? parseTranscriptName(row.transcript).attempt : (row.retries ?? 0) + 1;
    if (t.attempt > gradedAttempt) later.push(file);
    else if (t.attempt < gradedAttempt) discarded++;
  }
  if (orphans.length) {
    status = 'FAIL';
    evidence.push(listing(`${orphans.length} transcript(s) of attempts no row records: `, orphans, { inline: true }));
  }
  if (later.length) {
    status = 'FAIL';
    evidence.push(listing(`${later.length} transcript(s) of attempts after the one their row records: `, later, { inline: true }));
  }
  const summary =
    `${results.length} row(s) against ${expected.length} expected: ${tasks.length} task(s) x ${repeat} repeat(s) x ${conditions.length} condition(s)` +
    (missing.length ? `, ${missing.length} missing` : '') +
    (discarded ? `; ${discarded} transcript(s) of retried attempts` : '');
  return { status, summary, evidence };
}

// Every file a row names is on disk: its transcript, tap log, state file and a
// codex row's rollout.
function checkFiles({ dir, meta, results }) {
  const evidence = [];
  let status = 'PASS';
  const rows = results.filter((r) => r.task !== '(condition)');
  const gone = { transcript: [], 'tap log': [], 'state file': [], rollout: [] };
  const unrecorded = { transcript: 0, 'state file': 0 };
  const stateErrors = [];
  const tapped = meta.tap ?? existsSync(join(dir, 'tool-calls'));
  for (const r of rows) {
    if (!r.transcript) {
      if (graded(r)) unrecorded.transcript++;
    } else {
      if (!existsSync(join(dir, 'transcripts', r.transcript))) gone.transcript.push(rowName(r));
      if (tapped && graded(r) && !existsSync(join(dir, 'tool-calls', r.transcript))) gone['tap log'].push(rowName(r));
    }
    if (r.state_file_error) stateErrors.push(`${rowName(r)}: ${r.state_file_error}`);
    else if (r.state_file) {
      if (!existsSync(join(dir, r.state_file))) gone['state file'].push(rowName(r));
    } else if (!('state_file' in r) && graded(r)) unrecorded['state file']++;
    if (r.rollout && !existsSync(join(dir, r.rollout))) gone.rollout.push(rowName(r));
    else if (backendOf(r, meta) === 'codex' && graded(r) && r.transcript && !r.rollout) {
      if (!existsSync(join(dir, 'rollouts'))) unrecorded.rollout = (unrecorded.rollout ?? 0) + 1;
      else if (!existsSync(join(dir, 'rollouts', r.transcript))) gone.rollout.push(rowName(r));
    }
  }
  for (const [what, list] of Object.entries(gone)) {
    if (!list.length) continue;
    status = 'FAIL';
    evidence.push(listing(`${list.length} row(s) whose ${what} is missing: `, list, { inline: true }));
  }
  if (stateErrors.length) {
    status = 'FAIL';
    evidence.push(listing(`${stateErrors.length} state file(s) not written: `, stateErrors, { n: 4, inline: true, sep: '; ' }));
  }
  for (const [what, n] of Object.entries(unrecorded)) {
    if (!n) continue;
    status = worse(status, 'WARN');
    evidence.push(`${what} not recorded on ${n} graded row(s) (the run predates it)`);
  }
  if (!tapped) {
    status = worse(status, 'WARN');
    evidence.push('tap logs not recorded (--no-tap, or the run predates the tap)');
  }
  return { status, summary: `${rows.length} row(s)' transcripts, tap logs, state files and rollouts`, evidence };
}

// results.json's totals are what totalsByCondition sums from its rows.
function checkTotals({ results, totals, hasJson }) {
  if (!hasJson) return { status: 'N/A', summary: 'no results.json: the run was killed before it wrote one', evidence: [] };
  if (!totals) return { status: 'WARN', summary: 'results.json totals not recorded', evidence: [] };
  const now = totalsByCondition(results);
  const wrong = [];
  const unknown = [];
  const unrecorded = [];
  const dropped = [];
  for (const c of new Set([...Object.keys(totals), ...Object.keys(now)])) {
    if (!totals[c] || !now[c]) {
      wrong.push(`${c}: ${totals[c] ? 'in results.json totals, and no row has the condition' : 'has rows, and no results.json totals'}`);
      continue;
    }
    for (const k of new Set([...Object.keys(totals[c]), ...Object.keys(now[c])])) {
      const a = totals[c][k];
      const b = now[c][k];
      const same = a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6);
      if (same || (a === undefined && b === 0)) continue;
      // A figure one side does not sum at all: the other report.mjs's layout.
      if (a === undefined) unrecorded.push(`${c} ${k}`);
      else if (b === undefined) dropped.push(`${c} ${k}`);
      else if (a === 0 && b === null) unknown.push(`${c} ${k}`);
      else wrong.push(`${c} ${k}: results.json ${a ?? 'none'}, summed now ${b ?? 'none'}`);
    }
  }
  const evidence = [...wrong];
  if (unknown.length) {
    evidence.push(listing("results.json sums no row's figure to 0 where totalsByCondition now reports it unknown (an older report.mjs): ", unknown, { n: 12, inline: true }));
  }
  if (unrecorded.length) evidence.push(listing('not recorded in results.json totals (an older report.mjs): ', unrecorded, { n: 12, inline: true }));
  if (dropped.length) evidence.push(listing('in results.json totals and no longer summed by totalsByCondition: ', dropped, { n: 12, inline: true }));
  return {
    status: wrong.length ? 'FAIL' : unknown.length || unrecorded.length || dropped.length ? 'WARN' : 'PASS',
    summary: wrong.length ? `results.json totals differ from its rows in ${wrong.length} figure(s)` : `results.json totals match its ${results.length} rows`,
    evidence,
  };
}

// A markdown table's rows under `heading`, as { [first cell]: { [column]: cell } }.
function tableUnder(text, heading) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  const tableAt = at === -1 ? -1 : lines.findIndex((l, i) => i > at && l.startsWith('| condition |'));
  return tableAt === -1 ? null : parseTable(lines.slice(tableAt));
}
function parseTable(lines) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [head, , ...body] = lines;
  const columns = cells(head);
  const out = {};
  for (const l of body) {
    if (!l.startsWith('|')) break;
    const row = cells(l);
    out[row[0]] = Object.fromEntries(columns.map((c, i) => [c, row[i]]));
  }
  return { columns, rows: out };
}

// report.md's totals table prints what report.mjs computes from the rows now.
function checkReport({ dir, meta, results, hasJson }) {
  const path = join(dir, 'report.md');
  if (!existsSync(path)) {
    return hasJson
      ? { status: 'FAIL', summary: 'no report.md beside results.json', evidence: [] }
      : { status: 'WARN', summary: 'no report.md (a killed run; node eval/run.mjs --report-from renders one)', evidence: [] };
  }
  const text = readFileSync(path, 'utf8');
  const stored = tableUnder(text, '## Totals per condition');
  const now = parseTable(totalsTableLines(headline({ results, runDir: dir })));
  if (!stored) return { status: 'WARN', summary: 'report.md has no totals table to compare (an older layout)', evidence: [] };
  const evidence = [];
  let status = 'PASS';
  const shared = stored.columns.filter((c) => now.columns.includes(c));
  const older = now.columns.filter((c) => !stored.columns.includes(c));
  if (older.length) {
    status = 'WARN';
    evidence.push(`report.md was rendered without the column(s) ${older.join(', ')}`);
  }
  let differ = 0;
  const unknown = [];
  for (const c of new Set([...Object.keys(stored.rows), ...Object.keys(now.rows)])) {
    if (!stored.rows[c] || !now.rows[c]) {
      differ++;
      evidence.push(`${c}: ${stored.rows[c] ? 'in report.md only' : 'computed now, absent from report.md'}`);
      continue;
    }
    for (const col of shared.slice(1)) {
      const [was, is] = [stored.rows[c][col], now.rows[c][col]];
      if (was === is) continue;
      // A figure no row reported, which an older report.mjs printed as 0.
      if (is === 'n/a' && (was === '0' || was === 'null')) unknown.push(`${c} ${col}`);
      else {
        differ++;
        evidence.push(`${c} ${col}: report.md ${was}, report.mjs now ${is}`);
      }
    }
  }
  if (unknown.length) {
    status = worse(status, 'WARN');
    evidence.push(`report.md prints 0 for figures no row reported, which report.mjs now prints n/a: ${unknown.join(', ')}`);
  }
  // A table that differs because the reader changed since the run is stale
  // rather than wrong; one that hides an interrupt is wrong under any reader.
  if (differ) {
    const version = ruleVersion(meta, REPORT_READER);
    status = excused(version) ? worse(status, 'WARN') : 'FAIL';
    evidence.push(`the cells above differ${ruleNote(meta, version, REPORT_READER.join(' and '), 'report.md keeps the numbers it was rendered with')}`);
  }
  const hidden = meta.interrupted && !/INTERRUPTED/.test(text);
  if (hidden) {
    status = 'FAIL';
    evidence.push(`the run was interrupted (${meta.interrupted}) and report.md does not say so`);
  }
  if (differ || hidden) evidence.push(`node eval/run.mjs --report-from ${dir} renders it again from the rows`);
  return {
    status,
    summary: differ
      ? `report.md's totals table differs from what report.mjs computes now in ${differ} cell(s)`
      : hidden
        ? 'report.md does not say the run was interrupted'
        : `report.md's totals table matches what report.mjs computes now (${Object.keys(now.rows).length} condition(s))`,
    evidence,
  };
}

// Each row's cost recomputes from its tokens with backends/pricing.mjs. A codex
// row is priced as the backend priced it, spread over row.turns requests; an
// Agent SDK row carries the SDK's own figure, the sum of its per-model costs,
// which also pays for every other model the CLI called, so the row's tokens
// are the agent model's entry exactly.
function checkCosts({ meta, results, facts }) {
  const evidence = [];
  let status = 'PASS';
  const v1 = runFlags(meta, results).some((f) => f.flag === 'pricing_v1');
  const wrong = [];
  const reprice = [];
  const moved = [];
  const unpriced = [];
  const sdkSums = [];
  const tokenGaps = [];
  const segmented = [];
  const noAgent = [];
  const priceGaps = [];
  let unread = 0;
  let checked = 0;
  let sdkSpent = 0;
  const aux = {};
  const auxModels = {};
  const totalBy = {};
  const tableVersion = meta.priceTable?.version;
  const tableMoved = tableVersion !== undefined && tableVersion !== PRICE_TABLE_VERSION;
  // Without the table's version, the lockfile stands in for it.
  const pricingPaths = ['eval/backends/pricing.mjs', ...(tableVersion === undefined ? ['package-lock.json'] : [])];
  const pricingVersion = () => ruleVersion(meta, pricingPaths);
  for (const r of results) {
    if (r.output_tokens == null && r.cost_usd == null) continue;
    const backend = backendOf(r, meta);
    const tokens = Object.fromEntries(TOKEN_KEYS.map((k) => [k, r[k] ?? 0]));
    totalBy[r.condition] = (totalBy[r.condition] ?? 0) + (r.cost_usd ?? 0);
    if (r.cost_usd == null) {
      unpriced.push(`${rowName(r)} (no cost recorded)`);
      continue;
    }
    checked++;
    if (backend === 'scripted') {
      if (r.cost_usd !== 0 || tokens.input_tokens !== 0) wrong.push(`${rowName(r)}: scripted row costs ${r.cost_usd} with ${tokens.input_tokens} input tokens`);
      continue;
    }
    if (backend === 'codex') {
      // A row that ran the backend's default model names none to price.
      if (!r.model || r.model.startsWith('(')) {
        checked--;
        unpriced.push(`${rowName(r)} (no model named)`);
        continue;
      }
      const want = priceTokens(r.model, tokens, 'run-health', r.turns);
      if (sameCost(want, r.cost_usd)) continue;
      const whole = priceTokens(r.model, tokens, 'run-health', 1);
      const line =
        `${rowName(r)}: ${money(r.cost_usd)} recorded, ${want == null ? 'unpriced' : money(want)} from its tokens over ${r.turns} request(s)` +
        (r.turns > 1 ? `, ${whole == null ? 'unpriced' : money(whole)} priced as one` : '');
      if (v1 && sameCost(whole, r.cost_usd)) reprice.push(line);
      else if (tableMoved || excused(pricingVersion())) moved.push(line);
      else wrong.push(line);
      continue;
    }
    const usage = r.model_usage ?? facts.get(r)?.sdk?.modelUsage ?? null;
    if (!usage) {
      unread++;
      continue;
    }
    sdkSpent += r.cost_usd;
    // row.model_usage is snake_case, a transcript's result message camelCase.
    const models = Object.entries(usage).map(([name, u]) => [
      name,
      {
        input_tokens: u.input_tokens ?? u.inputTokens ?? 0,
        cache_creation: u.cache_creation ?? u.cacheCreationInputTokens ?? 0,
        cache_read: u.cache_read ?? u.cacheReadInputTokens ?? 0,
        output_tokens: u.output_tokens ?? u.outputTokens ?? 0,
        cost: u.cost_usd ?? u.costUSD ?? 0,
      },
    ]);
    // The SDK's per-model usage is read off its last result message; that it
    // sums every result segment, as total_cost_usd does, no stored row shows.
    const several = (r.segments ?? 1) > 1;
    const sum = models.reduce((n, [, u]) => n + u.cost, 0);
    if (!sameCost(sum, r.cost_usd) && Math.abs(sum - r.cost_usd) > 1e-6) {
      (several ? segmented : sdkSums).push(`${rowName(r)}: cost_usd ${money(r.cost_usd)}, the SDK's per-model costs sum to ${money(sum)}`);
    }
    const agent = models.find(([name]) => name === r.model)?.[1] ?? null;
    if (!agent) {
      noAgent.push(`${rowName(r)}: ${r.model ?? 'no model'}, the SDK names ${models.map(([name]) => name).join(', ') || 'none'}`);
      continue;
    }
    const apart = TOKEN_KEYS.filter((k) => agent[k] !== tokens[k]);
    if (apart.length) {
      (several ? segmented : tokenGaps).push(`${rowName(r)}: ${apart.map((k) => `${k} ${tokens[k]} on the row, ${agent[k]} in the SDK's ${r.model} usage`).join(', ')}`);
    }
    const priced = priceTokens(r.model, tokens, 'run-health', 1);
    if (priced != null && Math.abs(priced - agent.cost) > 1e-6 + 1e-3 * agent.cost) {
      priceGaps.push(`${rowName(r)}: the SDK priced the agent's tokens at ${money(agent.cost)}, pricing.mjs at ${money(priced)}`);
    }
    const others = models.filter(([name, u]) => name !== r.model && u.cost > 0);
    if (others.length) {
      aux[r.condition] = (aux[r.condition] ?? 0) + others.reduce((n, [, u]) => n + u.cost, 0);
      for (const [model] of others) auxModels[model] = (auxModels[model] ?? 0) + 1;
    }
  }
  if (wrong.length) {
    status = 'FAIL';
    evidence.push(listing(`${wrong.length} row(s) whose cost does not recompute from their tokens:`, wrong));
  }
  if (sdkSums.length) {
    status = 'FAIL';
    evidence.push(listing(`${sdkSums.length} row(s) whose cost is not the SDK's per-model sum:`, sdkSums, { n: 6 }));
  }
  if (tokenGaps.length) {
    status = 'FAIL';
    evidence.push(listing(`${tokenGaps.length} row(s) whose token columns are not the SDK's usage for the agent's model:`, tokenGaps, { n: 6 }));
  }
  if (reprice.length) {
    status = worse(status, 'WARN');
    evidence.push(
      listing(
        `${reprice.length} codex row(s) priced before per-request pricing (pricing_v1, ${PRICING_COMMIT}): each is its tokens priced as one request`,
        reprice,
        { n: 4 }
      )
    );
  }
  if (moved.length) {
    status = worse(status, 'WARN');
    const why = tableMoved
      ? `: the run priced them with ${PRICE_TABLE} ${tableVersion}, this checkout with ${PRICE_TABLE_VERSION ?? 'none'}`
      : ruleNote(meta, pricingVersion(), pricingPaths.join(' and '), 'the rows keep the cost they were run with');
    evidence.push(listing(`${moved.length} codex row(s) whose cost neither per-request nor one-request pricing reproduces${why}:`, moved, { n: 4 }));
  }
  if (segmented.length) {
    status = worse(status, 'WARN');
    evidence.push(
      listing(
        `${segmented.length} row(s) of several SDK result segments whose cost or tokens are not the SDK's per-model usage, which may cover the last segment alone:`,
        segmented,
        { n: 4 }
      )
    );
  }
  if (noAgent.length) {
    status = worse(status, 'WARN');
    evidence.push(listing(`${noAgent.length} row(s) whose model the SDK's per-model usage does not name, so its tokens are not compared:`, noAgent, { n: 4 }));
  }
  if (Object.keys(aux).length) {
    status = worse(status, 'WARN');
    const all = Object.values(aux).reduce((n, x) => n + x, 0);
    evidence.push(
      `cost_usd includes ${money(all)} (${((100 * all) / (sdkSpent || 1)).toFixed(1)}% of the ${money(sdkSpent)} its Agent SDK rows cost) that the CLI spent on other models ` +
        `(${tally(auxModels)} row(s)), whose tokens no token column holds: ` +
        Object.entries(aux).map(([c, x]) => `${c} ${money(x)} of ${money(totalBy[c])}`).join(', ')
    );
  }
  if (priceGaps.length) {
    status = worse(status, 'WARN');
    evidence.push(listing(`${priceGaps.length} row(s) where pricing.mjs and the SDK price the agent's tokens apart:`, priceGaps, { n: 4 }));
  }
  if (unpriced.length) {
    status = worse(status, 'WARN');
    evidence.push(listing(`${unpriced.length} row(s) whose cost cannot be recomputed: `, unpriced, { n: 6, inline: true }));
  }
  if (unread) {
    status = worse(status, 'WARN');
    evidence.push(`${unread} SDK row(s) whose per-model costs are not recorded (no row.model_usage and no result message in the transcript)`);
  }
  const discarded = results.reduce((n, r) => n + (r.discarded_attempts ?? 0), 0);
  if (discarded) {
    evidence.push(
      `${discarded} discarded attempt(s), ${money(results.reduce((n, r) => n + (r.discarded_cost_usd ?? 0), 0))}: ` +
        'totalled apart, and not recomputable, since their tokens are not kept'
    );
  }
  const off = wrong.length + sdkSums.length + tokenGaps.length;
  const older = reprice.length + moved.length;
  return {
    status,
    summary: `${checked} priced row(s); ${off} do not recompute${older ? `, ${older} priced by an older rule or price table` : ''}`,
    evidence,
  };
}

// The tap saw each row's surface calls the transcript shows, tool by tool, and
// no server died under its agent.
function checkTap({ meta, results, facts }) {
  if (meta.tap === false) return { status: 'N/A', summary: 'the run ran --no-tap', evidence: [] };
  const evidence = [];
  let status = 'PASS';
  const rows = results.filter((r) => r.transcript && r.task !== '(condition)');
  let compared = 0;
  let noTap = 0;
  let noStream = 0;
  const bad = [];
  const explained = [];
  const flagged = [];
  const named = new Set();
  for (const r of rows) {
    const f = facts.get(r) ?? {};
    if (!f.tap) {
      if (graded(r)) noTap++;
      continue;
    }
    if (!f.stream) {
      noStream++;
      continue;
    }
    compared++;
    const tools = (x) => JSON.stringify(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)));
    const agree = f.tap.calls === f.stream.calls && tools(f.tap.tools) === tools(f.stream.tools);
    const rowAgrees = r.surface_calls == null || r.surface_calls === f.tap.calls;
    if (r.tap_mismatch) flagged.push(rowName(r));
    if (agree && rowAgrees) continue;
    const died = f.tap.died;
    const line =
      `${rowName(r)}: tap ${f.tap.calls} call(s), transcript ${f.stream.calls}, row ${r.surface_calls ?? 'none'}` +
      (agree ? '' : ` (tap ${tools(f.tap.tools)}, transcript ${tools(f.stream.tools)})`) +
      (died ? `; ${serverExitText(died)}` : '') +
      (r.invalid ? `; invalid (${r.invalid})` : '') +
      (r.error ? `; error row: ${String(r.error).slice(0, 80)}` : '');
    // A runner before the tap-count rule wrote the stream's count on the row
    // and the tap's beside it, and today's reading of that stream may agree
    // with the tap.
    const olderRunner = agree && r.tap_mismatch && r.tap_mismatch.stream === r.surface_calls && r.tap_mismatch.tap === f.tap.calls;
    named.add(r);
    if (olderRunner) explained.push(`${line}; the row kept the stream's count as an older runner read it, and the transcript read today agrees with the tap`);
    else if (rowAgrees && (died || !graded(r))) explained.push(line);
    else bad.push(line);
  }
  if (bad.length) {
    status = 'FAIL';
    evidence.push(listing(`${bad.length} row(s) where the tap, the transcript and the row disagree:`, bad));
  }
  if (explained.length) {
    status = worse(status, 'WARN');
    evidence.push(
      listing(
        `${explained.length} row(s) whose counts disagree for a reason the files show (the server died, the attempt was cut off, or an older runner counted):`,
        explained
      )
    );
  }
  if (flagged.length) evidence.push(listing('rows carrying tap_mismatch: ', flagged, { n: 12, inline: true }));
  // A death a line above names already is not named again.
  const died = rows.filter((r) => facts.get(r)?.tap?.died && !named.has(r));
  if (rows.some((r) => facts.get(r)?.tap?.died)) status = worse(status, 'WARN');
  if (died.length) {
    evidence.push(
      listing(
        `${died.length} row(s) whose server died during the attempt, their counts agreeing:`,
        died.map((r) => `${rowName(r)}: ${serverExitText(facts.get(r).tap.died)}${r.invalid ? `, invalid (${r.invalid})` : ''}`)
      )
    );
  }
  const killed = counted(rows.filter((r) => facts.get(r)?.tap?.killed).map((r) => r.condition));
  if (Object.keys(killed).length) {
    evidence.push(`tap logs ending in the exit record the harness wrote, the tap killed before its server closed: ${tally(killed)}`);
  }
  const slow = counted(rows.filter((r) => facts.get(r)?.tap?.stopKilled).map((r) => r.condition));
  if (Object.keys(slow).length) {
    evidence.push(`servers still running 1.5s after the stop signal, which the tap then killed with SIGKILL: ${tally(slow)}`);
  }
  if (noTap) {
    status = worse(status, 'WARN');
    evidence.push(`${noTap} graded row(s) without a tap log${meta.tap == null ? ' (not recorded: the run predates the tap)' : ''}`);
  }
  if (noStream) {
    status = worse(status, 'WARN');
    evidence.push(`${noStream} row(s) with a tap log and no transcript`);
  }
  if (!compared && status === 'PASS') return { status: 'WARN', summary: 'no row has both a tap log and a transcript (not recorded)', evidence };
  return { status, summary: `${compared} row(s)' surface calls compared tool by tool${bad.length ? `, ${bad.length} disagree` : ''}`, evidence };
}

// The rows of one task and repeat faced the same first pick per scope in every
// condition, read from row.draws and, for a row without it, its state file.
function checkDraws({ meta, results, facts }) {
  const conditions = new Set(conditionsOf(meta) ?? rowConditions(results));
  if (conditions.size < 2) return { status: 'N/A', summary: 'one condition: no rows to pair', evidence: [] };
  const evidence = [];
  let status = 'PASS';
  const mismatchedCopies = [];
  const drawsOf = (r) => {
    const own = Array.isArray(r.draws) ? r.draws : null;
    const kept = facts.get(r)?.state?.draws ?? null;
    if (own && kept && JSON.stringify(own) !== JSON.stringify(kept)) mismatchedCopies.push(rowName(r));
    return own ?? kept;
  };
  const groups = new Map();
  for (const r of results) {
    if (r.task === '(condition)') continue;
    const k = `${r.task}#${r.rep ?? 1}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const differ = [];
  const incomparable = [];
  let paired = 0;
  let drewNothing = 0;
  let extra = 0;
  for (const [k, rows] of groups) {
    const name = k.replace(/#(\d+)$/, (_, n) => (meta.repeat > 1 ? ` (r${n})` : ''));
    const logs = rows.map((r) => [r, drawsOf(r)]);
    const without = logs.filter(([, d]) => !d).map(([r]) => r.condition);
    const present = new Set(rows.map((r) => r.condition));
    const absent = [...conditions].filter((c) => !present.has(c));
    if (without.length || absent.length) {
      incomparable.push(
        `${name}: ${[without.length && `no draw log on ${without.join(', ')}`, absent.length && `no row for ${absent.join(', ')}`].filter(Boolean).join('; ')}`
      );
      if (logs.filter(([, d]) => d).length < 2) continue;
    }
    const keyed = logs.filter(([, d]) => d).map(([r, d]) => [r, drawKey(d)]);
    extra += keyed.filter(([, d]) => d.extra).length;
    if (keyed.every(([, d]) => d.key === '[]')) drewNothing++;
    if (new Set(keyed.map(([, d]) => d.key)).size > 1) {
      differ.push(`${name}: ${keyed.map(([r, d]) => `${r.condition} ${d.key}`).join(' | ').slice(0, 400)}`);
    } else paired++;
  }
  if (!meta.seed) {
    return {
      status: 'WARN',
      summary: `unseeded: each arm drew its own variants, so ${differ.length} of ${paired + differ.length} task repeat(s) differ by design`,
      evidence: differ.length ? [listing('task repeats whose draws differ:', differ, { n: 6 })] : [],
    };
  }
  if (differ.length) {
    status = 'FAIL';
    evidence.push(listing(`${differ.length} task repeat(s) whose conditions faced different draws under seed ${meta.seed}:`, differ));
  }
  if (mismatchedCopies.length) {
    status = 'FAIL';
    evidence.push(listing(`${mismatchedCopies.length} row(s) whose row.draws is not the state file's draw log: `, mismatchedCopies, { inline: true }));
  }
  if (incomparable.length) {
    status = worse(status, 'WARN');
    evidence.push(listing(`${incomparable.length} task repeat(s) whose draws cannot be compared:`, incomparable, { n: 10 }));
  }
  if (extra) evidence.push(`${extra} row(s) drew a scope again in a later session; each is compared on its first pick per scope`);
  return {
    status,
    summary:
      `${paired} of ${groups.size} task repeat(s) faced the same draws in every condition (${drewNothing} drew nothing)` +
      `${meta.interleave ? ', interleaved' : ', not interleaved'}, seed ${meta.seed}`,
    evidence,
  };
}

// What each condition's browser measured in the preflight is what meta.envPins
// pins, and conditions of one tool measured alike but for the Firefox a
// --devtools-firefox pin gave one of them.
function checkEnv({ meta }) {
  if (!meta.env) return { status: 'WARN', summary: 'meta.env not recorded: the run predates the browser pins of 2026-09-19', evidence: [] };
  const pins = meta.envPins ?? {};
  const evidence = [];
  let status = 'PASS';
  const measured = Object.entries(meta.env).filter(([, e]) => !e.unmeasured);
  for (const [c, e] of Object.entries(meta.env)) {
    if (e.unmeasured) {
      status = worse(status, 'WARN');
      evidence.push(`${c} unmeasured: ${e.unmeasured}`);
    }
  }
  const headed = pins.devtoolsWindow === 'the headed grid cell';
  const unpinned = [];
  for (const [label, read] of ENV_COMPARED) {
    const pin = pins[PINNED[label]];
    if (PINNED[label] && pin == null) unpinned.push(label);
    for (const [c, e] of measured) {
      if (pin == null || read(e) === pin) continue;
      if (headed && label === 'viewport' && toolOf(c) === 'firefox-devtools-mcp') {
        status = worse(status, 'WARN');
        evidence.push(`${c} viewport ${read(e)}: a headed window sized to its grid cell, not the pinned ${pin}`);
      } else {
        status = 'FAIL';
        evidence.push(`${c} ${label} is ${read(e)}, pinned to ${pin}`);
      }
    }
    const values = measured.map(([c, e]) => [c, JSON.stringify(read(e) ?? null)]);
    if (new Set(values.map(([, v]) => v)).size < 2) continue;
    const byTool = new Map();
    for (const [c, v] of values) byTool.set(toolOf(c), [...(byTool.get(toolOf(c)) ?? []), v]);
    const withinTool = [...byTool.values()].some((vs) => new Set(vs).size > 1);
    const line = `${label} differs: ${values.map(([c, v]) => `${c} ${v}`).join(', ')}`;
    // A --devtools-firefox pin (meta.devtoolsFirefox) runs its label on another
    // Firefox by design, and the A/B reports name the build difference; the
    // version still has to agree among the labels that share a pin.
    const pinOf = (c) => meta.devtoolsFirefox?.[bareCondition(c)]?.spec ?? null;
    const byPin = new Map();
    for (const [c, v] of values) byPin.set(`${toolOf(c)}|${pinOf(c)}`, [...(byPin.get(`${toolOf(c)}|${pinOf(c)}`) ?? []), v]);
    const pinned = label === 'Firefox' && withinTool && [...byPin.values()].every((vs) => new Set(vs).size === 1);
    if (pinned) {
      status = worse(status, 'WARN');
      const pins = values.filter(([c]) => pinOf(c)).map(([c]) => `${c} to ${pinOf(c)}`);
      evidence.push(`${line}, between conditions of one tool, as --devtools-firefox pinned ${pins.join(', ')}`);
    } else if (withinTool) {
      status = 'FAIL';
      evidence.push(`${line}, between conditions of one tool`);
    } else if (label === 'Firefox' || pin == null) {
      status = worse(status, 'WARN');
      evidence.push(`${line}${label === 'Firefox' ? ' (the one setting left unpinned: each tool drives its own build)' : ' (not pinned in this run)'}`);
    }
  }
  if (pins.acceptLanguage) {
    const want = String(pins.acceptLanguage).split(',').map((s) => s.trim()).filter(Boolean);
    for (const [c, e] of measured) {
      const header = String(e.acceptLanguage ?? '').split(',').map((s) => s.split(';')[0].trim()).filter(Boolean);
      const languages = e.languages ?? null;
      if (JSON.stringify(header) !== JSON.stringify(want)) {
        status = 'FAIL';
        evidence.push(`${c} Accept-Language ${e.acceptLanguage ?? 'none'} names ${header.join(',') || 'nothing'}, pinned to ${want.join(',')}`);
      }
      if (languages && JSON.stringify(languages) !== JSON.stringify(want)) {
        status = 'FAIL';
        evidence.push(`${c} navigator.languages ${languages.join(',')}, pinned to ${want.join(',')}`);
      }
    }
  } else unpinned.push('Accept-Language');
  if (unpinned.length) {
    status = worse(status, 'WARN');
    evidence.push(`not pinned in this run: ${unpinned.join(', ')}`);
  }
  for (const d of meta.rerunEnvDrift ?? []) {
    status = worse(status, 'WARN');
    evidence.push(`differs from ${meta.rerunFailed}, the run this tops up: ${d}`);
  }
  return { status, summary: `${measured.length} condition(s) measured against ${Object.keys(pins).length ? 'meta.envPins' : 'no pins'}`, evidence };
}

// Each condition's rows ran one Firefox build, the one the preflight measured,
// and one tool build, the one meta records: the version, instructions and
// tools/list every row's tap log shows.
function checkBuilds({ meta, results, facts }) {
  const evidence = [];
  let status = 'PASS';
  const rows = results.filter((r) => r.task !== '(condition)');
  const conditions = [...new Set(rows.map((r) => r.condition))];
  const browsers = browserBuilds(rows);
  for (const c of conditions) {
    const bare = bareCondition(c);
    const seen = browsers[c] ?? [];
    const preflight = meta.env?.[bare]?.build ?? null;
    if (!seen.length) {
      status = worse(status, 'WARN');
      evidence.push(`${c}: the Firefox build each row ran not recorded`);
    } else if (seen.length > 1) {
      status = 'FAIL';
      evidence.push(`${c} ran ${seen.length} Firefox builds: ${seen.map((b) => `${b.version} ${b.buildID} (${b.rows} rows)`).join(' then ')}`);
    } else if (preflight && (preflight.version !== seen[0].version || preflight.buildID !== seen[0].buildID || preflight.binary !== seen[0].binary)) {
      status = 'FAIL';
      evidence.push(`${c}: the rows ran ${seen[0].binary} ${seen[0].version} ${seen[0].buildID}, the preflight measured ${preflight.binary} ${preflight.version} ${preflight.buildID}`);
    }
    const tapped = rows.filter((r) => r.condition === c && facts.get(r)?.tap);
    if (!tapped.length) continue;
    const surface = meta.surfaces?.[bare] ?? null;
    const facet = (label, read, want, record = 'initialize record', why = 'the tap predates it') => {
      const logged = tapped.filter((r) => read(facts.get(r).tap) !== undefined);
      if (logged.length < tapped.length) {
        status = worse(status, 'WARN');
        evidence.push(`${c}: ${label} not recorded in ${tapped.length - logged.length} tap log(s), which hold no ${record} (${why})`);
      }
      if (!logged.length) return;
      const values = counted(logged.map((r) => String(read(facts.get(r).tap))));
      const distinct = Object.keys(values);
      if (distinct.length > 1) {
        status = 'FAIL';
        evidence.push(`${c} rows saw ${distinct.length} ${label}s: ${tally(values)}`);
      } else if (want !== undefined && distinct[0] !== String(want)) {
        status = 'FAIL';
        evidence.push(`${c} rows saw ${label} ${distinct[0]}, meta records ${want}`);
      }
    };
    // playwright-mcp's initialize reply names the playwright-core it runs on.
    facet('server version', (t) => t.version, (toolOf(c) === 'playwright-mcp' ? surface?.core?.version : surface?.version) ?? undefined);
    facet(
      'tools/list hash',
      (t) => t.toolsHash,
      surface?.tools?.hash ?? undefined,
      'tools/list reply',
      'the client never listed the tools, as the scripted backend\'s drivers do not, or the tap predates the record'
    );
    facet(
      'instructions hash',
      (t) => t.instructions,
      surface?.tools && 'instructions' in surface.tools ? surface.tools.instructions?.sha256 ?? null : undefined,
      'instructions in their initialize record'
    );
  }
  const builds = meta.builds ?? [];
  const bySha = new Map();
  for (const b of builds) {
    const k = `${b.sha256}|${b.walkerSha256}`;
    bySha.set(k, [...(bySha.get(k) ?? []), b]);
  }
  for (const list of bySha.values()) {
    if (list.length > 1) evidence.push(`one build under ${list.length} labels: ${list.map(buildName).join(', ')} (${list[0].version}, dist ${String(list[0].sha256).slice(0, 12)})`);
  }
  for (const d of meta.rerunBuildDrift ?? []) {
    status = worse(status, 'WARN');
    evidence.push(`differs from ${meta.rerunFailed}, the run this tops up: ${d}`);
  }
  const tappedRows = rows.filter((r) => facts.get(r)?.tap).length;
  if (!tappedRows) {
    status = worse(status, 'WARN');
    evidence.push('tool builds per row not recorded: no tap logs');
  }
  return { status, summary: `${conditions.length} condition(s); ${tappedRows} row(s)' tap logs name their server build`, evidence };
}

// What identifies the code a run measured is recorded: each surface's tools/list
// and instructions, each firefox-devtools-mcp build's content hashes, the task
// definitions, the eval commit, the SDKs and the extractor.
function checkIdentity({ meta }) {
  const evidence = [];
  let status = 'PASS';
  const missing = (what) => {
    status = worse(status, 'WARN');
    evidence.push(`${what} not recorded`);
  };
  const conditions = meta.conditions ? String(meta.conditions).split(',').filter(Boolean) : Object.keys(meta.surfaces ?? {});
  if (!meta.surfaces) missing('meta.surfaces (tool versions and hashes)');
  for (const c of conditions) {
    const s = meta.surfaces?.[c];
    if (!meta.surfaces) break;
    if (!s) {
      missing(`${c}'s surface`);
      continue;
    }
    if (s.source === '--mcp-command') evidence.push(`${c} ran --mcp-command ${s.command}: no content hash of its build`);
    if (!s.tools) missing(`${c} tools/list (count, schema chars, hash)`);
    else {
      if (!s.tools.hash || s.tools.schemaChars == null) missing(`${c} tools/list hash or schema size`);
      if (!('instructions' in s.tools)) missing(`${c} server instructions`);
    }
    if (toolOf(c) === 'firefox-devtools-mcp' && s.source !== '--mcp-command' && (!s.sha256 || !s.walkerSha256)) missing(`${c} dist and walker sha256`);
    if (toolOf(c) === 'playwright-mcp' && !s.core?.coreBundle) missing(`${c} playwright-core bundle hashes`);
  }
  const tasks = Array.isArray(meta.tasks) ? meta.tasks : [];
  if (!meta.taskHashes) missing('meta.taskHashes');
  else {
    const unhashed = tasks.filter((t) => !/^[0-9a-f]{16}$/.test(meta.taskHashes[t] ?? ''));
    if (unhashed.length) {
      status = 'FAIL';
      evidence.push(listing(`${unhashed.length} selected task(s) without a hash: `, unhashed, { inline: true }));
    }
  }
  if (!meta.git?.commit) missing('the eval commit');
  const evalClean = meta.git?.dirtyFiles && meta.git.diffSha256 == null && !meta.git.diffError;
  if (meta.git?.dirty && !evalClean) {
    status = worse(status, 'WARN');
    evidence.push(
      `the eval tree at ${String(meta.git.commit).slice(0, 10)} was dirty` +
        (meta.git.dirtyFiles ? ` (${meta.git.dirtyFiles.length} file(s), eval diff sha256 ${String(meta.git.diffSha256 ?? meta.git.diffError).slice(0, 12)})` : ', its edits unrecorded')
    );
  }
  if (!meta.sdks) missing('the agent SDK versions');
  if (!meta.extractor) missing('the extractor');
  const hashed = tasks.filter((t) => meta.taskHashes?.[t]).length;
  return {
    status,
    summary: `${conditions.length} surface(s), ${hashed} of ${tasks.length} task(s) hashed, eval ${String(meta.git?.commit ?? 'unrecorded').slice(0, 10)}`,
    evidence,
  };
}

// Which version of the rule in `paths` a run's recorded verdicts came from,
// against this checkout's: 'changed' when the files differ from the run's
// eval commit, 'dirty' when they do not but the run's tree carried an edit to
// them or edits it did not record, 'unrecorded' for a run that predates the
// commit record, 'same' when the run ran this rule, and 'unknown' when this
// checkout's git cannot compare. A verdict today's rule does not reproduce is
// a WARN under the first three and a FAIL under the others.
const CHANGED = new Map();
// Outside a work tree `git diff` exits 1 as if the files differed.
let inWorkTree = null;
function ruleVersion(meta, paths) {
  const commit = meta.git?.commit;
  if (!commit) return 'unrecorded';
  inWorkTree ??= spawnSync('git', ['-C', REPO, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout?.trim() === 'true';
  if (!inWorkTree) return 'unknown';
  const key = `${commit}:${paths.join(',')}`;
  if (!CHANGED.has(key)) {
    const r = spawnSync('git', ['-C', REPO, 'diff', '--quiet', commit, '--', ...paths], { encoding: 'utf8' });
    CHANGED.set(key, r.status === 0 ? false : r.status === 1 ? true : null);
  }
  const changed = CHANGED.get(key);
  if (changed == null) return 'unknown';
  if (changed) return 'changed';
  return dirtyIn(meta.git, paths) ? 'dirty' : 'same';
}
// Whether a run's tree (meta.git) was dirty in a file under `paths`, files or
// directories, or dirty without recording its files. A dirtyFiles entry is
// "XY path", or "XY from -> to" for a rename or copy.
export function dirtyIn(git, paths) {
  if (!git?.dirty) return false;
  if (!git.dirtyFiles) return true;
  const under = (path, p) => {
    const root = p.replace(/\/+$/, '');
    return path === root || path.startsWith(`${root}/`);
  };
  return git.dirtyFiles.some((entry) => String(entry).slice(3).split(' -> ').some((path) => paths.some((p) => under(path, p))));
}
const excused = (version) => ['changed', 'dirty', 'unrecorded'].includes(version);
const ruleNote = (meta, version, what, then) => {
  const at = String(meta.git?.commit).slice(0, 10);
  return {
    changed: `: ${what} changed since ${at}, so these compare today's rule with the run's (${then})`,
    dirty: `: the run's tree at ${at} was dirty${meta.git?.dirtyFiles ? ` in ${what}` : ' with edits it did not record'}, so its rule cannot be told from today's (${then})`,
    same: `, with ${what} as it stood at ${at}`,
    unrecorded: `: the run recorded no eval commit, so which ${what} it ran is not recorded (${then})`,
    unknown: `, and which ${what} the run ran cannot be told (this checkout's git lacks its eval commit ${at})`,
  }[version];
};

const INVALID_REASONS = {
  'no-surface-calls': (r) => (r.surface_calls ?? 0) === 0,
  'foreign-browser': (r) => (r.foreign_browser?.sessions ?? 0) > 0,
  'codex-isolation': (r) => Array.isArray(r.codex_isolation) && r.codex_isolation.length > 0,
};

// Invalid, shell-assisted and foreign-browser rows are counted and each carries
// its reason, a row that meets a rule is marked by it, and the marks recompute
// from the state files; an error row names its error.
function checkValidity({ dir, meta, results, facts }) {
  const evidence = [];
  let status = 'PASS';
  const fail = (line) => {
    status = 'FAIL';
    evidence.push(line);
  };
  const rows = results.filter((r) => r.task !== '(condition)');
  const invalid = rows.filter((r) => r.invalid);
  const reasons = counted(invalid.map((r) => r.invalid));
  for (const r of invalid) {
    const backed = INVALID_REASONS[r.invalid];
    if (!backed) fail(`${rowName(r)}: invalid for an unknown reason "${r.invalid}"`);
    else if (!backed(r)) fail(`${rowName(r)}: invalid (${r.invalid}), and the row does not show it`);
    else if (r.invalid === 'foreign-browser') {
      const first = r.foreign_browser.first?.[0];
      evidence.push(`${rowName(r)}: foreign-browser, ${r.foreign_browser.sessions} session(s) by ${r.foreign_browser.method}${first ? `, first ${first.path} (${first.why})` : ''}`);
    } else if (r.invalid === 'codex-isolation') evidence.push(`${rowName(r)}: codex-isolation, ${r.codex_isolation.slice(0, 2).join('; ')}`);
    else evidence.push(`${rowName(r)}: ${r.invalid}${r.error ? `, error ${String(r.error).slice(0, 80)}` : ''}`);
  }
  for (const r of rows.filter((x) => !x.invalid)) {
    if (graded(r) && r.surface_calls === 0) fail(`${rowName(r)}: no surface call and not marked invalid`);
    if ((r.foreign_browser?.sessions ?? 0) > 0 && !r.infra) fail(`${rowName(r)}: ${r.foreign_browser.sessions} foreign browser session(s) and not marked invalid`);
    if (Array.isArray(r.codex_isolation) && r.codex_isolation.length && !r.infra) fail(`${rowName(r)}: codex isolation problems and not marked invalid`);
  }
  const foreignErrors = rows.filter((r) => r.foreign_browser?.error);
  for (const r of foreignErrors) fail(`${rowName(r)}: the foreign-browser check threw: ${r.foreign_browser.error}`);
  const unchecked = rows.filter((r) => graded(r) && r.foreign_browser === null);
  const predates = rows.filter((r) => graded(r) && r.foreign_browser === undefined);
  if (unchecked.length) {
    status = worse(status, 'WARN');
    evidence.push(`${unchecked.length} graded row(s) unchecked for a foreign browser (an untagged browser under --no-tap)`);
  }
  if (predates.length) {
    status = worse(status, 'WARN');
    evidence.push(`foreign_browser not recorded on ${predates.length} graded row(s) (report.mjs checks them from their state files)`);
  }
  // A verdict that differs from today's reading of the same files is a FAIL
  // unless the rule itself changed since the run.
  const disagree = (list, paths, then) => {
    if (!list.length) return;
    const version = ruleVersion(meta, paths);
    status = excused(version) ? worse(status, 'WARN') : 'FAIL';
    evidence.push(listing(`${list.length} row(s) whose recorded verdict today's rule does not reproduce${ruleNote(meta, version, paths.join(' and '), then)}:`, list));
  };
  let recomputed = 0;
  const foreignDiffer = [];
  for (const r of rows) {
    const again = facts.get(r)?.state?.foreign;
    if (!again || again.error || !r.foreign_browser || r.foreign_browser.error) continue;
    recomputed++;
    if (again.sessions !== r.foreign_browser.sessions) {
      foreignDiffer.push(`${rowName(r)}${r.invalid ? ` (invalid: ${r.invalid})` : ''}: ${r.foreign_browser.sessions} foreign session(s) recorded, ${again.sessions} from its state file by ${again.method}`);
    }
  }
  disagree(foreignDiffer, ['eval/scripts/foreign-browser.mjs'], 'the row keeps the verdict it was reported with');
  const assisted = rows.map((r) => [r, shellAssistedOf(r, dir)]).filter(([, a]) => a);
  for (const [r, a] of assisted) {
    if (!a.requests || !a.paths?.length) fail(`${rowName(r)}: shell-assisted with no request named`);
    else evidence.push(`${rowName(r)}: shell-assisted, ${a.requests} request(s): ${a.paths.join(', ')}${r.success ? ', passed' : ''}`);
  }
  let shellChecked = 0;
  const noShellField = rows.filter((r) => graded(r) && !('shell_assisted' in r) && r.backend !== 'scripted').length;
  const shellDiffer = [];
  for (const r of rows) {
    const kept = facts.get(r)?.state?.shell;
    if (kept === undefined || !('shell_assisted' in r)) continue;
    shellChecked++;
    if ((kept?.requests ?? 0) !== (r.shell_assisted?.requests ?? 0)) {
      shellDiffer.push(`${rowName(r)}: shell_assisted records ${r.shell_assisted?.requests ?? 0} request(s), its state file's ledger ${kept?.requests ?? 0}`);
    }
  }
  disagree(shellDiffer, ['eval/scripts/row-evidence.mjs', 'sites'], 'the reports read the recorded flag');
  if (noShellField) {
    status = worse(status, 'WARN');
    evidence.push(`shell_assisted not recorded on ${noShellField} graded row(s) (read from their state files)`);
  }
  const errors = rows.filter((r) => r.error);
  const unexplained = errors.filter((r) => !String(r.error).trim());
  for (const r of unexplained) fail(`${rowName(r)}: an error row with no error text`);
  const infra = errors.filter((r) => r.infra).length;
  return {
    status,
    summary:
      `${invalid.length} invalid${invalid.length ? ` (${tally(reasons)})` : ''}, ${assisted.length} shell-assisted, ` +
      `${rows.filter((r) => (r.foreign_browser?.sessions ?? 0) > 0).length} foreign-browser, ${errors.length} error row(s) (${infra} infra); ` +
      `${recomputed} foreign-browser and ${shellChecked} shell verdict(s) recomputed from state files`,
    evidence,
  };
}

// Every codex row records the tool mode it ran in, what code mode did (its
// rollout's requests are its turns), and no isolation problem outside the
// rows marked invalid for it.
function checkCodex({ dir, meta, results }) {
  const rows = results.filter((r) => backendOf(r, meta) === 'codex' && r.task !== '(condition)');
  if (!rows.length) return { status: 'N/A', summary: 'no codex rows', evidence: [] };
  const evidence = [];
  let status = 'PASS';
  const policy = meta.isolation?.toolPolicy?.codex;
  if (!policy?.codexHome) {
    status = 'FAIL';
    evidence.push('codex ran without its own CODEX_HOME (before b9ff01d): agents could read the operator\'s ~/.codex and call its MCP servers');
  }
  const done = rows.filter(graded);
  const noMode = done.filter((r) => !r.tool_mode);
  const noCode = done.filter((r) => !r.code_mode);
  const want = policy?.toolMode;
  const otherMode = done.filter((r) => r.tool_mode && want && r.tool_mode !== want);
  const isolation = rows.filter((r) => Array.isArray(r.codex_isolation) && r.codex_isolation.length);
  if (noMode.length) {
    status = worse(status, 'WARN');
    evidence.push(`tool_mode not recorded on ${noMode.length} row(s) (the run predates it; ${want ? `meta says ${want}` : 'the shipped code_mode_only'})`);
  }
  if (noCode.length) {
    status = worse(status, 'WARN');
    evidence.push(listing(`code_mode not recorded on ${noCode.length} row(s) (the reports read it from the rollout): `, noCode.map(rowName), { n: 6, inline: true }));
  }
  if (otherMode.length) {
    status = 'FAIL';
    evidence.push(listing(`${otherMode.length} row(s) ran another tool mode than meta's ${want}: `, otherMode.map((r) => `${rowName(r)} ${r.tool_mode}`), { n: 6, inline: true }));
  }
  // An isolation problem on an invalid or infra row is out of every number;
  // one on any other row is in them (validity names it too).
  const problem = (r) => `${rowName(r)}${r.invalid ? ` (invalid: ${r.invalid})` : r.infra ? ' (infra)' : ''}: ${r.codex_isolation.slice(0, 2).join('; ')}`;
  const excluded = isolation.filter((r) => r.invalid || r.infra);
  const inNumbers = isolation.filter((r) => !r.invalid && !r.infra);
  if (inNumbers.length) {
    status = 'FAIL';
    evidence.push(listing(`${inNumbers.length} row(s) with codex isolation problems, neither invalid nor infra:`, inNumbers.map(problem), { n: 6 }));
  }
  if (excluded.length) {
    status = worse(status, 'WARN');
    evidence.push(listing(`${excluded.length} row(s) with codex isolation problems, left out of the numbers as invalid or infra:`, excluded.map(problem), { n: 6 }));
  }
  // The backend counts tool calls + 1 when the rollout's totals are not the
  // run's usage, since such a rollout missed requests.
  const fellBack = [];
  const miscounted = [];
  for (const r of done.filter((x) => x.code_mode && x.turns !== x.code_mode.requests)) {
    const covers = rolloutCoversRow(r, dir);
    const line = `${rowName(r)} ${r.turns} vs ${r.code_mode.requests}`;
    if (covers === null) fellBack.push(`${line} (rollout not on disk)`);
    else if (!covers) fellBack.push(`${line} (its rollout's totals are not the row's usage)`);
    else if (!r.code_mode.requests) fellBack.push(`${line} (its rollout counts no request)`);
    else miscounted.push(line);
  }
  if (fellBack.length) {
    status = worse(status, 'WARN');
    evidence.push(listing(`${fellBack.length} row(s) whose turns are tool calls + 1 rather than their rollout's requests: `, fellBack, { n: 6, inline: true }));
  }
  if (miscounted.length) {
    const version = ruleVersion(meta, ['eval/backends/codex.mjs']);
    status = excused(version) ? worse(status, 'WARN') : 'FAIL';
    evidence.push(
      listing(
        `${miscounted.length} row(s) whose turns are not the requests of a rollout that holds their usage${ruleNote(meta, version, 'eval/backends/codex.mjs', 'the rows keep the turns they were run with')}: `,
        miscounted,
        { n: 6, inline: true }
      )
    );
  }
  const truncated = done.filter((r) => r.code_mode?.truncated_outputs);
  if (truncated.length) {
    evidence.push(`${truncated.length} row(s) had codex cut an output before the model read it (${truncated.reduce((n, r) => n + r.code_mode.truncated_outputs, 0)} output(s))`);
  }
  return { status, summary: `${rows.length} codex row(s)${want ? `, tool mode ${want}` : ''}`, evidence };
}

// The ask a row's extractor read: its prompt's task line.
const PROMPT_ASK = /\n\nTask: ([\s\S]*)\nAnswer concisely with the requested information\.$/;

// The quote gate re-applied to each row's extraction_raw gives the fields the
// row was graded on.
function checkQuoteGate({ meta, results }) {
  const rows = results.filter((r) => r.grading === 'fields' && r.extraction_raw != null);
  const fieldRows = results.filter((r) => r.grading === 'fields');
  if (!rows.length) {
    const backend = fieldRows.filter((r) => r.extraction?.extractor === 'backend').length;
    return fieldRows.length && fieldRows.length > backend + fieldRows.filter((r) => r.extraction_failed || r.extraction === null).length
      ? { status: 'WARN', summary: 'extraction_raw not recorded (the run predates it), so the quote gate cannot be re-applied', evidence: [] }
      : { status: 'N/A', summary: `no row went through the extractor${backend ? ` (${backend} answered with the backend's own fields)` : ''}`, evidence: [] };
  }
  const differ = [];
  const noAsk = [];
  const noAnswer = [];
  for (const r of rows) {
    const answer = r.answer_full;
    if (answer == null) {
      noAnswer.push(rowName(r));
      continue;
    }
    const ask = PROMPT_ASK.exec(r.prompt ?? '')?.[1] ?? null;
    if (ask == null) noAsk.push(rowName(r));
    const fields = enforceQuotes(r.extraction_raw, normalise(answer), normalise(ask ?? ''));
    if (JSON.stringify(fields) !== JSON.stringify(r.fields)) {
      differ.push(`${rowName(r)}${ask == null ? ' (gated without its ask)' : ''}: stored ${JSON.stringify(r.fields).slice(0, 160)}, gated now ${JSON.stringify(fields).slice(0, 160)}`);
    }
  }
  const evidence = [];
  let status = 'PASS';
  if (differ.length) {
    const version = ruleVersion(meta, ['eval/extract.mjs']);
    status = excused(version) ? 'WARN' : 'FAIL';
    evidence.push(listing(`${differ.length} row(s) whose fields the gate does not reproduce${ruleNote(meta, version, 'eval/extract.mjs', 'regrade.mjs grades them again')}:`, differ));
  }
  if (noAsk.length) {
    status = worse(status, 'WARN');
    evidence.push(`${noAsk.length} row(s) whose ask is not recorded (no row.prompt), gated without it`);
  }
  if (noAnswer.length) {
    status = worse(status, 'WARN');
    evidence.push(`answer_full not recorded on ${noAnswer.length} row(s), which cannot be gated again`);
  }
  const failedExtractions = fieldRows.filter((r) => r.extraction_failed).length;
  if (failedExtractions) evidence.push(`${failedExtractions} row(s) whose extraction failed, graded on null fields`);
  return { status, summary: `${rows.length - noAnswer.length} row(s) gated again from extraction_raw, ${differ.length} differ`, evidence };
}

const CHECKS = [
  ['rows', checkRows],
  ['files', checkFiles],
  ['totals', checkTotals],
  ['report', checkReport],
  ['costs', checkCosts],
  ['tap', checkTap],
  ['draws', checkDraws],
  ['env', checkEnv],
  ['builds', checkBuilds],
  ['identity', checkIdentity],
  ['validity', checkValidity],
  ['codex', checkCodex],
  ['quote-gate', checkQuoteGate],
];
export const HEALTH_CHECKS = CHECKS.map(([id]) => id);

// { dir, checks: [{ id, status, summary, evidence }] } for the run in `runDir`,
// each evidence entry a line or a listing (evidenceLines renders either).
// `run` is its { meta, results, totals } when the caller holds them already,
// and `skip` names checks to leave out: report.mjs, rendering report.md,
// leaves out the one that reads report.md.
export function runHealth(runDir, { run = null, skip = [] } = {}) {
  const dir = String(runDir).replace(/\/results\.json$/, '');
  let loaded = run;
  if (!loaded) {
    try {
      loaded = readRun(dir);
    } catch (error) {
      const on = existsSync(dir) ? readdirSync(dir) : [];
      return {
        dir,
        checks: [{ id: 'rows', status: 'FAIL', summary: error.message, evidence: on.length ? [`the directory holds ${on.join(', ')}`] : [] }],
      };
    }
  }
  const results = loaded.results ?? [];
  const facts = new Map();
  for (const r of results) {
    try {
      facts.set(r, rowFacts(dir, r));
    } catch (error) {
      facts.set(r, { error: String(error?.message ?? error) });
    }
  }
  const hasJson = existsSync(join(dir, 'results.json'));
  // A caller that holds the rows alone leaves the totals to results.json.
  let totals = loaded.totals ?? null;
  if (!totals && hasJson) {
    try {
      totals = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).totals ?? null;
    } catch {}
  }
  const ctx = { dir, meta: loaded.meta ?? {}, results, totals, hasJson, facts };
  const checks = CHECKS.filter(([id]) => !skip.includes(id)).map(([id, check]) => {
    try {
      return { id, ...check(ctx) };
    } catch (error) {
      return { id, status: 'FAIL', summary: `the check threw: ${error?.message ?? error}`, evidence: String(error?.stack ?? '').split('\n').slice(1, 3) };
    }
  });
  const unread = results.filter((r) => facts.get(r)?.error);
  if (unread.length) {
    checks.push({ id: 'read', status: 'FAIL', summary: `${unread.length} row(s) whose files could not be read`, evidence: [listing('rows:', unread.map((r) => `${rowName(r)}: ${facts.get(r).error}`), { n: 5 })] });
  }
  return { dir, checks, skipped: HEALTH_CHECKS.filter((id) => skip.includes(id)) };
}

// "health: 9 PASS, 2 WARN (costs, env), 1 FAIL (tap); ...", in check order,
// naming `dir` in the command that prints the evidence.
export function healthLine(health, { dir = '<run-dir>' } = {}) {
  const by = (status) => health.checks.filter((c) => c.status === status).map((c) => c.id);
  return (
    'health: ' +
    ['PASS', 'WARN', 'FAIL', 'N/A']
      .map((s) => [s, by(s)])
      .filter(([s, ids]) => ids.length || s !== 'N/A')
      .map(([s, ids]) => `${ids.length} ${s}${ids.length && s !== 'PASS' ? ` (${ids.join(', ')})` : ''}`)
      .join(', ') +
    (health.skipped?.length ? `, ${health.skipped.join(', ')} not checked here` : '') +
    `; node eval/scripts/run-health.mjs ${dir} gives the evidence`
  );
}

function printHealth(health, { all = false } = {}) {
  const lines = [`# ${health.dir}`, healthLine(health).replace(/; node .*$/, ''), ''];
  for (const c of health.checks) {
    lines.push(`${c.status.padEnd(4)}  ${c.id.padEnd(10)}  ${c.summary}`);
    const shown = all ? c.evidence : c.evidence.slice(0, 12);
    for (const e of shown) for (const l of evidenceLines(e, all)) lines.push(`        ${l}`);
    if (shown.length < c.evidence.length) lines.push(`        ... ${c.evidence.length - shown.length} more (--all)`);
  }
  return lines.join('\n');
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
  const jsonAt = args.indexOf('--json');
  const jsonOut = jsonAt === -1 ? null : args[jsonAt + 1];
  const dirs = args.filter((a, i) => !a.startsWith('--') && (jsonAt === -1 || i !== jsonAt + 1));
  if (!dirs.length || args.includes('--help')) {
    console.error('usage: node eval/scripts/run-health.mjs <run-dir>... [--all] [--json <out>]');
    process.exit(dirs.length ? 0 : 1);
  }
  const all = [];
  for (const dir of dirs) {
    const health = isRunDir(dir) || existsSync(dir) ? runHealth(dir) : { dir, checks: [{ id: 'rows', status: 'FAIL', summary: 'no such run directory', evidence: [] }] };
    all.push(health);
    console.log(printHealth(health, { all: args.includes('--all') }) + '\n');
  }
  // Every evidence line in full, whether or not --all printed them.
  const full = all.map((h) => ({ ...h, checks: h.checks.map((c) => ({ ...c, evidence: c.evidence.flatMap((e) => evidenceLines(e, true)) })) }));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(full, null, 2));
  process.exit(all.some((h) => h.checks.some((c) => c.status === 'FAIL')) ? 1 : 0);
}
