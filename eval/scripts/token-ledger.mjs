// Where a row's tokens go. A row's total input is the sum of every model
// request's input, and each request re-reads what the requests before it read,
// so the ledger splits that sum into what each token paid for:
//
//   prefix    the first request's input, which every later request carries
//             again: the system prompt, the tool definitions, the server's
//             instructions, the task prompt; times the requests
//   replies   each tool reply the agent read, by tool, times the requests
//             that carried it after it arrived; a codex code-mode script's
//             output is split among the MCP calls it made, its ALL_TOOLS
//             catalog print (catalog) and its shell calls
//   own       the agent's own earlier output, read again by each later request
//   other     the growth neither explains: history the backend dropped or
//             rewrote (negative), or context it added (tool definitions that
//             joined late, a reminder)
//
// and its output into reasoning, text and tool-call arguments, and its input
// into uncached tokens, cache writes and cache reads.
//
// The ledger reads each request's own usage: a codex rollout's token_count
// events (rollouts/<transcript>), and an Agent SDK transcript's per-message
// usage and message_delta events. Between two requests the input grows by
// what the first request wrote plus what came back to it, and the telescoping
// sum
//
//   total input = requests x I1 + sum over k of (requests - k) x (I(k+1) - I(k))
//
// is exact, so the parts add up to the per-request records by construction;
// the checks that matter are that those records add up to the row's recorded
// usage, that `other` stays small, and that the growth measured the replies
// at a plausible size (ledgerChecks).
//
// Each figure says where it came from: M measured, E estimated at
// CHARS_PER_TOKEN, M/E a measured total split by an estimate (one step's
// growth among its replies, or one script's output among its MCP calls by
// their reply characters). A step's growth, less the agent's own output, is
// the measured size of its replies when it lies within REPLY_BAND times their
// character estimate (plus REPLY_FRAMING tokens a reply); outside that band
// the replies take the estimate and the rest of the growth goes to `other`.
// Codex re-reads a request's reasoning with its output: a fit over the stored
// A/A codex sweep's steps gave 0.99 input tokens per reasoning token. The
// Claude CLI does not re-read thinking: in the stored Haiku sweeps the step
// after a request that thought grew by that request's visible output and
// replies less a steady 160 to 170 tokens whatever the thinking's length (103
// to 211 tokens in one pdf-bill row), so a Claude row's thinking counts as
// output only. The shortfall is `other`, and its cause is unexplained: all but
// two of those requests were a row's first, and those two fell short as much.
//
//   node eval/scripts/token-ledger.mjs <run-dir> [--ab <A>,<B>] [--control <A2>,<B>] [--json <file>] [--check]
//
// --check exits 1 when a check fails or checks no row. It reads a run and
// spends nothing.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceTokens } from '../backends/pricing.mjs';
import { isRunDir, readRun } from '../run-files.mjs';
import { readEvents, rowTranscript, SURFACE_SERVER } from './events.mjs';
import { findBuild } from './identity.mjs';
import { shellAssistedOf } from './row-evidence.mjs';

// Characters per token for every estimate, by backend: a reply the growth
// does not measure, a split of one step's growth among its replies, the tool
// definitions and instructions inside the prefix. The text replies of
// WHOLE_MIN_CHARS or more that the growth measured whole ran 3.3 to 4.1 an
// arm on the stored 2026-09 codex runs (catalog prints 3.8 to 4.4, snapshots
// 3.1 to 3.4) and 2.5 to 2.9 on the Claude CLI runs, whose prefix difference
// between firefox-devtools-mcp 0.10.3 and playwright-mcp (9,918 more
// characters of definitions and instructions) was 3,212 tokens.
export const CHARS_PER_TOKEN = { codex: 3.5, anthropic: 2.7 };
const cptOf = (backend) => CHARS_PER_TOKEN[backend] ?? CHARS_PER_TOKEN.codex;
export const REPLY_BAND = [0.5, 2];
export const REPLY_FRAMING = 50;
// The smallest reply the characters-a-token check reads: below it a reply's
// framing is much of its growth (a codex click reply measures 2.3 to 2.5).
export const WHOLE_MIN_CHARS = 1000;
// An image's tokens when its dimensions do not decode, and the ceiling of one
// that does: a long edge scaled to 1568 pixels at 750 pixels a token, the
// Claude formula, which codex images take too. It sizes only an image whose
// step the growth does not measure: the 16 codex image steps of the stored
// 2026-09-20 and 09-21 sweeps measured 1,146 to 1,463 tokens an image against
// estimates of 1,244 and 1,600.
export const IMAGE_TOKENS = 1600;
// Codex counts an output's tokens as its UTF-8 bytes over 4, for its output
// budget and its cut markers alike.
export const CODEX_BYTES_PER_TOKEN = 4;
// A row reconciles when every per-request sum equals its recorded figure
// exactly; an arm fails when |other| exceeds `unattributed` of its total
// input, the growth measured less than `measured` of its replies' estimated
// tokens, the replies it measured whole ran outside `cpt` times the estimate's
// characters a token, or its priced classes miss its recorded cost by more
// than `cost` (ledgerChecks).
export const TOLERANCE = { reconcile: 0, unattributed: 0.05, cost: 0.01, measured: 0.9, cpt: [0.75, 1.33] };

const CATALOG = '(catalog)';
const SHELL = '(shell)';
const SCRIPT = '(script output)';
const FILES = '(file tools)';
const CLI_CONTEXT = '(CLI context)';

// ---- replies ----------------------------------------------------------------

// A PNG's tokens from its IHDR dimensions, else IMAGE_TOKENS.
export function imageTokens(data) {
  try {
    const b64 = String(data ?? '').replace(/^data:[^,]*,/, '');
    const head = Buffer.from(b64.slice(0, 44), 'base64');
    if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
      const w = head.readUInt32BE(16);
      const h = head.readUInt32BE(20);
      const scale = Math.min(1, 1568 / Math.max(w, h, 1));
      return Math.max(1, Math.min(IMAGE_TOKENS, Math.ceil((w * scale * h * scale) / 750)));
    }
  } catch {}
  return IMAGE_TOKENS;
}

// Characters and image tokens of a reply's content: an Agent SDK tool_result
// (a string or text and image blocks) or a codex output (a string or
// input_text and input_image parts). `unsized` counts the blocks no
// characters estimate, such as the PDF document block the Claude CLI's Read
// sends.
function measureContent(content) {
  const out = { chars: 0, imageTokens: 0, images: 0, unsized: 0 };
  if (typeof content === 'string') {
    out.chars = content.length;
    return out;
  }
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'text' || c?.type === 'input_text') out.chars += String(c.text ?? '').length;
    else if (c?.type === 'image') {
      out.images++;
      out.imageTokens += imageTokens(c.source?.data);
    } else if (c?.type === 'input_image') {
      out.images++;
      out.imageTokens += imageTokens(c.image_url);
    } else if (c?.type) out.unsized++;
  }
  return out;
}

const contentString = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');

// What codex cut from an output before the model saw it, in codex's own count
// (CODEX_BYTES_PER_TOKEN bytes a token, not the model's tokens): the whole
// output (`original`) and what it removed (`removed`), or what it removed in
// characters (`removedChars`). `kept` is codex's count of the text the model
// read.
function codexCut(text) {
  const whole = /Warning: truncated output \(original token count: (\d+)\)/.exec(text);
  const part = /…(\d+) (tokens|chars) truncated…/.exec(text);
  if (!whole && !part) return null;
  const cut = { kept: Buffer.byteLength(text) / CODEX_BYTES_PER_TOKEN };
  if (whole) cut.original = Number(whole[1]);
  if (part?.[2] === 'tokens') cut.removed = Number(part[1]);
  else if (part) cut.removedChars = Number(part[1]);
  cut.removed ??= cut.removedChars != null ? cut.removedChars / CODEX_BYTES_PER_TOKEN : Math.max(0, cut.original - cut.kept);
  cut.original ??= cut.kept + cut.removed;
  return cut;
}

const mcpName = (server, tool) => (server === SURFACE_SERVER ? tool : `mcp:${server}/${tool}`);

// An Agent SDK tool's ledger category.
function claudeCategory(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
  if (m) return mcpName(m[1], m[2]);
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return SHELL;
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit'].includes(name)) return FILES;
  return `(${name ?? 'unknown tool'})`;
}

// ---- per-request records ----------------------------------------------------

// One model request: its usage, the characters of what it wrote, and the
// replies that came back before the next request.
const newRequest = () => ({
  input: 0, uncached: 0, write: 0, read: 0, output: 0, reasoning: null,
  textChars: 0, argChars: 0, thinking: false, replies: [], usage: false, final: false,
});

