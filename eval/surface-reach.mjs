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
// key counts, as does a shell command's aggregated output.

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
  if (underResult && node.type === 'text' && typeof node.text === 'string') out.push(node.text);
  // A shell tool's stdout reaches the agent the same way a tool result does.
  if (typeof node.aggregated_output === 'string') out.push(node.aggregated_output);

  for (const [key, value] of Object.entries(node)) {
    if (key === 'arguments') continue; // what the agent SENT, not what it got back
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

export function reachOf(values, haystack) {
  const hay = norm(haystack);
  const hayFlat = norm(degroup(haystack));
  const out = {};
  for (const v of values) {
    const needle = norm(v);
    if (!needle) continue;
    let hit = hay.includes(needle) || hayFlat.includes(norm(degroup(v)));
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
export function mintedValues(state, limit = 40) {
  const found = new Set();
  const seenObjects = new WeakSet();
  const walk = (node, key) => {
    if (found.size >= limit || node == null) return;
    if (typeof node === 'string') {
      if (key !== 'nonce' && CODE.test(node)) found.add(node);
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

// Accumulates across a task's message stream so run.mjs can hand messages in as
// they arrive rather than re-reading the transcript afterwards.
export function createReachRecorder() {
  const chunks = [];
  let chars = 0;
  // A run can stream tens of MB of snapshots; keep the tail bounded so a long
  // task cannot balloon the runner's memory.
  const CAP = 24 * 1024 * 1024;
  return {
    observe(message) {
      if (chars >= CAP) return;
      const text = toolTextOf(message);
      if (!text) return;
      chunks.push(text);
      chars += text.length;
    },
    get chars() {
      return chars;
    },
    reach(values) {
      return reachOf(values, chunks.join('\n'));
    },
  };
}

// Re-analyse a finished run from its transcripts, so a past run can be asked the
// question without paying for a new one:
//   node eval/surface-reach.mjs eval/results/run-<stamp>
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node eval/surface-reach.mjs <run-dir>');
    process.exit(1);
  }
  const res = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  const tally = { seen: 0, truncated: 0, absent: 0 };
  const notable = [];
  for (const row of res.results) {
    if (!row.fields) continue;
    const file = join(dir, 'transcripts', `${row.condition}--${row.task}.jsonl`);
    if (!existsSync(file)) continue;
    const rec = createReachRecorder();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) {
        try {
          rec.observe(JSON.parse(line));
        } catch {}
      }
    }
    const values = gradedValues(row.fields);
    if (!values.length) continue;
    for (const [value, state] of Object.entries(rec.reach(values))) {
      tally[state] += 1;
      if (state !== 'seen') {
        notable.push(
          `${state.padEnd(9)} ${row.success ? 'PASS' : 'FAIL'} ${row.condition}/${row.task}  ` +
            JSON.stringify(value).slice(0, 60)
        );
      }
    }
  }
  console.log(`graded values checked: ${tally.seen + tally.truncated + tally.absent}`);
  console.log(`  seen in tool output : ${tally.seen}`);
  console.log(`  truncated by surface: ${tally.truncated}`);
  console.log(`  absent (derived, or never shown): ${tally.absent}`);
  if (notable.length) {
    console.log('\nvalues the agent never received verbatim:');
    for (const n of notable) console.log(`  ${n}`);
  }
}
