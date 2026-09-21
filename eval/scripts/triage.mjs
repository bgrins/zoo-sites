// Deterministic failure triage: which of the harness, the grader, the task, the
// tool or the agent a failed row points at, from signals already on disk. It
// never changes `success` and never feeds a metric; it only says where to look.
//
//   node eval/scripts/triage.mjs <run-dir>
//
// The rules fire in order and the first one names the class; every later rule
// that also fires is listed as contributing. The order puts the causes that
// void a row's evidence first (no grade, no surface, a shell that fetched from
// a graded route, a nulled or reworded field), then the provable tool cause (a
// truncated value), then the comparisons across arms, then the weaker signals
// (tool errors, outputs the harness cut). A row no rule explains is `unattributed`, which is what a
// transcript judge is for.
//
// `surface-reach` fires only on a truncated value: the reply carried the value
// and cut it, which proves the surface had it, or on a claimed value that is
// the cut text a reply showed, ending in the truncator's "...". A truth value
// that no reply carried at all is listed as the contributing signal `minted-absent` instead,
// because an agent that never opened the page leaves the same trace as a
// surface that omitted the value. `surface-absent` names the tool only for a
// truth the task names (truth.values), which the task grades, and only when the
// other surface under the same backend passed and received its own truth while
// no arm passed on this surface. For the generic minted codes the same
// comparison is listed as contributing, beside `minted-absent`. A truth no text
// reply carried, on a row whose replies held an image, is listed as
// `image-only` instead of either.
//
// Old rows lack the telemetry fields, so the rules fall back to the transcript
// when one is given, and to the other arms' rows (`peers`) for the comparison.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise } from '../extract.mjs';
import { blameToolErrors, createCallRecorder } from '../mcp-tap.mjs';
import { createReachRecorder, gradedValues, truthValues } from '../surface-reach.mjs';
import { readStateFile } from './state-file.mjs';
import { rowEvents, SURFACE_SERVER } from './events.mjs';
import { shellAssistedOf, withRolloutFacts } from './row-evidence.mjs';
import { rowToolStats } from './tool-stats.mjs';

// owner: who a class points at. `tool` classes are the ones a tool change can
// move; the A/B report flags a new failure in one of them.
export const FAILURE_CLASSES = {
  infra: { owner: 'harness', about: 'never reached a grade: an API or transport error outlived the retries' },
  limit: { owner: 'agent', about: 'stopped by the wall-clock or output-token limit on every attempt' },
  error: { owner: 'harness', about: 'the backend or harness failed the attempt' },
  'validator-error': { owner: 'harness', about: 'the validator threw, so the answer was never judged' },
  'no-surface-calls': { owner: 'harness', about: 'the agent never called its own browser server' },
  'shell-assisted': { owner: 'harness', about: "the agent's shell got answers from a graded fixture route, so the row did not measure the surface alone" },
  extraction: { owner: 'grader', about: 'the answer holds the value, but the extracted field is null' },
  paraphrase: { owner: 'grader', about: 'the extractor reworded a value its quote gives verbatim, and the validator graded the rewording' },
  'surface-reach': { owner: 'tool', about: 'the surface cut the graded value before it reached the agent, or the answer is its cut text' },
  'both-arms': { owner: 'task-or-agent', about: 'every other arm failed the same task the same way' },
  'surface-absent': { owner: 'tool', about: 'no reply carried the graded truth, while a peer arm that passed received its own' },
  'tool-errors': { owner: 'tool', about: "a call to the surface failed and nothing later made it good, or it carried the attempt's truth" },
  'harness-truncated': { owner: 'harness', about: 'the harness cut tool outputs before the model read them, so a value a reply carried may never have reached the agent' },
  unattributed: { owner: 'unattributed', about: 'no rule fired; read the transcript' },
};
export const TOOL_CLASSES = new Set(
  Object.entries(FAILURE_CLASSES).filter(([, c]) => c.owner === 'tool').map(([k]) => k)
);
// A peer failing for one of these reasons says nothing about the task.
const VOID_CLASSES = new Set([
  'infra', 'limit', 'error', 'validator-error', 'no-surface-calls', 'shell-assisted', 'extraction', 'paraphrase',
  'harness-truncated',
]);