// A codex rollout's requests, one list per session: each token_count whose
// total_token_usage differs from the last is a request, whose last_token_usage
// is its own usage. A reply belongs to the request whose output was seen last
// before it, which is the step its tokens grow. MCP calls (mcp_tool_call_end)
// go to the exec or wait call still open when they end.
export function codexRequests(text) {
  const sessions = [];
  let session = null;
  let lastTotal = null;
  let inflight = null;
  const calls = new Map();
  const open = [];
  const ensureSession = () => {
    if (!session) {
      session = { requests: [], servers: null };
      sessions.push(session);
    }
    return session;
  };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const p = entry.payload ?? {};
    if (entry.type === 'session_meta') {
      session = { requests: [], servers: null };
      sessions.push(session);
      lastTotal = null;
      inflight = null;
      continue;
    }
    if (entry.type === 'event_msg' && p.type === 'token_count') {
      if (!p.info?.total_token_usage || !p.info.last_token_usage) continue;
      const total = JSON.stringify(p.info.total_token_usage);
      if (total === lastTotal) continue;
      lastTotal = total;
      const u = p.info.last_token_usage;
      const req = inflight ?? newRequest();
      req.usage = true;
      req.input = u.input_tokens ?? 0;
      req.read = u.cached_input_tokens ?? 0;
      req.write = u.cache_write_input_tokens ?? 0;
      req.uncached = Math.max(0, req.input - req.read - req.write);
      req.output = u.output_tokens ?? 0;
      req.reasoning = u.reasoning_output_tokens ?? null;
      ensureSession().requests.push(req);
      inflight = null;
      continue;
    }
    if (entry.type === 'event_msg' && p.type === 'mcp_tool_call_end') {
      const call = calls.get(open.at(-1));
      const result = p.result?.Ok ?? p.result?.Err ?? p.result;
      const chars = contentString(result?.content ?? (typeof result === 'string' ? result : '')).length;
      call?.mcp.push({ category: mcpName(p.invocation?.server, p.invocation?.tool), chars });
      continue;
    }
    if (entry.type !== 'response_item') continue;
    const isOutput =
      (p.type === 'message' && p.role === 'assistant') || p.type === 'reasoning' || p.type === 'custom_tool_call' || p.type === 'function_call';
    if (isOutput) {
      inflight ??= newRequest();
      if (p.type === 'message') inflight.textChars += contentString(p.content).length;
      else if (p.type === 'custom_tool_call') inflight.argChars += String(p.input ?? '').length;
      else if (p.type === 'function_call') inflight.argChars += String(p.arguments ?? '').length;
      if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        calls.set(p.call_id, { name: p.name, script: String(p.input ?? p.arguments ?? ''), mcp: [] });
        open.push(p.call_id);
      }
      continue;
    }
    if (p.type !== 'custom_tool_call_output' && p.type !== 'function_call_output') continue;
    const call = calls.get(p.call_id) ?? { name: null, script: '', mcp: [] };
    const at = open.lastIndexOf(p.call_id);
    if (at !== -1) open.splice(at, 1);
    const owner = inflight ?? ensureSession().requests.at(-1);
    if (!owner) continue;
    const measured = measureContent(p.output);
    const outText = contentString(p.output);
    owner.replies.push({ ...measured, parts: codexParts(call, measured.chars), cut: codexCut(outText) });
  }
  return sessions.filter((s) => s.requests.length);
}

// How one codex output splits among categories, as [{category, weight,
// calls}]: its MCP calls by their reply characters; with a script that read
// ALL_TOOLS, the characters beyond those replies are the catalog print.
function codexParts(call, chars) {
  const direct = /^mcp__(.+?)__(.+)$/.exec(call.name ?? '');
  if (direct) return [{ category: mcpName(direct[1], direct[2]), weight: 1, calls: 1 }];
  const catalog = /\bALL_TOOLS\b/.test(call.script);
  const byCategory = new Map();
  for (const m of call.mcp) {
    const e = byCategory.get(m.category) ?? { category: m.category, weight: 0, calls: 0 };
    e.weight += Math.max(1, m.chars);
    e.calls++;
    byCategory.set(m.category, e);
  }
  const parts = [...byCategory.values()];
  if (parts.length) {
    if (catalog) {
      const replies = parts.reduce((n, e) => n + e.weight, 0);
      const kept = Math.min(replies, chars);
      for (const e of parts) e.weight = (kept * e.weight) / replies;
      if (chars > kept) parts.push({ category: CATALOG, weight: chars - kept, calls: 1 });
    }
    return parts;
  }
  if (catalog) return [{ category: CATALOG, weight: 1, calls: 1 }];
  if (/\bexec_command\b/.test(call.script) || call.name === 'exec_command' || call.name === 'shell') {
    return [{ category: SHELL, weight: 1, calls: 1 }];
  }
  if (/\bview_image\b/.test(call.script) || call.name === 'view_image') return [{ category: '(view_image)', weight: 1, calls: 1 }];
  if (call.name && call.name !== 'exec' && call.name !== 'wait') return [{ category: `(${call.name})`, weight: 1, calls: 1 }];
  return [{ category: SCRIPT, weight: 1, calls: 1 }];
}

// An Agent SDK transcript's requests, in one session: each top-level
// assistant message id is a request, its usage the largest of each field over
// its streamed messages and the message_delta after them, as the backend
// counts it (backends/anthropic.mjs usageTracker). The transcript keeps no
// message_start, so a message_delta that follows another with no assistant
// message between them is a request of its own that wrote nothing visible (the
// CLI then asks again). A request with no message_delta carries only its
// message_start's partial output, and `final` is false. A user message's
// tool_results are replies to the request before it; its other blocks go with
// its first tool_result, or with the request's last reply when it has none
// (the PDF a Read sends in a message of its own), else to the CLI's own
// context.
export function claudeRequests(events) {
  const requests = [];
  const byId = new Map();
  const names = new Map();
  let current = null;
  let servers = null;
  const take = (r, u) => {
    if (!u) return;
    r.usage = true;
    r.uncached = Math.max(r.uncached, u.input_tokens ?? 0);
    r.write = Math.max(r.write, u.cache_creation_input_tokens ?? 0);
    r.read = Math.max(r.read, u.cache_read_input_tokens ?? 0);
    r.output = Math.max(r.output, u.output_tokens ?? 0);
    const thinking = u.output_tokens_details?.thinking_tokens;
    if (thinking != null) r.reasoning = Math.max(r.reasoning ?? 0, thinking);
    r.input = r.uncached + r.write + r.read;
  };
  for (const m of events ?? []) {
    if (m?.type === 'system' && m.subtype === 'init') servers ??= m.mcp_servers ? { list: m.mcp_servers, tools: m.tools ?? null } : null;
    if (m?.parent_tool_use_id) continue;
    if (m?.type === 'assistant') {
      const id = m.message?.id ?? `anon-${requests.length}`;
      let r = byId.get(id);
      if (!r) {
        r = newRequest();
        byId.set(id, r);
        requests.push(r);
      }
      current = r;
      take(r, m.message?.usage);
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text') r.textChars += String(c.text ?? '').length;
        else if (c.type === 'thinking' || c.type === 'redacted_thinking') r.thinking = true;
        else if (c.type === 'tool_use') {
          r.argChars += JSON.stringify(c.input ?? {}).length;
          names.set(c.id, c.name);
        }
      }
    } else if (m?.type === 'stream_event' && m.event?.type === 'message_delta') {
      if (!current || current.final) {
        current = newRequest();
        requests.push(current);
      }
      current.final = true;
      take(current, m.event.usage);
    } else if (m?.type === 'user' && current && Array.isArray(m.message?.content)) {
      const blocks = m.message.content;
      const first = blocks.find((c) => c.type === 'tool_result');
      const firstCategory = first
        ? claudeCategory(names.get(first.tool_use_id))
        : current.replies.at(-1)?.parts[0]?.category ?? CLI_CONTEXT;
      for (const c of blocks) {
        if (c.type === 'tool_result') {
          const measured = measureContent(c.content);
          const text = contentString(c.content);
          current.replies.push({
            ...measured,
            parts: [{ category: claudeCategory(names.get(c.tool_use_id)), weight: 1, calls: 1 }],
            spilled: /<persisted-output>/.test(text),
            cut: null,
          });
        } else {
          current.replies.push({ ...measureContent([c]), parts: [{ category: firstCategory, weight: 1, calls: 0 }], cut: null });
        }
      }
    }
  }
  // A request that reports no thinking tokens and streamed no thinking block
  // thought for none.
  for (const r of requests) if (r.reasoning == null && !r.thinking) r.reasoning = 0;
  return requests.length ? [{ requests, servers }] : [];
}

// ---- the ledger of one row ----------------------------------------------------

const emptyCategory = () => ({
  calls: 0, appended: 0, billed: 0, chars: 0, measured: 0, split: 0, estimate: 0,
  textChars: 0, textMeasured: 0, cut: 0, cutOriginal: 0, cutRemoved: 0, cutRead: 0, cutAway: 0, spilled: 0,
});

