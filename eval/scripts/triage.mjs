// Deterministic failure triage: which of the harness, the grader, the task, the
// tool or the agent a failed row points at, from signals already on disk. It
// never changes `success` and never feeds a metric; it only says where to look.
//
//   node eval/scripts/triage.mjs <run-dir>
//
// The rules fire in order and the first one names the class; every later rule
// that also fires is listed as contributing. The order puts the causes that
// void a row's evidence first (no grade, no surface, a nulled field), then the
// provable tool cause (a truncated value), then the comparison across arms,
// then the weaker tool signal (errors). A row no rule explains is
// `unattributed`, which is what a transcript judge is for.
//
// `surface-reach` fires only on a truncated value: the reply carried the value
// and cut it, which proves the surface had it. A minted value that no reply
// carried at all is listed as the contributing signal `minted-absent` instead,
// because an agent that never opened the page leaves the same trace as a
// surface that omitted the value.
//
// Old rows lack the telemetry fields, so the rules fall back to the transcript
// when one is given, and to the other arms' rows (`peers`) for the comparison.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise } from '../extract.mjs';
import { createReachRecorder, gradedValues, mintedValues } from '../surface-reach.mjs';
import { readStateFile } from './state-file.mjs';
import { rowEvents } from './events.mjs';
import { rowToolStats } from './tool-stats.mjs';

// owner: who a class points at. `tool` classes are the ones a tool change can
// move; the A/B report flags a new failure in one of them.
export const FAILURE_CLASSES = {
  infra: { owner: 'harness', about: 'never reached a grade: an API or transport error outlived the retries' },
  limit: { owner: 'agent', about: 'stopped by the wall-clock or output-token limit on every attempt' },
  error: { owner: 'harness', about: 'the backend or harness failed the attempt' },
  'validator-error': { owner: 'harness', about: 'the validator threw, so the answer was never judged' },
  'no-surface-calls': { owner: 'harness', about: 'the agent never called its own browser server' },
  extraction: { owner: 'grader', about: 'the answer holds the value, but the extracted field is null' },
  'surface-reach': { owner: 'tool', about: 'the surface cut the graded value before it reached the agent' },
  'both-arms': { owner: 'task-or-agent', about: 'every other arm failed the same task the same way' },
  'tool-errors': { owner: 'tool', about: 'calls to the surface failed during the attempt' },
  unattributed: { owner: 'unattributed', about: 'no rule fired; read the transcript' },
};
export const TOOL_CLASSES = new Set(
  Object.entries(FAILURE_CLASSES).filter(([, c]) => c.owner === 'tool').map(([k]) => k)
);
// A peer failing for one of these reasons says nothing about the task.
const VOID_CLASSES = new Set(['infra', 'limit', 'error', 'validator-error', 'no-surface-calls', 'extraction']);

const CODE = /\b[A-Za-z]{2,6}-[A-Za-z0-9][A-Za-z0-9-]{2,14}\b/g;
const degroup = (s) => String(s).replace(/(\d)[,   ](?=\d{3}\b)/g, '$1');

// Leaf paths of a fields object, with array indices folded to [] so two answers
// that list a different number of items still compare.
function leaves(node, path = '', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v) => leaves(v, `${path}[]`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) leaves(v, path ? `${path}.${k}` : k, out);
  } else {
    out.push([path, node]);
  }
  return out;
}