const CODE = /\b[A-Za-z]{2,6}-[A-Za-z0-9][A-Za-z0-9-]{2,14}\b/g;
// A value ending in a truncator's mark: firefox-devtools-mcp's "..." after 27
// characters, or an ellipsis.
const CUT_TAIL = /\S\s?(?:\.\.\.|…)$/;
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
// stripped, each beside the words of the heading it sits under: the last
// markdown heading or line that ends in a colon ("**Store 3 (Marrowgate):**"
// above "- Price: $274.50"). `words` splits a name on camelCase.
const STOP = new Set(['the', 'and', 'for', 'was', 'are', 'with', 'from', 'this', 'that']);
const words = (s) =>
  String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
const REFUSAL = /\b(?:unknown|n\/a|none|unable|not (?:found|shown|available|visible|listed|stated)|could(?:n'?t| not)|did(?:n'?t| not)|cannot)\b/i;
export function labelledValues(answer) {
  const out = [];
  let heading = [];
  for (const line of String(answer).split('\n')) {
    const bare = line.replace(/[\s*_]+$/, '');
    if (/^\s*#{1,6}\s/.test(line) || (bare.endsWith(':') && bare.length > 1)) {
      heading = words(bare);
      continue;
    }
    const m = /^[\s>*_#-]*([A-Za-z][A-Za-z0-9 ()/-]{0,48}?)[\s*_]*:\s*(.+?)\s*$/.exec(line);
    const value = m?.[2].replace(/^[*_`"'“”‘’\s]+|[*_`"'“”‘’\s.]+$/g, '');
    if (value && !REFUSAL.test(value)) out.push({ label: words(m[1]), heading, value });
  }
  return out;
}

// Whether a labelled line names the field at `path` as a whole: its label
// names the leaf, and the label or its heading names every key below the top
// level. perStore.Gadgetron.price needs "gadgetron" beside a "Price:" label:
// price-compare's "**Price:** $274.50" was the winner's price, and matching
// the leaf alone filed the row as a nulled Gadgetron price.
export function labelNames(path, { label, heading }) {
  const keys = path.split('.').map((k) => k.replace(/\[\]$/, '')).filter(Boolean);
  const leaf = words(keys.at(-1));
  if (!label.some((w) => leaf.includes(w))) return false;
  const pool = new Set([...label, ...heading]);
  return keys.slice(1, -1).every((k) => words(k).some((w) => pool.has(w)));
}

// A value the prompt carries is no sign the agent found anything, since any
// answer can repeat the ask: range-select's answer held "26-14", the batch the
// prompt names, and was filed as a nulled receipt. The prompt's URLs are left
// out and the value must stand as a whole token, or the 12 and 127 of a
// loopback address would match an answer's count, by the port a run drew.
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const inPrompt = (row, value) =>
  Boolean(row.prompt) && normalise(degroup(String(value))).length >= 2 && holdsWord(String(row.prompt).replace(URL_TEXT, ' '), degroup(String(value)));

const DETAIL_ECHO = /\bfields=[\[{][\s\S]*$/;
const failedChecks = (detail) =>
  [...new Set([...String(detail ?? '').replace(DETAIL_ECHO, '').matchAll(/\b(\w+)=false\b/g)].map((m) => m[1]))].sort().join(' ');

// Whether the row passes once `patch` (field path to value) is written into its
// fields, by re-running its task's validator against the attempt's state, as
// regrade.mjs does. Null when that cannot be told: no validator, state or
// patchable path, or a re-run of the row as stored that does not fail the same
// checks, as a validator does that closes over the loopback URLs of another
// base or was rewritten since.
function passesWith(row, task, state, patch) {
  if (typeof task?.validate !== 'function' || !state || !row.fields || !patch.size) return null;
  if ([...patch.keys()].some((p) => p.includes('[]'))) return null;
  const answer = row.answer_full ?? row.answer ?? '';
  const grade = (fields) => {
    try {
      return task.validate(answer, { pages: { state } }, fields);
    } catch {
      return null;
    }
  };
  const stored = grade(row.fields);
  if (!stored || stored.pass || failedChecks(stored.detail) !== failedChecks(row.detail)) return null;
  const fields = structuredClone(row.fields);
  for (const [path, value] of patch) {
    const keys = path.split('.');
    let node = fields;
    for (const k of keys.slice(0, -1)) node = node?.[k];
    if (!node || typeof node !== 'object') return null;
    node[keys.at(-1)] = value;
  }
  const patched = grade(fields);
  return patched ? Boolean(patched.pass) : null;
}

// Without a validator to re-run: the failed sub-checks (`<name>Ok=false`) that
// are about none of `paths`, a check being about a field when a word of one
// name starts the other's (salaryOk and seniorRoleSalary, refOk and
// confirmationReference). A check named for the answer as a whole (valuesOk,
// fieldsOk) is about every field. One of the rest fails the row by itself, so
// the field cannot be what failed it: template-count answered 12 roles against
// 11 (countOk=false) whatever became of its null seniorRoleSalary.
const WHOLE_ANSWER = new Set(['value', 'values', 'field', 'fields', 'answer', 'answers', 'all', 'claim', 'claims']);
function otherFailedChecks(row, paths) {
  const fieldWords = [...new Set([...paths].flatMap((p) => p.split(/[.[\]]+/).flatMap(words)))];
  const about = (w) => WHOLE_ANSWER.has(w) || fieldWords.some((f) => f.startsWith(w) || w.startsWith(f));
  const text = String(row.detail ?? '').replace(DETAIL_ECHO, '');
  return [...text.matchAll(/\b(\w+)Ok=false\b/g)]
    .map((m) => m[1])
    .filter((name) => {
      const w = words(name);
      return w.length && !w.some(about);
    });
}

// The values the answer holds for its null fields, strongest evidence first,
// as { path, value, evidence }; `path` is null where the evidence names no one
// field.
function extractionCandidates(row, peers, state, task, nulls) {
  const answer = row.answer_full ?? row.answer;
  const out = [];
  const add = (path, value, evidence) => out.push({ path, value, evidence });
  // A value read out of text is a string; a number-shaped one is regraded as the
  // number a schema field holds.
  const fromText = (v) => (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : v);
  const holds = (value) => answerHolds(answer, value) && !inPrompt(row, value);
  // The raw extraction shows the gate at work: the extractor found a value and
  // the gate nulled it, although the answer holds that value.
  for (const [path, value] of rawLeaves(row.extraction_raw)) {
    if (nulls.has(path) && value != null && holds(value)) {
      add(path, value, `the quote gate nulled ${path}, but the answer holds ${JSON.stringify(value)}`);
    }
  }
  // Without the raw pairs, a passing arm's value for the same field stands in:
  // a static value appears verbatim, and a per-session code appears as a code of
  // the same shape that no other field of this row claims.
  const claimed = new Set(leaves(row.fields).filter(([, v]) => v != null).map(([, v]) => String(v)));
  const codesIn = (text, prefix) =>
    [...String(text).matchAll(CODE)]
      .map((m) => m[0])
      .filter((c) => (!prefix || c.startsWith(`${prefix}-`)) && !claimed.has(c) && !inPrompt(row, c));
  const peerPrefix = new Map();
  for (const peer of peers.filter((p) => p.success && p.fields)) {
    for (const [path, value] of leaves(peer.fields)) {
      if (!nulls.has(path) || value == null) continue;
      if (holds(value)) {
        add(path, value, `${path} is null, but the answer holds ${JSON.stringify(value)}, the value ${peer.condition} passed with`);
        continue;
      }
      const prefix = /^([A-Za-z]{2,6})-/.exec(String(value))?.[1];
      if (!prefix) continue;
      peerPrefix.set(path, prefix);
      const codes = codesIn(answer, prefix);
      if (codes.length) {
        add(path, codes[0], `${path} is null, but the answer holds ${codes[0]}, a ${prefix}- code like the one ${peer.condition} passed with`);
      }
    }
  }
  // With no passing peer, the grader's own truth stands in: this attempt's
  // truth (a value its task names, or a code the server minted, from the state
  // file), or a value the validator's detail names, that the answer holds and
  // no field claims.
  const nullList = [...nulls].join(', ');
  for (const v of state ? truthValues(state, task) : []) {
    if (!claimed.has(v) && holds(v)) add(null, fromText(v), `${nullList} is null, but the answer holds ${v}, this attempt's truth from the server`);
  }
  for (const v of detailValues(row.detail)) {
    if (!claimed.has(v) && holdsWord(answer, v) && !inPrompt(row, v)) {
      add(null, fromText(v), `${nullList} is null, but the answer holds ${JSON.stringify(v)}, a value the validator detail names`);
    }
  }
  // Last, the answer labels a value for the null field: "Title: ..." for
  // postTitle. A field a passing arm filled with a code needs a code of that
  // shape under the label: range-select's "Label receipt: “Retain 7 years”
  // applied to 20 files" names the label it applied, not the LB- receipt.
  const labelled = labelledValues(answer);
  for (const path of nulls) {
    const hit = labelled.find(
      (l) =>
        labelNames(path, l) && !inPrompt(row, l.value) && (!peerPrefix.has(path) || codesIn(l.value, peerPrefix.get(path)).length)
    );
    if (hit) add(path, fromText(hit.value), `${path} is null, but the answer labels a value for it: ${JSON.stringify(hit.value.slice(0, 80))}`);
  }
  return out;
}

// The field was what failed the row: re-graded with the values the answer
// holds, the row passes. A validator that cannot be re-run here falls back to
// the names of its failed checks.
function extractionEvidence(row, peers, state, task) {
  if (row.extraction_failed) return `the extractor failed (${row.extraction_failed})`;
  const answer = row.answer_full ?? row.answer;
  if (!answer || !row.fields) return null;
  const nulls = new Set(leaves(row.fields).filter(([, v]) => v == null).map(([p]) => p));
  if (!nulls.size) return null;
  const candidates = extractionCandidates(row, peers, state, task, nulls);
  if (!candidates.length) return null;
  const patch = new Map();
  for (const c of candidates) {
    for (const path of c.path ? [c.path] : nulls.size === 1 ? nulls : []) if (!patch.has(path)) patch.set(path, c.value);
  }
  const regraded = passesWith(row, task, state, patch);
  if (regraded === false) return null;
  if (regraded == null && otherFailedChecks(row, nulls).length) return null;
  return candidates[0].evidence + (regraded ? ', and the row passes with it' : '');
}

// The extractor reworded a value its quote gives verbatim, and validators read
// values: phish-pick's quote "CaldmoorBenk Holdings, N.A." came back as the
// value "Misspelled bank name in footer", and the validator credited one of the
// four tells. Only a value of three words or more counts, since a shorter one is
// a normalisation the schema asks for (a date, a name, an enum), and only one
// with fewer than half its words in its quote: the passing rows of popup-storm,
// injection-bait, locale-notice and search-decoy re-join or trim their quote
// (an address rejoined with commas), and 80% or more of their values' words
// are in it, where at most 44% of phish-pick's reworded tells' words are.
function paraphraseEvidence(row) {
  const content = (s) => normalise(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const reworded = rawLeaves(row.extraction_raw).filter(([, value, quote]) => {
    if (typeof value !== 'string' || typeof quote !== 'string') return false;
    if (normalise(value).split(' ').length < 3 || normalise(quote).includes(normalise(value))) return false;
    const inQuote = new Set(content(quote));
    const own = content(value);
    return own.length > 0 && own.filter((w) => inQuote.has(w)).length / own.length < 0.5;
  });
  if (!reworded.length || otherFailedChecks(row, reworded.map(([p]) => p)).length) return null;
  const [path, value, quote] = reworded[0];
  return (
    `the extractor reworded ${reworded.length} value(s) instead of quoting them: ${path} is ` +
    `${JSON.stringify(value.slice(0, 60))}, its quote ${JSON.stringify(quote.slice(0, 60))}`
  );
}

// This attempt's truth reached none of its replies, while a peer that passed
// found its own truth in its replies: mid-flight-rate's rate lived only in a
// response body that firefox-devtools-mcp's get_network_request never
// returned, and playwright-mcp's browser_network_request printed its arm's.
// Each arm is tested on its own truth, since a minted value differs per
// session. Only the other surface under the same backend compares, since
// another model drives a surface differently, and a pass on this surface
// under any backend shows the surface can deliver the truth: codex's
// range-select on firefox-devtools-mcp cut its receipt with its own
// slice(-500), and Claude's passed on that surface. A shell-assisted pass
// shows neither, since its truth may have come from the shell's own output.
// `absent` is the reach states that count as no reply carrying a value.
const surfaceOfCondition = (c) => String(c).split('/').pop();
function peerReachEvidence(row, truth, reach, peers, peerEvidence, task, absent = ['absent']) {
  if (!truth.length || !truth.every((v) => absent.includes(reach[v]))) return null;
  const surface = surfaceOfCondition(row.condition);
  const earned = (p, i) => p.success && !peerEvidence[i]?.shell;
  if (peers.some((p, i) => earned(p, i) && surfaceOfCondition(p.condition) === surface)) return null;
  for (const [i, peer] of peers.entries()) {
    const { events, state } = peerEvidence[i] ?? {};
    if (!earned(peer, i) || !events || !state) continue;
    if ((peer.backend ?? null) !== (row.backend ?? null) || surfaceOfCondition(peer.condition) === surface) continue;
    const theirs = truthValues(state, task);
    const seen = Object.entries(reachStates(events, theirs, theirs)).filter(([, s]) => s === 'seen').map(([v]) => v);
    if (seen.length) {
      return (
        `no reply carried this attempt's truth ${JSON.stringify(truth.slice(0, 3))}, while ${peer.condition}, ` +
        `which passed, received its own (${JSON.stringify(seen.slice(0, 2))})`
      );
    }
  }
  return null;
}

function reachRecorderOf(events) {
  const rec = createReachRecorder();
  for (const e of events) rec.observe(e);
  return rec;
}
function reachStates(events, values, truth = []) {
  if (!events || !values.length) return {};
  return reachRecorderOf(events).reach(values, { truth });
}

// A surface error is charged to the tool only when nothing later made it good
// or it carried the attempt's truth (mcp-tap.mjs blameToolErrors): stored runs
// charged codex's range-select to a take_snapshot error four working scripts
// recovered from, while the agent's own slice(-500) cut the receipt. A row's
// transcript is re-read with today's rules, since a recorded blame used the
// rules of its day: the claimed values, and recovery by the same tool only. A
// row without one is read as it recorded its blame, and only a row that
// recorded none counts any error.
function toolErrorEvidence(row, stats, events, truth) {
  const describe = (blamed) =>
    blamed.length ? blamed.map((b) => `${b.tool} #${b.seq} (${b.why})`).join(', ') : null;
  if (events) {
    const recorder = createCallRecorder(SURFACE_SERVER);
    for (const e of events) recorder.observe(e);
    return describe(blameToolErrors(recorder.summary().tool_errors, truth));
  }
  if (Array.isArray(row.tool_errors?.blamed)) return describe(row.tool_errors.blamed);
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
// state file was kept, `task` its definition, whose truth.values names the
// graded truth, `peerEvidence` each peer's { events, state, shell }, and
// `shell` the row's scripts/row-evidence.mjs shellAssistedOf. Returns null for
// a passing row.
export function failureClass(
  row,
  events = null,
  { peers = [], peerClasses = null, state = null, task = null, peerEvidence = [], shell = null } = {}
) {
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
  if (shell) hit('shell-assisted', `${shell.requests} shell request(s) answered on graded routes: ${shell.paths.join(', ')}`);
  hit('extraction', extractionEvidence(row, peers, state, task));
  hit('paraphrase', paraphraseEvidence(row));

  const graded = gradedValues(row.fields ?? {});
  const truth = state ? truthValues(state, task) : [];
  const rec = events ? reachRecorderOf(events) : null;
  const values = [...new Set([...graded, ...truth])];
  const reach = rec && values.length ? rec.reach(values, { truth }) : {};
  // The row's own record is what the recorder that wrote it saw; a transcript
  // is re-read with today's, which decodes a script result's JSON escapes.
  const cut = events ? Object.keys(reach).filter((v) => reach[v] === 'truncated') : row.surface?.truncated ?? [];
  if (cut.length) hit('surface-reach', `truncated before it reached the agent: ${JSON.stringify([...new Set(cut)].slice(0, 3))}`);
  // A claimed value that is the surface's cut text itself, ellipsis and all,
  // reads as seen, since the reply held exactly that: news-extract's titles
  // and modal-escape's "I built a spreadsheet that ..." were copied from
  // firefox-devtools-mcp's 27-character cut. Only a reply that shows that cut
  // makes it the surface's; an agent can shorten a value it saw whole.
  const copiedCuts = rec ? graded.filter((v) => CUT_TAIL.test(v) && rec.showsCut(v)) : [];
  if (!cut.length && copiedCuts.length) hit('surface-reach', `the answer claimed the surface's cut text: ${JSON.stringify(copiedCuts.slice(0, 3))}`);

  const signature = failureSignature(row);
  const alike = peers.filter((p, i) => {
    if (p.success) return false;
    const pc = peerClasses?.[i]?.class;
    return !VOID_CLASSES.has(pc) && failureSignature(p) === signature;
  });
  if (peers.length && alike.length === peers.length) {
    hit('both-arms', `${alike.map((p) => p.condition).join(', ')} failed alike (${signature || 'no field or sub-check named'})`);
  }
  // A truth the task names is one it grades, so a peer that received its own
  // makes the class. Minted codes include ones nothing grades or shows, so
  // there the comparison only contributes.
  const peerReach = events ? peerReachEvidence(row, truth, reach, peers, peerEvidence, task) : null;
  const namedTruth = typeof task?.truth?.values === 'function';
  if (namedTruth) hit('surface-absent', peerReach);

  hit('tool-errors', toolErrorEvidence(row, stats, events, truth));
  const harnessCut = row.code_mode?.truncated_outputs ?? 0;
  if (harnessCut) {
    hit('harness-truncated', `codex cut ${harnessCut} tool output(s) before the model read them; a value this reads in a reply may never have reached the agent`);
  }

  const absentTruth = truth.filter((v) => reach[v] === 'absent');
  const imageTruth = truth.filter((v) => reach[v] === 'image-only');
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
  if (absentTruth.length && events && !(namedTruth && peerReach)) {
    contributing.push({
      class: 'minted-absent',
      evidence: `the server minted ${JSON.stringify(absentTruth.slice(0, 3))} and no tool reply carried it`,
    });
    if (peerReach) contributing.push({ class: 'surface-absent', evidence: peerReach });
  }
  // A truth no text reply carried, on a row whose replies held an image, may
  // have been shown in one, so surface-absent and minted-absent do not fire on
  // it; the comparison with the peers is kept here, read as text alone.
  if (imageTruth.length && events) {
    const textPeer = peerReachEvidence(row, truth, reach, peers, peerEvidence, task, ['absent', 'image-only']);
    contributing.push({
      class: 'image-only',
      evidence:
        `no text reply carried ${JSON.stringify(imageTruth.slice(0, 3))}; only an image reply could have shown it` +
        (textPeer ? `; ${textPeer}` : ''),
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
// transcripts and state files of that row's peers. `tasks` (identity.mjs
// taskInfo, or a Map of id to task) supplies a task's truth.values; without it
// the truth is the codes the server minted.
export function triageRun(stored, { runDir = null, tasks = null } = {}) {
  // A stored codex row gets the code_mode its rollout holds, which
  // harness-truncated reads, whichever report asks.
  const results = stored.map((r) => withRolloutFacts(r, runDir));
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
  const stateCache = new Map();
  const stateOf = (r) => {
    if (!runDir || !r.state_file) return null;
    if (!stateCache.has(r)) {
      const path = join(runDir, r.state_file);
      let state = null;
      try {
        state = existsSync(path) ? readStateFile(path).state : null;
      } catch {}
      stateCache.set(r, state);
    }
    return stateCache.get(r);
  };
  const taskOf = (r) => {
    const t = tasks?.get?.(r.task) ?? tasks?.[r.task] ?? null;
    return t?.task ?? t;
  };
  // A peer's own failure is classified without its peers, so a harness failure
  // on one arm cannot make the other arm's failure look shared.
  const solo = new Map();
  const soloOf = (r) => {
    if (!solo.has(r)) solo.set(r, failureClass(r, eventsOf(r), { state: stateOf(r), task: taskOf(r), shell: shellAssistedOf(r, runDir) }));
    return solo.get(r);
  };
  return results.map((row) => {
    if (row.success) return null;
    const peers = byKey.get(peerKey(row)).filter((p) => p !== row && p.condition !== row.condition);
    return failureClass(row, eventsOf(row), {
      peers,
      peerClasses: peers.map((p) => (p.success ? null : soloOf(p))),
      state: stateOf(row),
      task: taskOf(row),
      peerEvidence: peers.map((p) => (p.success ? { events: eventsOf(p), state: stateOf(p), shell: shellAssistedOf(p, runDir) } : null)),
      shell: shellAssistedOf(row, runDir),
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
          'no-surface-calls, surface-reach, surface-absent and tool-errors could not fire; ' +
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
  const { taskInfo } = await import('./identity.mjs');
  const triages = triageRun(results, { runDir: dir, tasks: await taskInfo() });
  const lines = triageLines(results, triages);
  console.log(lines.length ? lines.join('\n') : `${dir}: no failed rows`);
  for (const [i, t] of triages.entries()) {
    for (const c of t?.contributing ?? []) {
      console.log(`    ${results[i].condition}/${results[i].task} contributing ${c.class}: ${c.evidence}`);
    }
  }
}