// The tool definitions and instructions a condition's server sent, from the
// run's meta (a build's entry, else its surface's).
function surfaceTools(meta, condition) {
  const build = findBuild(meta, condition);
  if (build?.tools) return build.tools;
  const bare = String(condition).split('/').pop();
  return meta?.surfaces?.[bare]?.tools ?? meta?.surfaces?.[bare.split('@')[0]]?.tools ?? null;
}

// One step's replies against `rest`, the step's input growth less the agent's
// own output: { estimate, estimates, measured, other, replies: [{ tokens,
// measured, split }] }. Replies of known size share a growth inside the band
// by their estimates (split when there are several); outside it they take
// their estimates, and `other` is what the growth leaves. Unsized replies
// take what the growth leaves after the sized ones' estimates.
function assignStep(rest, replies, cpt) {
  const estimates = replies.map((x) => x.chars / cpt + x.imageTokens);
  const estimate = estimates.reduce((a, b) => a + b, 0);
  const out = { estimate, estimates, measured: false, other: rest, replies: replies.map(() => ({ tokens: 0, measured: false, split: false })) };
  if (!replies.length) return out;
  const unsized = replies.map((x, i) => (x.unsized ? i : -1)).filter((i) => i !== -1);
  if (unsized.length) {
    const left = rest - estimate;
    for (const [i, e] of estimates.entries()) out.replies[i].tokens = e;
    if (left > 0) {
      for (const i of unsized) out.replies[i] = { tokens: estimates[i] + left / unsized.length, measured: true, split: true };
      out.other = 0;
    } else {
      out.other = left;
    }
    return out;
  }
  const inBand = rest >= REPLY_BAND[0] * estimate && rest <= REPLY_BAND[1] * estimate + REPLY_FRAMING * replies.length;
  for (const [i, e] of estimates.entries()) {
    const share = estimate > 0 ? e / estimate : 1 / replies.length;
    out.replies[i] = inBand ? { tokens: rest * share, measured: true, split: replies.length > 1 } : { tokens: e, measured: false, split: false };
  }
  out.measured = inBand;
  out.other = inBand ? 0 : rest - estimate;
  return out;
}

// `sessions` as codexRequests or claudeRequests return them; `reasoningCarried`
// says whether a request's reasoning is read again by the next one, and `cpt`
// is the characters a token of every estimate.
export function attribute(sessions, { reasoningCarried, cpt }) {
  const out = {
    requests: 0, sessions: sessions.length, firstInput: null,
    prefix: 0, own: 0, ownAppended: 0, other: 0, categories: {},
    records: { input: 0, uncached: 0, write: 0, read: 0, output: 0 },
    output: { reasoning: 0, reasoningKnown: true, text: 0, args: 0 },
    replyEstimate: 0, replyMeasuredTokens: 0, replyMeasuredEstimate: 0, afterThinking: [], wholeChars: 0, wholeTokens: 0,
  };
  for (const { requests } of sessions) {
    const n = requests.length;
    out.requests += n;
    out.firstInput ??= requests[0].input;
    out.prefix += n * requests[0].input;
    for (const [k, r] of requests.entries()) {
      out.records.input += r.input;
      out.records.uncached += r.uncached;
      out.records.write += r.write;
      out.records.read += r.read;
      out.records.output += r.output;
      if (r.reasoning == null) out.output.reasoningKnown = false;
      const reasoning = r.reasoning ?? 0;
      const visible = Math.max(0, r.output - reasoning);
      const chars = r.textChars + r.argChars;
      out.output.reasoning += reasoning;
      out.output.text += chars ? (visible * r.textChars) / chars : visible;
      out.output.args += chars ? (visible * r.argChars) / chars : 0;
      if (k === n - 1) continue;
      const carries = n - 1 - k;
      const growth = requests[k + 1].input - r.input;
      const carried = reasoningCarried ? r.output : visible;
      out.ownAppended += carried;
      out.own += carried * carries;
      const rest = growth - carried;
      const step = assignStep(rest, r.replies, cpt);
      out.replyEstimate += step.estimate;
      if (step.measured) {
        out.replyMeasuredTokens += rest;
        out.replyMeasuredEstimate += step.estimate;
      }
      out.other += step.other * carries;
      if (r.thinking || r.reasoning > 0) out.afterThinking.push({ first: k === 0, shortfall: rest - step.estimate });
      for (const [i, reply] of r.replies.entries()) {
        const { tokens, measured, split } = step.replies[i];
        const weight = reply.parts.reduce((a, p) => a + p.weight, 0) || 1;
        for (const part of reply.parts) {
          const f = part.weight / weight;
          const c = (out.categories[part.category] ??= emptyCategory());
          c.calls += part.calls;
          c.appended += tokens * f;
          c.billed += tokens * f * carries;
          c.chars += reply.chars * f;
          c.estimate += step.estimates[i] * f;
          if (measured) c.measured += tokens * f;
          if (measured && (split || reply.parts.length > 1)) c.split += tokens * f;
          if (measured && !split && !reply.images && reply.parts.length === 1) {
            c.textChars += reply.chars * f;
            c.textMeasured += tokens * f;
            if (reply.chars >= WHOLE_MIN_CHARS) {
              out.wholeChars += reply.chars * f;
              out.wholeTokens += tokens * f;
            }
          }
          if (reply.spilled) c.spilled += f;
          if (reply.cut) {
            // The part removed, in model tokens: codex's count of it at the
            // model tokens a codex token the kept text ran.
            const { kept, removed, removedChars, original } = reply.cut;
            const away = removedChars != null ? (reply.chars ? (removedChars * tokens) / reply.chars : 0) : kept > 0 ? (removed * tokens) / kept : 0;
            c.cut += f;
            c.cutRead += tokens * f;
            c.cutOriginal += original * f;
            c.cutRemoved += removed * f;
            c.cutAway += away * f;
          }
        }
      }
    }
  }
  out.total = out.prefix + out.own + out.other + Object.values(out.categories).reduce((a, c) => a + c.billed, 0);
  return out;
}

// What the Claude CLI spent beside the row's requests: the last result
// message's modelUsage covers every model call the CLI made, one entry per
// model id, and the row's usage only the agent's, so the entries beyond the
// one that matches it are the CLI's side requests, which cost_usd holds and no
// token column does. Without a matching entry the side tokens are the
// difference, and their cost is unknown.
function claudeSide(events) {
  const results = (events ?? []).filter((m) => m?.type === 'result');
  const last = results.at(-1);
  if (!last?.modelUsage) return null;
  const sum = (pick) => results.reduce((n, r) => n + (pick(r.usage ?? {}) ?? 0), 0);
  const agent = {
    uncached: sum((u) => u.input_tokens),
    write: sum((u) => u.cache_creation_input_tokens),
    read: sum((u) => u.cache_read_input_tokens),
    output: sum((u) => u.output_tokens),
  };
  const entries = Object.values(last.modelUsage);
  const main = entries.find(
    (m) =>
      (m.inputTokens ?? 0) === agent.uncached &&
      (m.cacheCreationInputTokens ?? 0) === agent.write &&
      (m.cacheReadInputTokens ?? 0) === agent.read &&
      (m.outputTokens ?? 0) === agent.output
  );
  const input = entries.reduce((n, m) => n + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0);
  const output = entries.reduce((n, m) => n + (m.outputTokens ?? 0), 0);
  return {
    input: input - agent.uncached - agent.write - agent.read,
    output: output - agent.output,
    costUSD: main ? entries.filter((m) => m !== main).reduce((n, m) => n + (m.costUSD ?? 0), 0) : null,
  };
}

const recordedOf = (row) => ({
  uncached: row.input_tokens ?? 0,
  write: row.cache_creation ?? 0,
  read: row.cache_read ?? 0,
  output: row.output_tokens ?? 0,
});

// The row's cost split by what it paid for, priced from genai-prices' table as
// the backend prices a codex row (backends/pricing.mjs), each class over the
// row's requests.
function pricedClasses(model, r, requests) {
  if (!model) return null;
  const price = (usage) => priceTokens(model, { input_tokens: 0, cache_creation: 0, cache_read: 0, output_tokens: 0, ...usage }, 'ledger', requests);
  const parts = {
    uncached: price({ input_tokens: r.uncached }),
    write: price({ cache_creation: r.write }),
    read: price({ cache_read: r.read }),
    output: price({ output_tokens: r.output }),
  };
  return Object.values(parts).some((v) => v == null) ? null : parts;
}

// The MCP servers the Claude CLI's init message lists as not yet connected
// and whose tools its tool list lacks, as "name status": the first request
// carried none of their tools. A codex session records neither.
function lateServers(sessions) {
  const init = sessions[0]?.servers;
  if (!Array.isArray(init?.list)) return [];
  const listed = (name) => Array.isArray(init.tools) && init.tools.some((t) => String(t).startsWith(`mcp__${name}__`));
  return init.list.filter((s) => s.status && s.status !== 'connected' && !listed(s.name)).map((s) => `${s.name} ${s.status}`);
}

