// Did the graded value ever reach the agent?
//
// A browser tool hands the agent a summarised page, and the summary drops things:
// firefox-devtools-mcp truncates a text node to about 27 characters, stops at
// depth 10, and bails past 1000 nodes. When a run fails, "the surface never showed
// the number" and "the agent read the number and got it wrong" are different
// findings, and the score alone cannot tell them apart.
//
// This reads the text a tool RETURNED to the agent and reports which values were
// present in it. It deliberately ignores what the agent itself wrote: a value the
// agent guessed, or carried over from the ask, is not evidence the surface
// delivered it.
//
// Backends stream different message shapes, so extraction is structural rather
// than per-backend: any {type:'text', text} block reached through a result-ish
// key counts, as does a shell command's aggregated output and the content of an
// Agent SDK tool_result block.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RESULT_KEYS = new Set(['result', 'tool_result', 'toolResult', 'output', 'response']);
// An assistant's own words are not evidence of what the surface showed it.
const AGENT_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'assistant_message']);

function collectText(node, underResult, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, underResult, out);
    return;
  }
  if (typeof node !== 'object') return;

  if (AGENT_ITEM_TYPES.has(node.type)) return;
  // The Agent SDK hands a tool's reply back as a tool_result block under
  // message.content: text blocks for an MCP tool, a plain string for Read, Bash
  // and errors. No result-ish key leads to it, so without this every anthropic
  // row would report every value absent.
  if (node.type === 'tool_result') {
    if (typeof node.content === 'string') out.push(node.content);
    else collectText(node.content, true, out);
    return;
  }
  if (underResult && node.type === 'text' && typeof node.text === 'string') out.push(node.text);
  // A shell tool's stdout reaches the agent the same way a tool result does.
  if (typeof node.aggregated_output === 'string') out.push(node.aggregated_output);

  for (const [key, value] of Object.entries(node)) {
    if (key === 'arguments') continue; // what the agent SENT, not what it got back
    // The SDK's structured copy of the tool_result above; reading both would
    // count every reply twice.
    if (key === 'tool_use_result') continue;
    collectText(value, underResult || RESULT_KEYS.has(key), out);
  }
}

// Everything one streamed message delivered TO the agent.
export function toolTextOf(message) {
  const out = [];
  collectText(message, false, out);
  return out.join('\n');
}

// Values are matched case-insensitively and whitespace-insensitively, because a
// snapshot re-wraps and re-cases what a page rendered.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
// A page renders 121200 as "$121,200", so a bare number would look absent from a
// snapshot that plainly showed it. Comparing both sides with digit separators
// stripped keeps the signal about what the SURFACE dropped rather than about how
// the fixture formats money.
const degroup = (s) => String(s).replace(/(\d)[,   ](?=\d{3}\b)/g, '$1');
const numeric = (v) => /^[$£€]?\s*-?[\d,.   ]+$/.test(String(v).trim());
const digits = (s) => String(s).replace(/[^\d.]/g, '');

// An absent value is ambiguous on its own: the agent may have DERIVED it (a sum
// the page never printed) or the surface may have CUT it. This is the evidence
// that separates them - the value's own opening, in the snapshot, with the
// truncator's ellipsis where the rest should be. Finding it proves the page
// rendered the value and the surface dropped the tail.
// The ellipsis need not follow the shared prefix immediately. The cut can land
// mid-word, leaving a character or two of the real value that a wrong answer does
// not share: the snapshot said "vault t..." where the truth was "vault fennel".
// So allow a few characters of slack, and require a long prefix so the slack
// cannot manufacture a match.
const ELLIPSIS = /^.{0,3}?(\.{3}|…)/;
function looksTruncated(needle, hay) {
  for (let cut = Math.min(needle.length - 1, 27); cut >= 12; cut--) {
    const head = needle.slice(0, cut);
    let from = 0;
    for (;;) {
      const at = hay.indexOf(head, from);
      if (at === -1) break;
      if (ELLIPSIS.test(hay.slice(at + head.length))) return true;
      from = at + 1;
    }
  }
  return false;
}

// An answer's sentence punctuation and quotes around a value are the agent's,
// not the page's: range-select's "...applied to 22 files." read as absent
// against a page that ended the sentence differently.
const unwrap = (s) => s.replace(/^["'“”‘’(\[]+/, '').replace(/["'“”‘’)\].,;:!?]+$/, '').trim();

// A script's result reaches the agent JSON-encoded: evaluate_script fences it
// as ```json and playwright-mcp's browser_evaluate prints it under "### Result".
// A returned "Declarations Unit\n\nPO Box 4410" therefore arrives with literal
// backslash escapes, matches nothing, and its cut copy in a snapshot made
// search-decoy read as truncated. Every string literal that holds an escape is
// decoded, and decoded again for a script that returned JSON.stringify of its
// result, as a second view of the text. A literal never spans a real newline,
// so a stray quote misaligns one line at most.
const LITERAL = /"(?:[^"\\\n]|\\.)*"/g;
export function decodedView(text) {
  const out = [];
  let layer = String(text);
  for (let depth = 0; depth < 2; depth++) {
    const decoded = [];
    for (const [literal] of layer.matchAll(LITERAL)) {
      if (!literal.includes('\\')) continue;
      try {
        decoded.push(JSON.parse(literal));
      } catch {}
    }
    if (!decoded.length) break;
    layer = decoded.join('\n');
    out.push(layer);
  }
  return out.join('\n');
}