// The quote gate's own leaves: { value, quote } wrappers.
function rawLeaves(node, path = '', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v) => rawLeaves(v, `${path}[]`, out));
  } else if (node && typeof node === 'object') {
    if ('value' in node && 'quote' in node) out.push([path, node.value, node.quote]);
    else for (const [k, v] of Object.entries(node)) rawLeaves(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function answerHolds(answer, value) {
  if (value == null || value === '') return false;
  const hay = normalise(degroup(answer));
  const needle = normalise(degroup(String(value)));
  return needle.length >= 2 && hay.includes(needle);
}

// Which sub-checks failed, as the validator named them, plus which fields came
// back null. Two arms that fail with the same signature failed alike.
export function failureSignature(row) {
  const nulls = row.fields ? leaves(row.fields).filter(([, v]) => v == null).map(([p]) => p) : [];
  const falses = [...String(row.detail ?? '').matchAll(/\b(\w+)=false\b/g)].map((m) => m[1]);
  return [...new Set(nulls.map((p) => `null:${p}`))].concat([...new Set(falses)].sort()).sort().join(' ');
}

// Values the grader itself names in its detail string: the `key=value` pairs
// outside the `fields=` echo, split on commas. Keys that echo the answer or the
// agent's path rather than server truth are skipped, as are booleans, `none`
// and bare numbers, which any answer can contain by chance.
const ECHO_KEYS = new Set(['fields', 'claimed', 'route', 'ua', 'quotes', 'lastTries', 'outcomes']);
function detailValues(detail) {
  const text = String(detail ?? '').replace(/\bfields=[\[{][\s\S]*$/, '');
  const out = [];
  for (const [, key, value] of text.matchAll(/\b([A-Za-z][\w-]*)=([^\s;]+)/g)) {
    if (ECHO_KEYS.has(key)) continue;
    for (const v of value.split(',')) {
      if (v.length >= 4 && /^[A-Za-z0-9][\w-]*$/.test(v) && !/^(?:true|false|none|null|undefined|\d+)$/i.test(v)) out.push(v);
    }
  }
  return [...new Set(out)];
}

const holdsWord = (answer, value) =>
  new RegExp(`(?:^|[^a-z0-9])${normalise(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`).test(normalise(degroup(answer)));

// "Label: value" lines of an answer, with the value's emphasis and quotes
// stripped; `words` splits a field path's last name on camelCase.
const STOP = new Set(['the', 'and', 'for', 'was', 'are', 'with', 'from', 'this', 'that']);
const words = (s) =>
  String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
const REFUSAL = /\b(?:unknown|n\/a|none|unable|not (?:found|shown|available|visible|listed|stated)|could(?:n'?t| not)|did(?:n'?t| not)|cannot)\b/i;
function labelledValues(answer) {
  const out = [];
  for (const line of String(answer).split('\n')) {
    const m = /^[\s>*_#-]*([A-Za-z][A-Za-z0-9 ()/-]{0,48}?)[\s*_]*:\s*(.+?)\s*$/.exec(line);
    const value = m?.[2].replace(/^[*_`"'“”‘’\s]+|[*_`"'“”‘’\s.]+$/g, '');
    if (value && !REFUSAL.test(value)) out.push([words(m[1]), value]);
  }
  return out;
}

function extractionEvidence(row, peers, state) {
  if (row.extraction_failed) return `the extractor failed (${row.extraction_failed})`;
  const answer = row.answer_full ?? row.answer;
  if (!answer || !row.fields) return null;
  const nulls = new Set(leaves(row.fields).filter(([, v]) => v == null).map(([p]) => p));
  if (!nulls.size) return null;
  // The raw extraction shows the gate at work: the extractor found a value and
  // the gate nulled it, although the answer holds that value.
  for (const [path, value] of rawLeaves(row.extraction_raw)) {
    if (nulls.has(path) && value != null && answerHolds(answer, value)) {
      return `the quote gate nulled ${path}, but the answer holds ${JSON.stringify(value)}`;
    }
  }
  // Without the raw pairs, a passing arm's value for the same field stands in:
  // a static value appears verbatim, and a per-session code appears as a code of
  // the same shape that no other field of this row claims.
  const claimed = new Set(leaves(row.fields).filter(([, v]) => v != null).map(([, v]) => String(v)));
  for (const peer of peers.filter((p) => p.success && p.fields)) {
    for (const [path, value] of leaves(peer.fields)) {
      if (!nulls.has(path) || value == null) continue;
      if (answerHolds(answer, value)) {
        return `${path} is null, but the answer holds ${JSON.stringify(value)}, the value ${peer.condition} passed with`;
      }
      const prefix = /^([A-Za-z]{2,6})-/.exec(String(value))?.[1];
      if (!prefix) continue;
      const codes = [...String(answer).matchAll(CODE)]
        .map((m) => m[0])
        .filter((c) => c.startsWith(`${prefix}-`) && !claimed.has(c));
      if (codes.length) {
        return `${path} is null, but the answer holds ${codes[0]}, a ${prefix}- code like the one ${peer.condition} passed with`;
      }
    }
  }
  // With no passing peer, the grader's own truth stands in: a code the server
  // minted for this attempt (the state file), or a value the validator's detail
  // names, that the answer holds and no field claims.
  const nullList = [...nulls].join(', ');
  for (const v of state ? mintedValues(state) : []) {
    if (!claimed.has(v) && answerHolds(answer, v)) return `${nullList} is null, but the answer holds ${v}, a code the server minted for this attempt`;
  }
  for (const v of detailValues(row.detail)) {
    if (!claimed.has(v) && holdsWord(answer, v)) return `${nullList} is null, but the answer holds ${JSON.stringify(v)}, a value the validator detail names`;
  }
  // Last, the answer labels a value for the null field: "Title: ..." for
  // postTitle.
  const labelled = labelledValues(answer);
  for (const path of nulls) {
    const name = words(path.split('.').pop().replace(/\[\]$/, ''));
    const hit = labelled.find(([label]) => label.some((w) => name.includes(w)));
    if (hit) return `${path} is null, but the answer labels a value for it: ${JSON.stringify(hit[1].slice(0, 80))}`;
  }
  return null;
}

function reachStates(events, values) {
  if (!events || !values.length) return {};
  const rec = createReachRecorder();
  for (const e of events) rec.observe(e);
  return rec.reach(values);
}

// The MCP tap saw every reply, so a row that carries its counts is not second-
// guessed from the transcript.
function toolErrorEvidence(row, stats) {
  if (row.tools && typeof row.tools === 'object') {
    const failing = Object.entries(row.tools).filter(([, t]) => t?.errors > 0);
    return failing.length ? failing.map(([name, t]) => `${name} x${t.errors}`).join(', ') : null;
  }
  if (stats?.surface_errors) {
    return Object.entries(stats.tools)
      .filter(([, t]) => t.errors)
      .map(([name, t]) => `${name} x${t.errors}`)
      .join(', ');
  }
  if (stats?.friction.browser_lost) return `${stats.friction.browser_lost} browser-lost replies`;
  return null;
}

function surfaceCallCount(row, stats) {
  if (row.invalid === 'no-surface-calls') return 0;
  if (typeof row.surface_calls === 'number') return row.surface_calls;
  return stats ? stats.surface_calls : null;
}

// `events` is the row's transcript (readEvents), `peers` the other conditions'
// rows for the same task and repeat, `state` the row's server state when a
// state file was kept. Returns null for a passing row.
export function failureClass(row, events = null, { peers = [], peerClasses = null, state = null } = {}) {
  if (row.success) return null;
  const stats = events ? rowToolStats(events) : null;
  const hits = [];
  const hit = (cls, evidence) => evidence && hits.push({ class: cls, evidence });

  if (row.infra) hit('infra', String(row.error ?? 'infra'));
  if (/stopped by harness (wall limit|output-token limit)/.test(row.error ?? '')) hit('limit', row.error);
  if (row.error && !row.infra && !/stopped by harness/.test(row.error)) hit('error', row.error);
  if (row.validator_error) hit('validator-error', row.validator_error);
  const surfaceCalls = surfaceCallCount(row, stats);
  if (!row.error && surfaceCalls === 0) {
    const foreign = stats?.foreign_servers ?? {};
    const others = Object.entries(foreign).map(([s, n]) => `${s} x${n}`).join(', ');
    hit('no-surface-calls', `0 calls to its own browser server${others ? `; called ${others}` : ''}`);
  }
  hit('extraction', extractionEvidence(row, peers, state));

  const graded = gradedValues(row.fields ?? {});
  const minted = state ? mintedValues(state) : [];
  const reach = reachStates(events, [...new Set([...graded, ...minted])]);
  const cut = [
    ...(row.surface?.truncated ?? []),
    ...Object.keys(reach).filter((v) => reach[v] === 'truncated'),
  ];
  if (cut.length) hit('surface-reach', `truncated before it reached the agent: ${JSON.stringify([...new Set(cut)].slice(0, 3))}`);

  const signature = failureSignature(row);
  const alike = peers.filter((p, i) => {
    if (p.success) return false;
    const pc = peerClasses?.[i]?.class;
    return !VOID_CLASSES.has(pc) && failureSignature(p) === signature;
  });
  if (peers.length && alike.length === peers.length) {
    hit('both-arms', `${alike.map((p) => p.condition).join(', ')} failed alike (${signature || 'no field or sub-check named'})`);
  }

  hit('tool-errors', toolErrorEvidence(row, stats));

  const absentMinted = minted.filter((v) => reach[v] === 'absent');
  if (!hits.length) {
    hit(
      'unattributed',
      graded.length
        ? 'the claimed values reached the agent, or were derived; the validator detail says which check failed'
        : 'the answer claimed no graded value'
    );
  }
  const [primary, ...rest] = hits;
  const contributing = rest.map((h) => ({ class: h.class, evidence: h.evidence }));
  if (absentMinted.length && events) {
    contributing.push({
      class: 'minted-absent',
      evidence: `the server minted ${JSON.stringify(absentMinted.slice(0, 3))} and no tool reply carried it`,
    });
  }
  return {
    class: primary.class,
    owner: FAILURE_CLASSES[primary.class].owner,
    evidence: primary.evidence,
    contributing,
  };
}

const peerKey = (r) => `${r.task}#${r.rep ?? 1}`;

// Every row's triage (null for a passing row), aligned with `results`. With a
// run directory it reads each failing row's transcript and state file, and the
// transcripts of that row's peers.
export function triageRun(results, { runDir = null } = {}) {
  const byKey = new Map();
  for (const r of results) {
    const k = peerKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const eventsCache = new Map();
  const eventsOf = (r) => {
    if (!runDir) return null;
    if (!eventsCache.has(r)) eventsCache.set(r, rowEvents(runDir, r));
    return eventsCache.get(r);
  };
  const stateOf = (r) => {
    if (!runDir || !r.state_file) return null;
    const path = join(runDir, r.state_file);
    try {
      return existsSync(path) ? readStateFile(path).state : null;
    } catch {
      return null;
    }
  };
  // A peer's own failure is classified without its peers, so a harness failure
  // on one arm cannot make the other arm's failure look shared.
  const solo = new Map();
  const soloOf = (r) => {
    if (!solo.has(r)) solo.set(r, failureClass(r, eventsOf(r), { state: stateOf(r) }));
    return solo.get(r);
  };
  return results.map((row) => {
    if (row.success) return null;
    const peers = byKey.get(peerKey(row)).filter((p) => p !== row && p.condition !== row.condition);
    return failureClass(row, eventsOf(row), {
      peers,
      peerClasses: peers.map((p) => (p.success ? null : soloOf(p))),
      state: stateOf(row),
    });
  });
}

// The class a row carries, whichever shape wrote it: a triage object, a bare
// class string (row.failure_class), or none.
export function classOf(triage) {
  if (!triage) return null;
  return typeof triage === 'string' ? triage : triage.class ?? null;
}

// `partial`: the rows predate the telemetry and no transcripts were read, so
// the rules that need a transcript could not fire.
export function triageLines(results, triages, { partial = false } = {}) {
  const failed = results.map((r, i) => [r, triages[i]]).filter(([r]) => !r.success);
  if (!failed.length) return [];
  const byCondition = {};
  for (const [r, t] of failed) {
    const c = (byCondition[r.condition] ??= {});
    const cls = classOf(t) ?? 'untriaged';
    c[cls] = (c[cls] ?? 0) + 1;
  }
  const explained = failed.filter(([, t]) => classOf(t) && classOf(t) !== 'unattributed').length;
  const lines = [
    '',
    '## Failure triage',
    '',
    `Deterministic rules (eval/scripts/triage.mjs), first match wins; they never change a grade. ` +
      `${explained} of ${failed.length} failures matched a rule other than \`unattributed\`. ` +
      '`tool` classes are the ones a tool change can move.' +
      (partial
        ? ' These rows predate the telemetry and this report was rendered without their transcripts, so ' +
          'no-surface-calls, surface-reach and tool-errors could not fire; ' +
          '`node eval/scripts/triage.mjs <run-dir>` runs every rule.'
        : ''),
    '',
    '| condition | ' + Object.keys(FAILURE_CLASSES).join(' | ') + ' |',
    '|---|' + Object.keys(FAILURE_CLASSES).map(() => '---').join('|') + '|',
  ];
  for (const [condition, counts] of Object.entries(byCondition)) {
    lines.push(`| ${condition} | ${Object.keys(FAILURE_CLASSES).map((k) => counts[k] ?? 0).join(' | ')} |`);
  }
  lines.push('');
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const [r, t] of failed) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    const also = t?.contributing?.length ? `; also ${t.contributing.map((c) => c.class).join(', ')}` : '';
    lines.push(`- ${r.condition}/${task}: **${classOf(t) ?? 'untriaged'}** (${FAILURE_CLASSES[classOf(t)]?.owner ?? '?'}): ${cell(t?.evidence ?? '')}${also}`);
  }
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
  const dir = process.argv[2];
  if (!dir || !existsSync(join(dir, 'results.json'))) {
    console.error('usage: node eval/scripts/triage.mjs <run-dir>');
    process.exit(1);
  }
  const { results } = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  const triages = triageRun(results, { runDir: dir });
  const lines = triageLines(results, triages);
  console.log(lines.length ? lines.join('\n') : `${dir}: no failed rows`);
  for (const [i, t] of triages.entries()) {
    for (const c of t?.contributing ?? []) {
      console.log(`    ${results[i].condition}/${results[i].task} contributing ${c.class}: ${c.evidence}`);
    }
  }
}