const LEDGERS = new WeakMap();
const rowName = (row) => row.task + (row.rep ? ` (r${row.rep})` : '');

// A row's ledger, or { unavailable: reason } when its run directory holds no
// per-request usage for it. `meta` gives the prefix's estimated parts.
export function rowLedger(row, runDir, meta = {}) {
  if (LEDGERS.has(row)) return LEDGERS.get(row);
  const result = buildLedger(row, runDir, meta);
  LEDGERS.set(row, result);
  return result;
}

function buildLedger(row, runDir, meta) {
  if (!runDir) return { unavailable: 'no run directory' };
  const backend = row.backend ?? meta.backend;
  // The scripted backend's usage is a stand-in: no input, and output a
  // quarter of the answer's characters.
  if (backend === 'scripted') return { unavailable: 'scripted stand-in usage' };
  let sessions;
  let events = null;
  if (backend === 'codex') {
    const file = row.rollout ?? (row.transcript ? `rollouts/${row.transcript}` : null);
    if (!file || !existsSync(join(runDir, file))) return { unavailable: 'no rollout' };
    sessions = codexRequests(readFileSync(join(runDir, file), 'utf8'));
  } else {
    const file = rowTranscript(runDir, row);
    if (!file) return { unavailable: 'no transcript' };
    events = readEvents(file);
    sessions = claudeRequests(events);
  }
  const late = lateServers(sessions);
  if (!sessions.length || sessions.some((s) => s.requests.some((r) => !r.usage))) {
    return { unavailable: 'no per-request usage', late };
  }
  // The stored 2026-08 Agent SDK transcripts keep no message_delta, so their
  // per-request output is message_start's partial count.
  if (backend !== 'codex' && sessions.some((s) => s.requests.some((r) => !r.final))) {
    return { unavailable: 'no final per-request usage', late };
  }
  const cpt = cptOf(backend);
  const ledger = attribute(sessions, { reasoningCarried: backend === 'codex', cpt });
  ledger.backend = backend;
  ledger.cpt = cpt;
  ledger.recorded = recordedOf(row);
  const rec = ledger.records;
  ledger.reconciled =
    Math.abs(rec.uncached - ledger.recorded.uncached) <= TOLERANCE.reconcile &&
    Math.abs(rec.write - ledger.recorded.write) <= TOLERANCE.reconcile &&
    Math.abs(rec.read - ledger.recorded.read) <= TOLERANCE.reconcile &&
    Math.abs(rec.output - ledger.recorded.output) <= TOLERANCE.reconcile;
  // Codex code mode puts no MCP definition in the first request: the catalog
  // reaches the model through ALL_TOOLS prints, counted as replies.
  const tools = surfaceTools(meta, row.condition);
  const inPrefix = backend !== 'codex';
  ledger.prefixParts = {
    schemas: !inPrefix ? 0 : tools?.schemaChars != null ? tools.schemaChars / cpt : null,
    instructions: !inPrefix ? 0 : tools && 'instructions' in tools ? (tools.instructions?.chars ?? 0) / cpt : null,
  };
  ledger.late = late;
  ledger.notes = late.length ? [`MCP server ${late.join(', ')} at the first request, which carried none of its tools`] : [];
  ledger.side = backend === 'anthropic' ? claudeSide(events) : null;
  ledger.cost = row.cost_usd ?? null;
  ledger.priced = pricedClasses(row.model, ledger.records, ledger.requests);
  return ledger;
}

// ---- sums over rows ------------------------------------------------------------

// The ledgers of `rows` summed: `rows` counts the rows with a ledger, and
// `unavailable` the rest by reason. `late` names every row, with a ledger or
// not, whose first request went out before its MCP server connected.
export function sumLedgers(rows, runDir, meta = {}) {
  const s = {
    rows: 0, unavailable: {}, backends: [], cpt: null, requests: 0, prefix: 0, firstInput: 0, own: 0, ownAppended: 0,
    other: 0, total: 0, categories: {},
    records: { input: 0, uncached: 0, write: 0, read: 0, output: 0 },
    recorded: { uncached: 0, write: 0, read: 0, output: 0 },
    output: { reasoning: 0, reasoningKnown: true, text: 0, args: 0 },
    replyEstimate: 0, replyMeasuredTokens: 0, replyMeasuredEstimate: 0, afterThinking: [], wholeChars: 0, wholeTokens: 0,
    schemas: 0, schemasKnown: true, instructions: 0, instructionsKnown: true,
    unreconciled: [], notes: [], late: [], side: null,
    cost: 0, costKnown: true, priced: { uncached: 0, write: 0, read: 0, output: 0 }, pricedKnown: true,
  };
  for (const row of rows) {
    const l = rowLedger(row, runDir, meta);
    if (l.late?.length) s.late.push(`${rowName(row)}: ${l.late.join(', ')}`);
    if (l.unavailable) {
      s.unavailable[l.unavailable] = (s.unavailable[l.unavailable] ?? 0) + 1;
      continue;
    }
    s.rows++;
    if (!s.backends.includes(l.backend)) s.backends.push(l.backend);
    s.cpt ??= l.cpt;
    for (const k of ['requests', 'prefix', 'firstInput', 'own', 'ownAppended', 'other', 'total', 'replyEstimate', 'replyMeasuredTokens', 'replyMeasuredEstimate', 'wholeChars', 'wholeTokens']) {
      s[k] += l[k];
    }
    for (const k of Object.keys(s.records)) s.records[k] += l.records[k];
    for (const k of Object.keys(s.recorded)) s.recorded[k] += l.recorded[k];
    for (const k of ['reasoning', 'text', 'args']) s.output[k] += l.output[k];
    s.afterThinking.push(...l.afterThinking);
    if (!l.output.reasoningKnown) s.output.reasoningKnown = false;
    if (l.prefixParts.schemas == null) s.schemasKnown = false;
    else s.schemas += l.prefixParts.schemas;
    if (l.prefixParts.instructions == null) s.instructionsKnown = false;
    else s.instructions += l.prefixParts.instructions;
    for (const [name, c] of Object.entries(l.categories)) {
      const t = (s.categories[name] ??= emptyCategory());
      for (const k of Object.keys(t)) t[k] += c[k];
    }
    if (!l.reconciled) s.unreconciled.push(row);
    for (const note of l.notes) s.notes.push(`${rowName(row)}: ${note}`);
    if (l.side) {
      s.side ??= { input: 0, output: 0, costUSD: 0, costKnown: true, rows: 0 };
      s.side.input += l.side.input;
      s.side.output += l.side.output;
      if (l.side.costUSD == null) s.side.costKnown = false;
      else s.side.costUSD += l.side.costUSD;
      s.side.rows++;
    }
    if (l.cost == null) s.costKnown = false;
    else s.cost += l.cost;
    if (!l.priced) s.pricedKnown = false;
    else for (const k of Object.keys(s.priced)) s.priced[k] += l.priced[k];
  }
  return s;
}