export function reachOf(values, haystack) {
  const decoded = decodedView(haystack);
  if (decoded) haystack = `${haystack}\n${decoded}`;
  const hay = norm(haystack);
  const hayFlat = norm(degroup(haystack));
  const out = {};
  for (const v of values) {
    const needle = unwrap(norm(v));
    if (!needle) continue;
    let hit = hay.includes(needle) || hayFlat.includes(unwrap(norm(degroup(v))));
    if (!hit && numeric(v)) {
      const d = digits(v);
      // Bare digits alone would match any substring of a longer number, so
      // require a boundary on both sides.
      if (d) hit = new RegExp(`(?<![\\d.])${d.replace('.', '\\.')}(?![\\d])`).test(digits2(hayFlat));
    }
    out[v] = hit ? 'seen' : looksTruncated(needle, hay) ? 'truncated' : 'absent';
  }
  return out;
}

// Strip currency and grouping but keep the surrounding text, so boundaries still
// mean something.
const digits2 = (s) => s.replace(/[$£€]/g, '');

// Scalars worth testing. Shorter strings collide with ordinary page text, and a
// one- or two-digit number matches almost any snapshot.
export function gradedValues(fields) {
  const out = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node) || typeof node === 'object') {
      for (const v of Object.values(node)) walk(v);
      return;
    }
    const s = String(node);
    if ((typeof node === 'string' || typeof node === 'number') && s.length >= 3) out.push(s);
  };
  walk(fields);
  return [...new Set(out)];
}

// Ground truth, found without wiring anything per task: the codes a site minted
// into session state for this run. Testing these answers "was the value the
// server issued ever shown to the agent", which the agent's own answer cannot.
// The nonce is skipped - every page carries it, and nothing grades it.
const CODE = /^[A-Za-z]{2,6}-[A-Za-z0-9][A-Za-z0-9-]{2,14}$/;
// Session state also holds kebab-case slugs and enums of the code's shape that
// no page need render: same-origin (a Sec-Fetch-Site), login-after-reset (a
// stage), harbor-east and harlow-dunmere (option values), on-file (a status),
// rr-104 and zones-1-2 (fixture record ids). A code in capitals is kept, as the
// shape alone always kept it: a minted LB-B151A0, a VLT-FNYE that promo.mjs
// draws from a 32-letter alphabet and so can hold no digit, and a static SKU
// such as VAM-PRO, which its page renders. A lowercase one is kept when its body
// is six or more hex characters, the randomBytes(3) of console.mjs's dpl- and
// roles.mjs's alp- ids, whatever letters or digits a draw came out as
// (dpl-1c579d, dpl-953568), or holds a digit among five or more letters and
// digits.
function codeShaped(s) {
  if (!CODE.test(s)) return false;
  if (s === s.toUpperCase()) return true;
  const body = s.slice(s.indexOf('-') + 1);
  return /^[0-9a-f]{6,}$/i.test(body) || (/\d/.test(body) && body.replace(/[^a-z0-9]/gi, '').length >= 5);
}
export function mintedValues(state, limit = 40) {
  const found = new Set();
  const seenObjects = new WeakSet();
  const walk = (node, key) => {
    if (found.size >= limit || node == null) return;
    if (typeof node === 'string') {
      if (key !== 'nonce' && codeShaped(node)) found.add(node);
      return;
    }
    if (typeof node !== 'object') return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);
    for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  try {
    for (const session of state.sessions.values()) walk(session, null);
  } catch {
    return [];
  }
  return [...found];
}

// The graded truth of one attempt: the values its task names, when the task's
// `truth.values(state)` names them, else the codes the server minted. A truth
// that is not code-shaped, such as the rate mid-flight-rate mints into a
// response body, is found only by the task naming it, and a task that names
// its truth leaves out the codes it does not grade.
export function truthValues(state, task = null) {
  const named = task?.truth?.values;
  if (typeof named !== 'function') return mintedValues(state);
  try {
    return [...new Set((named(state) ?? []).filter((v) => v != null && v !== '').map(String))];
  } catch {
    return mintedValues(state);
  }
}

