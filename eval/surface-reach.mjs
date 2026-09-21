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

// playwright-mcp's "### Ran Playwright code" section echoes the call it ran,
// the agent's own input included: pdf-bill's only reply carrying GW-B-A034C4
// was the fill('GW-B-A034C4') of a bill number the agent had read off a
// screenshot. A section runs to the next "### " line, as playwright-mcp's own
// parseSections reads it.
const CODE_ECHO = /^### Ran Playwright code\n[\s\S]*?(?=^### |(?![\s\S]))/gm;

// Everything one streamed message delivered TO the agent.
export function toolTextOf(message) {
  const out = [];
  collectText(message, false, out);
  return out.join('\n').replace(CODE_ECHO, '');
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
// The longest opening of `needle` the haystack shows cut, or null.
function truncatedHead(needle, hay) {
  for (let cut = Math.min(needle.length - 1, 27); cut >= 12; cut--) {
    const head = needle.slice(0, cut);
    let from = 0;
    for (;;) {
      const at = hay.indexOf(head, from);
      if (at === -1) break;
      if (ELLIPSIS.test(hay.slice(at + head.length))) return head;
      from = at + 1;
    }
  }
  return null;
}
const looksTruncated = (needle, hay) => truncatedHead(needle, hay) != null;
// The opening of `value` that reads as `head`, an opening of unwrap(norm(value)):
// norm folds whitespace runs and case and unwrap drops leading quotes, so the
// two lengths differ.
function openingOf(value, head) {
  const want = head.trimEnd();
  const s = String(value);
  for (let end = 1; end <= s.length; end++) {
    const n = norm(s.slice(0, end)).replace(/^["'“”‘’(\[]+/, '').trimStart();
    if (n.length >= want.length) return n.startsWith(want) ? s.slice(0, end) : null;
  }
  return null;
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

// Two more views of a reply's text, each made of the lines that need it, so a
// view of a large haystack stays small. playwright-mcp's YAML snapshot writes
// a quote inside a single-quoted scalar twice ('Don''t miss'), and a script
// that returns innerHTML hands back HTML entities undecoded (&amp;, &#39;).
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const decodeEntities = (line) =>
  line.replace(ENTITY, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const linesMatching = (text, re, fn) => Array.from(text.matchAll(re), ([line]) => fn(line)).join('\n');
const entityView = (text) => (text.includes('&') ? linesMatching(text, /^.*&(?:#x[0-9a-f]+|#\d+|[a-z]+);.*$/gim, decodeEntities) : '');
const yamlView = (text) => (text.includes("''") ? linesMatching(text, /^.*''.*$/gm, (l) => l.replaceAll("''", "'")) : '');
// Letters and digits only, every run of anything else one space, and padded,
// so a value matches as whole words. An answer joins lines the page shows
// apart: search-decoy's "Bureau of Civic Revenue, Declarations Unit, PO Box
// 4410, ..." against a script reply's two array entries, one per line. A value
// under FOLD_MIN characters folded is not tested this way, since "A-1" folds
// to words any page holds.
const fold = (s) => ` ${String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const FOLD_MIN = 12;
// The lines an answer joins can sit under nodes of their own, a JSON key
// ("text32": "PO Box 4410, ...") or a YAML one (- paragraph [ref=f2e73]: PO
// Box 4410, ...), which the fold keeps between them. A value whose comma- or
// semicolon-separated parts each appear, in order, within JOIN_SPAN
// characters of the part before, was shown.
const JOIN_SPAN = 200;
function joinedSeen(value, hayFold) {
  const parts = String(value).split(/\s*[,;\n]\s*/).map(fold).filter((p) => p.length - 2 >= 3);
  if (parts.length < 2) return false;
  for (let from = 0; ; ) {
    const at = hayFold.indexOf(parts[0], from);
    if (at === -1) return false;
    let end = at + parts[0].length;
    const inOrder = parts.slice(1).every((p) => {
      const next = hayFold.indexOf(p, end - 1);
      if (next === -1 || next - end > JOIN_SPAN) return false;
      end = next + p.length;
      return true;
    });
    if (inOrder) return true;
    from = at + 1;
  }
}

export function reachOf(values, haystack) {
  const views = [decodedView(haystack), yamlView(haystack), entityView(haystack)].filter(Boolean);
  if (views.length) haystack = [haystack, ...views].join('\n');
  const hay = norm(haystack);
  const hayFlat = norm(degroup(haystack));
  let hayFold = null;
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
    if (!hit && fold(v).length - 2 >= FOLD_MIN) {
      hayFold ??= fold(degroup(haystack));
      hit = hayFold.includes(fold(degroup(v))) || joinedSeen(degroup(v), hayFold);
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

// Whether a message hands a tool's reply back holding an image: a screenshot,
// or a Read of one, as the Agent SDK's tool_result block or codex's MCP result
// carries it.
function carriesImage(node, underResult = false) {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => carriesImage(child, underResult));
  if (AGENT_ITEM_TYPES.has(node.type)) return false;
  if ((underResult || node.type === 'tool_result') && node.type === 'image') return true;
  return Object.entries(node).some(
    ([key, value]) => key !== 'arguments' && key !== 'tool_use_result' && carriesImage(value, underResult || node.type === 'tool_result' || RESULT_KEYS.has(key))
  );
}

// Where the page that carries a value is known, and when it loaded. The
// session-state object that holds the value also holds a string under an
// address key, the value itself included: a key under which some object's
// string, eight or more letters and digits of at least two kinds, appears in
// a request path the ledger recorded. pdf-bill's bills each hold a `token`
// that /api/utility/bill.pdf?b=<token> carries, and faceted-search's postings
// an `id` that the vacancy page's URL does. Returns a function of a value:
// null when its page is not known this way, else the ledger times of the
// requests for that page, empty when nothing loaded it. A value its page
// shows and another page shows too, such as a list, reads as shown by its
// own page alone.
const opaque = (s) =>
  s.length >= 8 && s.length <= 64 && /^[\w-]+$/.test(s) && [/[A-Z]/, /[a-z]/, /\d/].filter((re) => re.test(s)).length >= 2;
export function pageLoadsOf(state) {
  const ledger = Array.isArray(state?.ledger) ? state.ledger.filter((e) => typeof e?.path === 'string') : [];
  if (!ledger.length) return () => null;
  const holders = new Map();
  const byKey = new Map();
  const seen = new WeakSet();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== 'string') walk(v);
      else if (!Array.isArray(node)) {
        if (!holders.has(v)) holders.set(v, []);
        holders.get(v).push(node);
        if (k !== 'nonce' && opaque(v)) (byKey.get(k) ?? byKey.set(k, new Set()).get(k)).add(v);
      }
    }
  };
  try {
    for (const session of state.sessions.values()) walk(session);
  } catch {
    return () => null;
  }
  const requested = (s) => ledger.some((e) => e.path.includes(s));
  const addressKeys = [...byKey].filter(([, strings]) => [...strings].some(requested)).map(([k]) => k);
  if (!addressKeys.length) return () => null;
  return (value) => {
    const addresses = (holders.get(String(value)) ?? []).flatMap((o) =>
      addressKeys.map((k) => o[k]).filter((s) => typeof s === 'string' && opaque(s))
    );
    if (!addresses.length) return null;
    return ledger.filter((e) => addresses.some((a) => e.path.includes(a))).map((e) => e.at ?? null);
  };
}

// Accumulates across a task's message stream so run.mjs can hand messages in as
// they arrive rather than re-reading the transcript afterwards.
export function createReachRecorder() {
  const chunks = [];
  let chars = 0;
  // When each reply holding an image arrived, null for a stream without
  // timestamps (codex's).
  const imageTimes = [];
  let hay = null;
  const normalised = () => (hay?.chunks === chunks.length ? hay.text : (hay = { chunks: chunks.length, text: norm(chunks.join('\n')) }).text);
  // A run can stream tens of MB of snapshots; keep only the first CAP
  // characters so a long task cannot balloon the runner's memory.
  const CAP = 24 * 1024 * 1024;
  return {
    observe(message) {
      if (carriesImage(message)) imageTimes.push(Date.parse(message?.timestamp ?? '') || null);
      if (chars >= CAP) return;
      const text = toolTextOf(message);
      if (!text) return;
      chunks.push(text);
      chars += text.length;
    },
    // Each value as seen, truncated or absent. An absent value is
    // `image-only` when an image reply may have shown it (flaky-retry's
    // total, room-booking's PCR-076981 and promo-zindex's code were read off
    // screenshots), and otherwise, for a value the agent composed, derived or
    // paraphrased. Values in `truth` are the server's, never the agent's, so
    // one no image could have shown stays absent. Given the attempt's `state`,
    // a value whose page pageLoadsOf knows needs an image reply at or after a
    // load of that page, or after any load on a stream without timestamps, so
    // a bill pdf-bill's agent never opened no longer reads as image-only
    // beside one screenshot of the reading form. Every other value, and every
    // value without state, as run.mjs records a row, needs only an image reply
    // somewhere in the row.
    reach(values, { truth = [], state = null } = {}) {
      const states = reachOf(values, chunks.join('\n'));
      const server = new Set(truth.map(String));
      const loadsOf = state ? pageLoadsOf(state) : () => null;
      const imaged = (v) => {
        const loads = loadsOf(v);
        if (loads == null) return imageTimes.length > 0;
        return imageTimes.some((i) => loads.some((at) => i == null || at == null || i >= at));
      };
      for (const [v, reached] of Object.entries(states)) {
        if (reached !== 'absent') continue;
        states[v] = imaged(v) ? 'image-only' : (!server.has(v) && composedAs(v)) || reached;
      }
      return states;
    },
    // The opening of `value` a reply showed cut, as the value spells it, or
    // null.
    shownHead(value) {
      const head = truncatedHead(unwrap(norm(value)), normalised());
      return head ? openingOf(value, head) : null;
    },
    // Whether `value`, a claimed text ending in an ellipsis, is a cut a reply
    // showed: with its ellipsis dropped, it is, give or take ELLIPSIS's three
    // characters of slack, an opening a reply showed followed by an ellipsis.
    // An agent that shortened a value a reply showed whole wrote a cut of its
    // own, which no reply holds.
    showsCut(value) {
      const bare = unwrap(norm(String(value).replace(/\s*(?:\.{3}|…)\s*$/, '')));
      const head = truncatedHead(bare, normalised());
      return head != null && head.length >= bare.length - 3;
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
  const { codeModeOf } = await import('./scripts/row-evidence.mjs');
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node eval/surface-reach.mjs <run-dir>');
    process.exit(1);
  }
  const res = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  const tasks = await taskInfo();
  const blank = () => ({ seen: 0, truncated: 0, absent: 0, 'image-only': 0, derived: 0, paraphrased: 0 });
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
    // truth, with the truth marked as the server's, and image-only read
    // against the state's page loads (createReachRecorder's reach).
    const truth = state ? truthValues(state, tasks.get(row.task)?.task) : [];
    const values = [...new Set([...gradedValues(row.fields ?? {}), ...truth])];
    if (!values.length) continue;
    // A codex code-mode row whose outputs the harness cut: what the model read
    // was less than the replies this reads, so "seen" there is an upper bound.
    const harnessCut = codeModeOf(row, dir)?.truncated_outputs;
    const cutByHarness = harnessCut ? ` [harness cut ${harnessCut} output(s)]` : '';
    for (const [value, reached] of Object.entries(rec.reach(values, { truth, state }))) {
      tally[truth.includes(value) ? 'truth' : 'answer'][reached] += 1;
      // A passing row's absent truth is mostly codes the server minted for a
      // task that names no truth and grades none of them, so only a failing
      // row lists its truth.
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
  console.log(`  image-only (absent from text, beside an image reply that could have shown it): ${tally.answer['image-only']}`);
  console.log(`  derived by the agent (an absent number): ${tally.answer.derived}`);
  console.log(`  paraphrased by the agent (absent prose): ${tally.answer.paraphrased}`);
  console.log(`truth values of the attempts: ${total(tally.truth)}`);
  console.log(`  seen in tool output : ${tally.truth.seen}`);
  console.log(`  truncated by surface: ${tally.truth.truncated}`);
  console.log(`  absent (never shown; listed below for failing rows only): ${tally.truth.absent}`);
  console.log(`  image-only (absent from text, beside an image reply that could have shown it): ${tally.truth['image-only']}`);
  if (notable.length) {
    console.log('\nvalues the agent never received verbatim:');
    for (const n of notable) console.log(`  ${n}`);
  }
}