// The checks on summed ledgers, as { name, ok, detail, skipped }:
//   - the per-request records add up to the rows' recorded usage exactly
//     (TOLERANCE.reconcile), which is what ties the ledger to the row;
//   - the parts add up to the records, which the telescoping sum makes true
//     unless the code that splits it is wrong;
//   - the growth the ledger cannot attribute stays within
//     TOLERANCE.unattributed of the total input;
//   - the growth measured at least TOLERANCE.measured of the replies'
//     estimated tokens, and the replies it measured whole ran within
//     TOLERANCE.cpt times the estimate's characters a token: the in-band rule
//     gives a reply its step's growth, so a reply read onto the wrong request
//     leaves other growth near zero and shows here instead;
//   - the recorded cost is the priced classes plus the CLI's side requests
//     within TOLERANCE.cost. A codex row's cost_usd is priced from the same
//     table, so there it checks only the split into classes.
// A check with nothing to check is skipped, with the reason.
export function ledgerChecks(label, s) {
  if (!s.rows) return [];
  const recordedInput = s.recorded.uncached + s.recorded.write + s.recorded.read;
  const off = s.unreconciled.slice(0, 5).map(rowName);
  const share = s.records.input ? Math.abs(s.other) / s.records.input : 0;
  const measured = s.replyEstimate ? s.replyMeasuredEstimate / s.replyEstimate : null;
  const whole = wholeReplyCpt(s);
  const [lo, hi] = TOLERANCE.cpt;
  const checks = [
    {
      name: `${label}: per-request records add up to the recorded usage`,
      ok: s.unreconciled.length === 0,
      detail:
        `${s.rows - s.unreconciled.length}/${s.rows} rows exact; records ${s.records.input} input, ${s.records.output} output, ` +
        `recorded ${recordedInput} and ${s.recorded.output}` + (off.length ? `; off: ${off.join(', ')}` : ''),
    },
    {
      name: `${label}: the parts add up to the records`,
      ok: Math.abs(s.total - s.records.input) <= 1e-6 * Math.max(1, s.records.input),
      detail: `parts ${Math.round(s.total)}, records ${s.records.input}`,
    },
    {
      name: `${label}: unattributed growth within ${TOLERANCE.unattributed * 100}% of total input`,
      ok: share <= TOLERANCE.unattributed,
      detail: `${int(s.other)} tokens, ${pct(share, 2)}`,
    },
    measured == null
      ? { name: `${label}: the growth measured the replies`, ok: true, skipped: 'no reply before a later request' }
      : {
          name: `${label}: the growth measured at least ${TOLERANCE.measured * 100}% of the replies' estimated tokens`,
          ok: measured >= TOLERANCE.measured,
          detail: `${pct(measured, 1)}`,
        },
    whole == null
      ? { name: `${label}: measured replies' characters a token`, ok: true, skipped: `no text reply of ${WHOLE_MIN_CHARS} characters or more measured whole` }
      : {
          name: `${label}: replies of ${WHOLE_MIN_CHARS} characters or more measured whole ran ${lo}x to ${hi}x the estimate's ${s.cpt} characters a token`,
          ok: whole >= lo * s.cpt && whole <= hi * s.cpt,
          detail: `${two(whole)} characters a token`,
        },
  ];
  const costName = `${label}: priced classes${s.side ? ' and side requests' : ''} within ${TOLERANCE.cost * 100}% of the recorded cost`;
  if (s.pricedKnown && s.costKnown && (!s.side || s.side.costKnown)) {
    const priced = Object.values(s.priced).reduce((a, b) => a + b, 0) + (s.side?.costUSD ?? 0);
    const gap = s.cost ? Math.abs(priced - s.cost) / s.cost : 0;
    checks.push({
      name: costName,
      ok: gap <= TOLERANCE.cost,
      detail: `$${priced.toFixed(4)} priced, $${s.cost.toFixed(4)} recorded, ${pct(gap, 2)} apart`,
    });
  } else {
    const why = [
      !s.pricedKnown && 'a model genai-prices does not price',
      !s.costKnown && 'a row with no recorded cost',
      s.side && !s.side.costKnown && "side requests of unknown cost",
    ].filter(Boolean);
    checks.push({ name: costName, ok: true, skipped: why.join(', ') });
  }
  return checks;
}

// The characters a token of the text replies of WHOLE_MIN_CHARS or more that
// the growth measured whole; null when it measured none.
export const wholeReplyCpt = (s) => (s.wholeTokens > 0 ? s.wholeChars / s.wholeTokens : null);

// The failed checks of each [label, rows] group, as "label: name: detail",
// for a report's validity block.
export function ledgerFailures(groups, runDir, meta = {}) {
  return groups.flatMap(([label, rows]) =>
    ledgerChecks(label, sumLedgers(rows, runDir, meta)).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
  );
}

// Each [label, rows] group whose rows sent their first request before their
// MCP server connected, as "label: n of m row(s): task: server status, ...",
// for a report's validity block: that request carried none of the server's
// tools.
export function lateServerRows(groups, runDir, meta = {}) {
  return groups.flatMap(([label, rows]) => {
    const late = sumLedgers(rows, runDir, meta).late;
    if (!late.length) return [];
    return [`${label}: ${late.length} of ${rows.length} row(s): ${late.slice(0, 6).join('; ')}${late.length > 6 ? `; and ${late.length - 6} more` : ''}`];
  });
}

// ---- rendering ---------------------------------------------------------------

// x to d places, with no sign on a figure that rounds to zero.
const fixed = (x, d) => {
  const t = x.toFixed(d);
  return Number(t) === 0 ? (0).toFixed(d) : t;
};
const int = (x) => (x == null || Number.isNaN(x) ? 'n/a' : (Math.round(x) || 0).toLocaleString('en-US'));
const signed = (x) => {
  if (x == null || Number.isNaN(x)) return 'n/a';
  const r = Math.round(x);
  return r === 0 ? '0' : `${r > 0 ? '+' : '-'}${Math.abs(r).toLocaleString('en-US')}`;
};
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '' : `${fixed(x * 100, d)}%`);
const money = (x) => (x == null || Number.isNaN(x) ? 'n/a' : `$${fixed(x, 4)}`);
const signedMoney = (x) => {
  if (x == null || Number.isNaN(x)) return 'n/a';
  const t = fixed(Math.abs(x), 4);
  return Number(t) === 0 ? `$${t}` : `${x < 0 ? '-' : '+'}$${t}`;
};
const two = (x) => (x == null || Number.isNaN(x) ? 'n/a' : fixed(x, 2));
const signedTwo = (x) => {
  if (x == null || Number.isNaN(x)) return 'n/a';
  const t = fixed(x, 2);
  return Number(t) > 0 ? `+${t}` : t;
};
const per = (s, x) => (s.rows && x != null ? x / s.rows : null);
const FORMAT = { int: [int, signed], two: [two, signedTwo], money: [money, signedMoney] };
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// Where a reply kind's tokens came from, over every arm that has it: the
// shares measured whole, measured and split (M/E), and estimated.
function howOf(names, sums) {
  let measured = 0;
  let split = 0;
  let appended = 0;
  for (const s of sums) {
    for (const name of names) {
      measured += s.categories[name]?.measured ?? 0;
      split += s.categories[name]?.split ?? 0;
      appended += s.categories[name]?.appended ?? 0;
    }
  }
  if (!(appended > 0)) return 'M';
  const shares = [['M', (measured - split) / appended], ['M/E', split / appended], ['E', 1 - measured / appended]].filter(([, x]) => x >= 0.005);
  return shares.length === 1 ? shares[0][0] : shares.map(([k, x]) => `${k} ${Math.round(x * 100)}%`).join(', ');
}

// The ledger's lines, as { key, label, value(s), how, format, share }: `share`
// marks the lines that add up to the total input, which carry a share of the
// A-B difference.
function ledgerItems(sums, names) {
  const inPrefix = sums.some((s) => !s.backends.includes('codex'));
  const out = [
    { key: 'requests', label: 'requests', value: (s) => per(s, s.requests), how: 'M', format: 'two' },
    { key: 'firstInput', label: 'prefix: first request input, which every request carries', value: (s) => per(s, s.firstInput), how: 'M' },
    ...(inPrefix
      ? [
          { key: 'schemas', label: '  of which MCP tool definitions', value: (s) => (s.schemasKnown ? per(s, s.schemas) : null), how: 'E' },
          { key: 'instructions', label: '  of which server instructions', value: (s) => (s.instructionsKnown ? per(s, s.instructions) : null), how: 'E' },
        ]
      : []),
    { key: 'prefix', label: 'prefix x requests', value: (s) => per(s, s.prefix), how: 'M', share: true },
  ];
  for (const name of names) {
    out.push({ key: `cat:${name}`, label: `replies: ${name}`, value: (s) => per(s, s.categories[name]?.billed ?? 0), how: howOf([name], sums), share: true });
  }
  const rest = [...new Set(sums.flatMap((s) => Object.keys(s.categories)))].filter((n) => !names.includes(n));
  if (rest.length) {
    out.push({
      key: 'cat:*',
      label: `replies: ${rest.length} other kind(s)`,
      value: (s) => per(s, rest.reduce((a, n) => a + (s.categories[n]?.billed ?? 0), 0)),
      how: howOf(rest, sums),
      share: true,
    });
  }
  out.push(
    { key: 'own', label: "the agent's own earlier output, re-read", value: (s) => per(s, s.own), how: 'M', share: true },
    { key: 'other', label: 'other growth: context the backend rewrote or added', value: (s) => per(s, s.other), how: 'M', share: true },
    { key: 'total', label: '**total input**', value: (s) => per(s, s.total), how: 'M', share: true },
    { key: 'reasoning', label: 'output: reasoning', value: (s) => (s.output.reasoningKnown ? per(s, s.output.reasoning) : null), how: 'M' },
    { key: 'text', label: 'output: text', value: (s) => per(s, s.output.text), how: 'M/E' },
    { key: 'args', label: 'output: tool-call arguments and scripts', value: (s) => per(s, s.output.args), how: 'M/E' },
    { key: 'output', label: '**total output**', value: (s) => per(s, s.records.output), how: 'M' },
    { key: 'uncached', label: 'input: uncached', value: (s) => per(s, s.records.uncached), how: 'M' },
    { key: 'write', label: 'input: cache writes', value: (s) => per(s, s.records.write), how: 'M' },
    { key: 'read', label: 'input: cache reads', value: (s) => per(s, s.records.read), how: 'M' },
    { key: 'p:uncached', label: 'cost: uncached input', value: (s) => (s.pricedKnown ? per(s, s.priced.uncached) : null), how: 'E', format: 'money' },
    { key: 'p:write', label: 'cost: cache writes', value: (s) => (s.pricedKnown ? per(s, s.priced.write) : null), how: 'E', format: 'money' },
    { key: 'p:read', label: 'cost: cache reads', value: (s) => (s.pricedKnown ? per(s, s.priced.read) : null), how: 'E', format: 'money' },
    { key: 'p:output', label: 'cost: output', value: (s) => (s.pricedKnown ? per(s, s.priced.output) : null), how: 'E', format: 'money' },
  );
  if (sums.some((s) => s.side)) {
    out.push({
      key: 'side',
      label: "cost: the CLI's side requests, in no token column",
      value: (s) => (s.side?.costKnown ? per(s, s.side.costUSD) : null),
      how: 'M',
      format: 'money',
    });
  }
  out.push({ key: 'cost', label: '**cost recorded**', value: (s) => (s.costKnown ? per(s, s.cost) : null), how: 'M', format: 'money' });
  return out;
}