// Absent says nothing about the surface for a value the agent composed rather
// than copied: a number it computed (live-auction's 1708 is 1400 x 1.22, which
// no page prints) or prose in its own words (a summary, a recommendation, an
// address re-joined with commas). A composed value the surface cut still reads
// as truncated; one it never showed reads as derived or paraphrased.
const composedAs = (v) => (numeric(v) ? 'derived' : norm(v).split(' ').length >= 4 ? 'paraphrased' : null);

// Accumulates across a task's message stream so run.mjs can hand messages in as
// they arrive rather than re-reading the transcript afterwards.
export function createReachRecorder() {
  const chunks = [];
  let chars = 0;
  // A run can stream tens of MB of snapshots; keep only the first CAP
  // characters so a long task cannot balloon the runner's memory.
  const CAP = 24 * 1024 * 1024;
  return {
    observe(message) {
      if (chars >= CAP) return;
      const text = toolTextOf(message);
      if (!text) return;
      chunks.push(text);
      chars += text.length;
    },
    // Each value as seen, truncated or absent, or, for an absent value the
    // agent composed, derived or paraphrased. Values in `truth` are the
    // server's, never the agent's, so an absent one stays absent.
    reach(values, { truth = [] } = {}) {
      const states = reachOf(values, chunks.join('\n'));
      const server = new Set(truth.map(String));
      for (const [v, state] of Object.entries(states)) {
        if (state === 'absent' && !server.has(v)) states[v] = composedAs(v) ?? state;
      }
      return states;
    },
  };
}

// Re-analyse a finished run from its transcripts, so a past run can be asked the
// question without paying for a new one:
//   node eval/surface-reach.mjs eval/results/run-<stamp>
// Compared as real paths: import.meta.url is percent-encoded and symlink-free
// (macOS /tmp is /private/tmp), while argv[1] is neither.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { transcriptCandidates } = await import('./run-files.mjs');
  const { readStateFile } = await import('./scripts/state-file.mjs');
  const { taskInfo } = await import('./scripts/identity.mjs');
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node eval/surface-reach.mjs <run-dir>');
    process.exit(1);
  }
  const res = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  const tasks = await taskInfo();
  const blank = () => ({ seen: 0, truncated: 0, absent: 0, derived: 0, paraphrased: 0 });
  const tally = { answer: blank(), truth: blank() };
  const notable = [];
  for (const row of res.results) {
    const file = transcriptCandidates(row)
      .map((name) => join(dir, 'transcripts', name))
      .find((path) => existsSync(path));
    if (!file) continue;
    let state = null;
    try {
      if (row.state_file) ({ state } = readStateFile(join(dir, row.state_file)));
    } catch {}
    const rec = createReachRecorder();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) {
        try {
          rec.observe(JSON.parse(line));
        } catch {}
      }
    }
    // What run.mjs records on a row now: the answer's values and the attempt's
    // truth, with the truth marked as the server's.
    const truth = state ? truthValues(state, tasks.get(row.task)?.task) : [];
    const values = [...new Set([...gradedValues(row.fields ?? {}), ...truth])];
    if (!values.length) continue;
    // A codex code-mode row whose outputs the harness cut: what the model read
    // was less than the replies this reads, so "seen" there is an upper bound.
    const cutByHarness = row.code_mode?.truncated_outputs ? ` [harness cut ${row.code_mode.truncated_outputs} output(s)]` : '';
    for (const [value, reached] of Object.entries(rec.reach(values, { truth }))) {
      tally[truth.includes(value) ? 'truth' : 'answer'][reached] += 1;
      // A passing row's absent truth is mostly minted codes nothing grades
      // (reused-row's deploy ids), so only a failing row lists its truth.
      if (reached !== 'seen' && (!row.success || !truth.includes(value))) {
        notable.push(
          `${reached.padEnd(11)} ${row.success ? 'PASS' : 'FAIL'} ${row.condition}/${row.task}  ` +
            `${truth.includes(value) ? 'truth ' : ''}${JSON.stringify(value).slice(0, 60)}${cutByHarness}`
        );
      }
    }
  }
  const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`graded values the answers claimed: ${total(tally.answer)}`);
  console.log(`  seen in tool output : ${tally.answer.seen}`);
  console.log(`  truncated by surface: ${tally.answer.truncated}`);
  console.log(`  absent (never shown): ${tally.answer.absent}`);
  console.log(`  derived by the agent (an absent number): ${tally.answer.derived}`);
  console.log(`  paraphrased by the agent (absent prose): ${tally.answer.paraphrased}`);
  console.log(`truth values of the attempts: ${total(tally.truth)}`);
  console.log(`  seen in tool output : ${tally.truth.seen}`);
  console.log(`  truncated by surface: ${tally.truth.truncated}`);
  console.log(`  absent (never shown; listed below for failing rows only): ${tally.truth.absent}`);
  if (notable.length) {
    console.log('\nvalues the agent never received verbatim:');
    for (const n of notable) console.log(`  ${n}`);
  }
}