// The reply kinds worth a line of their own: the largest by billed tokens in
// any arm, up to `limit`.
function topCategories(sums, limit = 10) {
  const all = new Map();
  for (const s of sums) {
    for (const [name, c] of Object.entries(s.categories)) all.set(name, Math.max(all.get(name) ?? 0, per(s, c.billed) ?? 0));
  }
  return [...all].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n);
}

function howNote(sums) {
  const cpts = [...new Set(sums.filter((s) => s.rows).map((s) => `${s.cpt} characters a token (${s.backends.join(', ')})`))];
  return (
    `M is measured from each request's own usage, E estimated at ${cpts.join(' and ')}, ` +
    "M/E a measured total split by an estimate. A reply's line is its tokens times the requests that carried it. A reply " +
    `is measured when its step's input growth, less the agent's own output, lies within ${REPLY_BAND[0]}x-${REPLY_BAND[1]}x ` +
    `its character estimate plus ${REPLY_FRAMING} tokens a reply; otherwise it takes the estimate, and the rest of that ` +
    'growth goes to other growth. Cost lines are priced from genai-prices, as a codex row is.'
  );
}

function codexNote(sums) {
  return sums.some((s) => s.backends.includes('codex'))
    ? [
        '- codex code mode puts no MCP tool definition or server instruction in the first request: they reach the model ' +
          "through a script's ALL_TOOLS print, which the (catalog) line counts, and a codex row re-reads its reasoning, " +
          "which the agent's own output line counts",
      ]
    : [];
}

function notesFor(label, s) {
  const out = [];
  const why = Object.entries(s.unavailable).map(([k, v]) => `${v} ${k}`).join(', ');
  if (why) out.push(`- ${label}: ${why} row(s) stay out of the ledger`);
  if (s.side && (s.side.input || s.side.output)) {
    out.push(
      `- ${label}: the Claude CLI's side requests took ${int(per(s, s.side.input))} input and ${int(per(s, s.side.output))} output ` +
        `tokens a row${s.side.costKnown ? `, ${money(per(s, s.side.costUSD))}` : ''}, which cost_usd holds and no token column does`
    );
  }
  const cut = Object.entries(s.categories).filter(([, c]) => c.cut > 0);
  if (cut.length) {
    const sum = (k) => cut.reduce((a, [, c]) => a + c[k], 0);
    out.push(
      `- ${label}: ${two(per(s, sum('cut')))} outputs a row cut before the model read them. By codex's count (UTF-8 bytes over ` +
        `${CODEX_BYTES_PER_TOKEN}, E) they held ${int(per(s, sum('cutOriginal')))} tokens a row whole, of which codex removed ` +
        `${int(per(s, sum('cutRemoved')))}; the model read ${int(per(s, sum('cutRead')))} tokens of what was left, so the part removed was about ` +
        `${int(per(s, sum('cutAway')))} model tokens a row (E, at the model tokens a codex token of the text it kept): ` +
        cut.map(([name, c]) => `${name} ${two(per(s, c.cut))} (${int(per(s, c.cutAway))} removed)`).join(', ')
    );
  }
  const spilled = Object.entries(s.categories).filter(([, c]) => c.spilled > 0);
  if (spilled.length) {
    out.push(`- ${label}: replies a row spilled to <persisted-output>: ` + spilled.map(([name, c]) => `${name} ${two(per(s, c.spilled))}`).join(', '));
  }
  if (s.replyEstimate > 0) {
    const whole = wholeReplyCpt(s);
    out.push(
      `- ${label}: the growth measured ${pct(s.replyMeasuredEstimate / s.replyEstimate)} of the replies' estimated tokens` +
        (whole != null ? `, and the text replies of ${WHOLE_MIN_CHARS} characters or more it measured whole ran ${two(whole)} characters a token against the ${s.cpt} estimate` : '')
    );
  }
  // The step after a Claude request that thought falls short of that request's
  // visible output and its replies' estimate by a steady amount whatever the
  // thinking's length, which is most of a Claude arm's negative other growth.
  if (s.backends.includes('anthropic') && s.afterThinking.length) {
    const m = median(s.afterThinking.map((x) => x.shortfall));
    const first = s.afterThinking.filter((x) => x.first).length;
    out.push(
      `- ${label}: the ${s.afterThinking.length} steps after a request that thought grew a median ${int(Math.abs(m))} tokens ` +
        `${m < 0 ? 'less' : 'more'} than that request's visible output and its replies' estimate, in other growth; ${first} of those ` +
        "requests were a row's first, and what the next request drops is unexplained"
    );
  }
  for (const note of s.notes) out.push(`- ${label}: ${note}`);
  return out;
}

const checkLines = (label, s) =>
  ledgerChecks(label, s).map((c) => (c.skipped ? `- (skipped) ${c.name}: ${c.skipped}` : `- [${c.ok ? 'x' : ' '}] ${c.name}: ${c.detail}`));

// The per-kind detail: calls a row, tokens a call as first read, billed a
// row, and the characters a token its text replies ran at where the growth
// measured them whole. A codex catalog print is a call of its own. Kinds
// under 0.1% of every arm's total input are counted, not listed.
function detailLines(sums, labels) {
  const names = [...new Set(sums.flatMap((s) => Object.keys(s.categories)))];
  const weight = (n) => Math.max(...sums.map((s) => (s.total ? (s.categories[n]?.billed ?? 0) / s.total : 0)));
  const shown = names.filter((n) => weight(n) >= 0.001).sort((x, y) => weight(y) - weight(x));
  const cols = (f) => labels.map((_, i) => f(sums[i])).join(' | ');
  const lines = [
    `| reply kind | ${['calls a row', 'tokens a call', 'billed a row', 'chars a token'].map((h) => labels.map((l) => `${h} ${l}`).join(' | ')).join(' | ')} |`,
    `|---|${labels.map(() => '---|---|---|---|').join('')}`,
  ];
  for (const name of shown) {
    const c = (s) => s.categories[name];
    lines.push(
      `| ${name} | ${cols((s) => (c(s) ? two(per(s, c(s).calls)) : '-'))} | ${cols((s) => (c(s)?.calls ? int(c(s).appended / c(s).calls) : '-'))} | ` +
        `${cols((s) => (c(s) ? int(per(s, c(s).billed)) : '-'))} | ${cols((s) => (c(s)?.textMeasured > 0 ? two(c(s).textChars / c(s).textMeasured) : '-'))} |`
    );
  }
  if (shown.length < names.length) lines.push('', `${names.length - shown.length} more kind(s) under 0.1% of total input in every arm.`);
  return lines;
}

// Each condition's rows that `keep` holds, as [condition, rows]; by default
// the rows that are not invalid, infra or error.
export function conditionGroups(results, keep = (r) => !r.invalid && !r.infra && !r.error) {
  return [...new Set(results.map((r) => r.condition))].map((c) => [c, results.filter((r) => r.condition === c && keep(r))]);
}

// report.mjs's section: every condition's ledger over its rows that are not
// invalid, infra or error, a column each.
export function conditionLedgerLines(results, runDir, meta = {}) {
  const groups = conditionGroups(results);
  const conditions = groups.map(([c]) => c);
  const sums = groups.map(([, rows]) => sumLedgers(rows, runDir, meta));
  const lines = ['', '## Where the tokens go', ''];
  if (!sums.some((s) => s.rows)) {
    const why = {};
    for (const s of sums) for (const [k, v] of Object.entries(s.unavailable)) why[k] = (why[k] ?? 0) + v;
    lines.push(`No row carries per-request usage (${Object.entries(why).map(([k, v]) => `${v} ${k}`).join(', ') || 'no rows'}), so the input is not split.`);
    return lines;
  }
  const items = ledgerItems(sums, topCategories(sums));
  lines.push(
    `Mean tokens a row by what they paid for, over each condition's rows that are not invalid, infra or error ` +
      `(\`node eval/scripts/token-ledger.mjs\`). ${howNote(sums)}`,
    '',
    `| where | ${conditions.join(' | ')} | how |`,
    `|---|${conditions.map(() => '---|').join('')}---|`,
  );
  for (const item of items) {
    const [show] = FORMAT[item.format ?? 'int'];
    lines.push(`| ${item.label} | ${sums.map((s) => show(item.value(s))).join(' | ')} | ${item.how} |`);
  }
  lines.push('', ...codexNote(sums));
  for (const [i, c] of conditions.entries()) lines.push(...notesFor(c, sums[i]));
  for (const [i, c] of conditions.entries()) lines.push(...checkLines(c, sums[i]));
  return lines;
}

// The prefix difference A-B a pair, split exactly: A's extra requests at B's
// prefix a request, and A's requests at the difference in prefix a request.
function prefixSplit(reqA, reqB, prefixA, prefixB, pairs) {
  const pa = prefixA / reqA;
  const pb = prefixB / reqB;
  return { more: ((reqA - reqB) * pb) / pairs, larger: (reqA * (pa - pb)) / pairs };
}

// Each value's 95% interval over `pairs` of [task, values], resampling tasks
// with all their pairs: `values` holds a pair's differences, then its
// requests and prefix in each row, from which a resample's prefix split comes.
// The percentiles are ab.mjs's, expanded for the task count (`bandIndex`),
// and under its MIN_TASKS tasks there is no interval. Returns
// { tasks, short, diffs: [[lo, hi] | null], more, larger }, `short` when there
// are too few tasks for an interval.
function ledgerBootstrap(pairs, width, { rng, bandIndex, seed, resamples }) {
  const byTask = new Map();
  for (const [task, v] of pairs) {
    if (!byTask.has(task)) byTask.set(task, []);
    byTask.get(task).push(v);
  }
  const tasks = [...byTask.values()];
  const at = bandIndex(tasks.length, resamples);
  if (at == null) return { tasks: tasks.length, short: true, diffs: Array(width).fill(null), more: null, larger: null };
  const rand = rng(seed);
  const draws = Array.from({ length: width + 2 }, () => new Float64Array(resamples));
  const known = Array.from({ length: width }, (_, i) => pairs.every(([, v]) => v[i] != null));
  for (let r = 0; r < resamples; r++) {
    const acc = new Float64Array(width + 4);
    let n = 0;
    for (let t = 0; t < tasks.length; t++) {
      for (const v of tasks[Math.floor(rand() * tasks.length)]) {
        for (let i = 0; i < width + 4; i++) acc[i] += v[i] ?? 0;
        n++;
      }
    }
    for (let i = 0; i < width; i++) draws[i][r] = acc[i] / n;
    const split = prefixSplit(acc[width], acc[width + 1], acc[width + 2], acc[width + 3], n);
    draws[width][r] = split.more;
    draws[width + 1][r] = split.larger;
  }
  const band = (d) => {
    d.sort();
    return [d[at], d[resamples - 1 - at]];
  };
  return {
    tasks: tasks.length,
    short: false,
    diffs: draws.slice(0, width).map((d, i) => (known[i] ? band(d) : null)),
    more: band(draws[width]),
    larger: band(draws[width + 1]),
  };
}

// The pairs whose rows both have a ledger, in task and repeat order: the
// bootstrap draws tasks by position and a float sum depends on its order, so
// the order the rows came in would otherwise move the A/B section's figures.
const usablePairs = (pairs, runDir, meta) =>
  pairs
    .filter(([x, y]) => !rowLedger(x, runDir, meta).unavailable && !rowLedger(y, runDir, meta).unavailable)
    .sort(([x], [y]) => (x.task < y.task ? -1 : x.task > y.task ? 1 : (x.rep ?? 1) - (y.rep ?? 1)));

// ab.mjs's section over the paired rows `pairs` ([[rowA, rowB], ...]): A beside
// B, A-B with its 95% interval over tasks, the share of the total input
// difference each part explains, and, given `control` (the A/A pairs of B's
// copy with B, [[rowA2, rowB], ...], as ab.mjs orients --control), the copy's
// A2-B with its own interval. `stats` is ab.mjs's { rng, bandIndex, MIN_TASKS }.
// A share is left out when the total difference has no interval or its
// interval holds 0, or when it lies inside the copy's interval: a copy of B
// then differs from B by as much as A does, and the means say nothing about
// the build.
export function abLedgerLines(pairs, runDir, meta = {}, { control = null, stats, seed = 'ab', resamples = 10000 } = {}) {
  if (!stats?.rng || !stats.bandIndex || !stats.MIN_TASKS) throw new Error("abLedgerLines needs ab.mjs's rng, bandIndex and MIN_TASKS");
  const usable = usablePairs(pairs, runDir, meta);
  const lines = ['', '## Where the tokens go', ''];
  if (!usable.length) {
    const why = sumLedgers(pairs.flat(), runDir, meta).unavailable;
    lines.push(`No pair carries per-request usage in both rows (${Object.entries(why).map(([k, v]) => `${v} ${k}`).join(', ') || 'no pairs'}), so the input is not split.`);
    return lines;
  }
  const sa = sumLedgers(usable.map(([x]) => x), runDir, meta);
  const sb = sumLedgers(usable.map(([, y]) => y), runDir, meta);
  const controlUsable = control ? usablePairs(control, runDir, meta) : [];
  const sc = controlUsable.length ? sumLedgers(controlUsable.map(([x]) => x), runDir, meta) : null;
  const scb = controlUsable.length ? sumLedgers(controlUsable.map(([, y]) => y), runDir, meta) : null;
  const items = ledgerItems([sa, sb, ...(sc ? [sc, scb] : [])], topCategories([sa, sb]));
  const diffOf = (item, x, y) => {
    const va = item.value(x);
    const vb = item.value(y);
    return va != null && vb != null ? va - vb : null;
  };
  const one = (row) => sumLedgers([row], runDir, meta);
  const perPairOf = (ps) =>
    ps.map(([x, y]) => {
      const [ox, oy] = [one(x), one(y)];
      return [x.task, [...items.map((item) => diffOf(item, ox, oy)), ox.requests, oy.requests, ox.prefix, oy.prefix]];
    });
  const perPair = perPairOf(usable);
  const opts = { rng: stats.rng, bandIndex: stats.bandIndex, resamples };
  const boot = ledgerBootstrap(perPair, items.length, { ...opts, seed: `${seed}:tokens` });
  const cboot = sc ? ledgerBootstrap(perPairOf(controlUsable), items.length, { ...opts, seed: `${seed}:tokens:A2` }) : null;
  const at = (key) => items.findIndex((item) => item.key === key);
  const totalDiff = per(sa, sa.total) - per(sb, sb.total);
  const totalBand = boot.diffs[at('total')];
  const controlBand = cboot ? cboot.diffs[at('total')] : null;
  // Inside an interval, give or take the rounding of a figure summed two ways.
  const inside = (x, b) => {
    if (x == null || !b) return false;
    const eps = 1e-9 * Math.max(1, Math.abs(x));
    return x >= b[0] - eps && x <= b[1] + eps;
  };
  const bandText = (b, show) => (b ? `[${show(b[0])}, ${show(b[1])}]` : '');
  const noCi = `no CI under ${stats.MIN_TASKS} tasks`;
  const noShare = boot.short
    ? `A-B covers ${boot.tasks} task(s), and an interval needs ${stats.MIN_TASKS}`
    : totalBand[0] <= 0 && totalBand[1] >= 0
      ? `the total input difference's interval ${bandText(totalBand, signed)} holds 0`
      : control && !sc
        ? "no pair of the A/A copy's carries per-request usage in both rows, so A-B is not read against it"
        : cboot?.short
          ? `the A/A copy covers ${cboot.tasks} task(s), and its interval needs ${stats.MIN_TASKS}, so A-B is not read against it`
          : sc && inside(totalDiff, controlBand)
            ? `A-B's total input difference, ${signed(totalDiff)} a row, lies inside the A/A copy's interval ${bandText(controlBand, signed)}, ` +
              'so the A/A copy differs from B by as much as A does; read only the parts whose A2-B carries no star'
            : null;
  const shares = !noShare;
  const split = prefixSplit(sa.requests, sb.requests, sa.prefix, sb.prefix, usable.length);
  const controlSplit = sc ? prefixSplit(sc.requests, scb.requests, sc.prefix, scb.prefix, controlUsable.length) : null;
  lines.push(
    `Mean tokens per paired row by what they paid for, over the ${usable.length} pairs whose rows both carry per-request usage` +
      (usable.length < pairs.length ? ` (of ${pairs.length})` : '') +
      `. The interval is a 95% bootstrap over tasks (${resamples} resamples, percentiles expanded for the task count), and the share is ` +
      `each part's piece of the total input difference A-B` +
      (sc
        ? `; A2-B is the A/A copy of B against B over its ${controlUsable.length} pairs, with its own interval, starred where A-B lies ` +
          "inside it: that part of A-B is no larger than a copy of B's difference from B"
        : '') +
      `. ${howNote([sa, sb])}`,
    '',
    `| where | A | B | A-B | 95% interval | share of A-B |${sc ? ' A2-B [95% interval] |' : ''} how |`,
    `|---|---|---|---|---|---|${sc ? '---|' : ''}---|`,
  );
  const interval = (b, short, x, show) => (b ? bandText(b, show) : short && x != null ? noCi : '');
  const controlCell = (x, b, diff, show) =>
    sc ? ` ${show(x)} ${b ? bandText(b, show) : cboot.short && x != null ? `[${noCi}]` : ''}${inside(diff, b) ? ' *' : ''} |` : '';
  for (const [i, item] of items.entries()) {
    const [show, diffShow] = FORMAT[item.format ?? 'int'];
    const diff = diffOf(item, sa, sb);
    const share = shares && item.share && totalDiff ? diff / totalDiff : null;
    const cdiff = sc ? diffOf(item, sc, scb) : null;
    lines.push(
      `| ${item.label} | ${show(item.value(sa))} | ${show(item.value(sb))} | ${diffShow(diff)} | ${interval(boot.diffs[i], boot.short, diff, diffShow)} | ${pct(share)} |` +
        `${controlCell(cdiff, cboot?.diffs[i], diff, diffShow)} ${item.how} |`
    );
    if (item.key === 'prefix') {
      for (const [k, label] of [['more', 'more requests'], ['larger', 'a larger prefix']]) {
        lines.push(
          `|   of which ${label} | | | ${signed(split[k])} | ${interval(boot[k], boot.short, split[k], signed)} | ${pct(shares && totalDiff ? split[k] / totalDiff : null)} |` +
            `${controlCell(controlSplit?.[k], cboot?.[k], split[k], signed)} M |`
        );
      }
    }
  }
  lines.push('');
  if (noShare) lines.push(`- no share is given: ${noShare}`);
  // A few long tasks carry most of a mean; the three that move it most.
  const byTask = new Map();
  for (const [task, v] of perPair) byTask.set(task, (byTask.get(task) ?? 0) + v[at('total')] / usable.length);
  const top = [...byTask].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).slice(0, 3);
  if (totalDiff && top.length) {
    lines.push(
      `- the ${top.length} tasks that move the total input difference most: ` +
        top.map(([task, d]) => `${task} ${signed(d)} a row (${pct(d / totalDiff)} of A-B)`).join(', ')
    );
  }
  lines.push(...codexNote([sa, sb]), ...notesFor('A', sa), ...notesFor('B', sb), ...(sc ? notesFor('A2', sc) : []));
  lines.push(...checkLines('A', sa), ...checkLines('B', sb), ...(sc ? checkLines('A2', sc) : []));
  lines.push('', ...detailLines([sa, sb], ['A', 'B']));
  return lines;
}

// The token lines of A's and B's ledgers over the pairs whose rows both carry
// per-request usage, each a mean a row: { pairs, rows: [{ label, how, format,
// values: [a, b] }] }, or { pairs: 0, unavailable } saying why no pair does.
// The judge's `tokens` question starts from them.
export function ledgerFacts(pairs, runDir, meta = {}) {
  const usable = usablePairs(pairs, runDir, meta);
  if (!usable.length) {
    const why = sumLedgers(pairs.flat(), runDir, meta).unavailable;
    return { pairs: 0, unavailable: Object.entries(why).map(([k, v]) => `${v} ${k}`).join(', ') || 'no pairs' };
  }
  const sums = [usable.map(([x]) => x), usable.map(([, y]) => y)].map((rows) => sumLedgers(rows, runDir, meta));
  const items = ledgerItems(sums, topCategories(sums)).filter((item) => item.format !== 'money');
  return { pairs: usable.length, rows: items.map((item) => ({ label: item.label, how: item.how, format: item.format ?? 'int', values: sums.map((s) => item.value(s)) })) };
}

// The pairs ab.mjs reads: A's and B's rows of one task and repeat, both
// carrying an efficiency figure (`excluded` null, ab.mjs exclusion).
export function ledgerPairs(results, a, b, excluded) {
  const key = (r) => `${r.task}#${r.rep ?? 1}`;
  const rowsB = new Map(results.filter((r) => r.condition === b && !excluded(r)).map((r) => [key(r), r]));
  return results.filter((r) => r.condition === a && !excluded(r) && rowsB.has(key(r))).map((r) => [r, rowsB.get(key(r))]);
}

// ---- CLI -----------------------------------------------------------------------

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
// No top-level await: ab.mjs, which the --ab path imports, imports this
// module, and would wait on its evaluation.
if (invokedDirectly) main();

async function main() {
  const args = process.argv.slice(2);
  const VALUED = new Set(['--ab', '--control', '--json']);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const known = new Set([...VALUED, '--check', '--help']);
  const unknown = args.filter((a, i) => a.startsWith('--') && !known.has(a) && !VALUED.has(args[i - 1]));
  const dir = args.find((x, i) => !x.startsWith('--') && !VALUED.has(args[i - 1]));
  const usage = 'usage: node eval/scripts/token-ledger.mjs <run-dir> [--ab <A>,<B>] [--control <A2>,<B>] [--json <file>] [--check]';
  const list = (name) => flag(name)?.split(',').map((s) => s.trim()).filter(Boolean);
  const ab = list('ab');
  const control = list('control');
  if (args.includes('--help')) {
    console.log(usage);
    process.exit(0);
  }
  const bad =
    !dir || unknown.length || !isRunDir(dir) || (args.includes('--ab') && ab?.length !== 2) ||
    (args.includes('--control') && (!ab || control?.length !== 2));
  if (bad) {
    console.error(unknown.length ? `unknown argument ${unknown.join(', ')}\n${usage}` : usage);
    process.exit(1);
  }
  const { meta = {}, results = [] } = readRun(dir);
  let lines;
  let arms;
  if (ab) {
    const { bandIndex, exclusion, MIN_TASKS, orientControl, rng } = await import('../ab.mjs');
    let oriented;
    try {
      oriented = orientControl(control, ab[0], ab[1]).control;
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    const assisted = new Set(results.filter((r) => shellAssistedOf(r, dir)));
    const excluded = (r) => exclusion(r, assisted);
    const pairs = ledgerPairs(results, ab[0], ab[1], excluded);
    if (!pairs.length) {
      console.error(`no valid pairs of ${ab[0]} and ${ab[1]} in ${dir}`);
      process.exit(1);
    }
    const controlPairs = oriented ? ledgerPairs(results, oriented[0], oriented[1], excluded) : null;
    lines = [
      `# Token ledger: ${ab[0]} (A) vs ${ab[1]} (B)${oriented ? `, A2 ${oriented[0]}` : ''}`, '', `- run: ${dir}`,
      ...abLedgerLines(pairs, dir, meta, { control: controlPairs, stats: { rng, bandIndex, MIN_TASKS }, seed: meta.seed ?? 'ab' }),
    ];
    arms = [[ab[0], pairs.map(([x]) => x)], [ab[1], pairs.map(([, y]) => y)], ...(oriented ? [[oriented[0], controlPairs.map(([x]) => x)]] : [])];
  } else {
    lines = ['# Token ledger', '', `- run: ${dir}`, ...conditionLedgerLines(results, dir, meta)];
    arms = conditionGroups(results);
  }
  const sums = arms.map(([label, rows]) => [label, sumLedgers(rows, dir, meta)]);
  const json = Object.fromEntries(sums);
  process.stdout.write(lines.join('\n') + '\n');
  const out = flag('json');
  if (out) {
    const plain = JSON.parse(JSON.stringify(json, (k, v) => (k === 'unreconciled' ? v.map((r) => `${r.condition}/${r.task}${r.rep ? `#${r.rep}` : ''}`) : v)));
    writeFileSync(resolve(out), JSON.stringify(plain, null, 2) + '\n');
    console.error(`wrote ${resolve(out)}`);
  }
  if (args.includes('--check')) {
    // An arm with no row the ledger could read checks nothing, and fails.
    const failed = [];
    for (const [label, s] of sums) {
      if (!s.rows) {
        const why = Object.entries(s.unavailable).map(([k, v]) => `${v} ${k}`).join(', ') || 'no rows';
        failed.push(`${label}: no row checked (${why})`);
        continue;
      }
      for (const c of ledgerChecks(label, s)) if (!c.ok) failed.push(`${c.name}: ${c.detail}`);
    }
    console.error(`token checks: ${sums.map(([label, s]) => `${label} ${s.rows} row(s)`).join(', ')}`);
    for (const f of failed) console.error(`token check failed: ${f}`);
    process.exit(failed.length ? 1 : 0);
  }
}
