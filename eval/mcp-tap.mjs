// Per-call tool telemetry, from the two places a call can be seen.
//
// The wire: run as a program, this is a stdio passthrough wrapped around a
// condition's MCP server command,
//   node mcp-tap.mjs --log <file> -- <command> [args...]
// that forwards every byte unchanged in both directions and, on the side, reads
// the newline-delimited JSON-RPC to log one line per tools/call
// ({tool, ms, argBytes, resultChars, bytes, isError}) plus the initialize and
// tools/list replies. Codex events carry no timestamps, so the tap is the only
// source of per-call latency in a codex run. It never logs argument or result
// content, only sizes, so a log holds nothing a validator grades.
//
// The agent's message stream: createCallRecorder reads the backend's events
// (Agent SDK messages or codex ThreadEvents) for what the wire cannot tell
// apart: which MCP server a call went to, shell commands, and what a result
// meant to the agent (a cut snapshot, a stale uid).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAP = fileURLToPath(import.meta.url);

// The {command, args, env} that runs `spec` through the tap, logging to
// `logPath`. The tap passes its environment on to the server unchanged.
export function tapSpec(spec, logPath) {
  return {
    command: process.execPath,
    args: [TAP, '--log', logPath, '--', spec.command, ...(spec.args ?? [])],
    ...(spec.env ? { env: spec.env } : {}),
  };
}

// Object keys sorted at every depth. The wire and the MCP SDK Client order a
// tool's keys differently (annotations before or after inputSchema), and the
// same tool list must hash alike from either.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
      : value;

// What identifies a server's tool surface, from its tools/list reply (as sent,
// or as an SDK Client's listTools returns it): schemaChars is what the
// definitions cost in every request's context.
export function toolsListInfo(tools) {
  const json = JSON.stringify(canonical(tools ?? []));
  return {
    count: tools?.length ?? 0,
    names: (tools ?? []).map((t) => t.name),
    hash: createHash('sha256').update(json).digest('hex'),
    schemaChars: json.length,
  };
}

// Every record of a tap log, in order. A missing log reads as empty.
export function readTapLog(path) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// The calls a tap log shows the server answering for a tool its tools/list
// named. A client that forwards a call to a tool the server lacks gets an error
// reply, which is not a call to the surface.
export function tapSurfaceCalls(records) {
  const listed = records.find((r) => r.type === 'tools/list' && Array.isArray(r.tools));
  const names = listed ? new Set(listed.tools.map((t) => t?.name)) : null;
  return records.filter((r) => r.type === 'call' && (!names || names.has(r.tool)));
}

// A tap killed before its server closed (the client escalates to SIGKILL about
// 2s after a SIGTERM) never writes its exit record. This waits up to `ms` for
// one and otherwise appends one on the tap's behalf, so every log ends in one.
export async function ensureTapExit(path, ms = 2000) {
  if (!path || !existsSync(path)) return;
  const hasExit = () => readTapLog(path).some((r) => r.type === 'exit');
  for (const stop = Date.now() + ms; Date.now() < stop; ) {
    if (hasExit()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (hasExit()) return;
  try {
    appendFileSync(path, JSON.stringify({ type: 'exit', at: Date.now(), code: null, signal: null, by: 'harness' }) + '\n');
  } catch {}
}

const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// { [tool]: { calls, errors, chars, p50_ms } } over a tap log's calls.
export function tapToolStats(records) {
  const byTool = new Map();
  for (const r of records) {
    if (r.type !== 'call') continue;
    const s = byTool.get(r.tool) ?? { calls: 0, errors: 0, chars: 0, ms: [] };
    s.calls += 1;
    s.errors += r.isError ? 1 : 0;
    s.chars += r.resultChars ?? 0;
    if (r.ms != null) s.ms.push(r.ms);
    byTool.set(r.tool, s);
  }
  return Object.fromEntries(
    [...byTool].map(([tool, s]) => {
      const p50 = median(s.ms);
      return [tool, { calls: s.calls, errors: s.errors, chars: s.chars, p50_ms: p50 == null ? null : Math.round(p50 * 10) / 10 }];
    })
  );
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// Tool names by role, across both shipped surfaces. The action set is the one
// the 2026-09-19 roadmap measured its action-then-snapshot rates with, plus
// select_option and press_key for a devtools build that adds them.
const SNAPSHOT_TOOLS = new Set(['take_snapshot', 'browser_snapshot']);
const EVAL_TOOL = /^(evaluate_script|browser_evaluate|browser_run_code.*)$/;
const ACTION_TOOLS = new Set([
  'click_by_uid', 'fill_by_uid', 'fill_form_by_uid', 'hover_by_uid', 'drag_by_uid_to_uid',
  'navigate_page', 'navigate_history', 'select_option', 'press_key',
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_navigate', 'browser_navigate_back',
  'browser_hover', 'browser_drag', 'browser_select_option', 'browser_press_key',
]);
const WAIT_TOOL = /^(browser_wait_for|wait_for)$/;
const RESTART_TOOL = /^restart_/;
// firefox-devtools-mcp's stale-uid errors, then playwright-mcp's stale-ref one
// ("Ref e55 not found in the current page snapshot").
export const STALE = /stale\/invalid|from a stale snapshot|invalid or from an old snapshot|not found in the current page snapshot/i;
// firefox-devtools-mcp rewrites every error that mentions a UID to the stale
// text, its own "Invalid UID format" included, so an agent that sent
// "uid=1_59" for 1_59 reads as having held a stale uid. Only the argument
// tells them apart: the tool's validateUid wants a snapshot number before the
// first underscore, which parseInt must read. Every string under a key ending
// in "uid" (uid, fromUid, toUid, a fill_form_by_uid element's uid) is tested.
export function malformedUid(input) {
  const bad = (uid) => {
    const [head, ...rest] = String(uid).split('_');
    return !rest.length || !head || Number.isNaN(parseInt(head, 10));
  };
  const walk = (node, key = '') => {
    if (typeof node === 'string') return /uid$/i.test(key) && bad(node);
    if (Array.isArray(node)) return node.some((v) => walk(v, key));
    if (node && typeof node === 'object') return Object.entries(node).some(([k, v]) => walk(v, k));
    return false;
  };
  return walk(input);
}
// A script that sleeps before it reads: setTimeout(callback, ms) with a literal
// delay or a product of literals (5 * 1000), Playwright's waitForTimeout(ms), or
// a sleep, delay or wait helper called with a literal. A surface without a wait
// tool waits this way (embargo-wait's setTimeout(r, 22000)), so counting only
// wait tools read as that surface never waiting. A pause under SCRIPT_SLEEP_MS
// is a tick between two reads, not a wait for the page.
const SCRIPT_SLEEP_MS = 500;
const DELAY = String.raw`(\d+(?:\.\d+)?(?:e\d+)?)(?:\s*\*\s*(\d+(?:\.\d+)?))?\s*\)`;
const TIMEOUT_CALL = new RegExp(
  String.raw`\bsetTimeout\s*\(\s*(?:[\w$.]+|\([^()]*\)\s*=>\s*[\w$.]+\([^()]*\))\s*,\s*` + DELAY,
  'g'
);
const SLEEP_CALL = new RegExp(String.raw`\b(?:waitForTimeout|sleep|delay|wait|pause)\s*\(\s*` + DELAY, 'g');
export function scriptSleeps(source) {
  const text = String(source ?? '');
  let n = 0;
  for (const re of [TIMEOUT_CALL, SLEEP_CALL]) {
    for (const [, ms, times] of text.matchAll(re)) {
      if (Number(ms) * Number(times ?? 1) >= SCRIPT_SLEEP_MS) n += 1;
    }
  }
  return n;
}
// firefox-devtools-mcp cuts an attribute value to 27 characters plus "...", and
// marks a walker cut and a line cap in the reply's header and footer.
const CUT_ATTR = /="[^"\n]{0,27}\.\.\."/g;
const DOM_TRUNCATED = '[DOM truncated]';
const LINE_CUT = /\[\+\d+ lines, use maxLines to see more\]/;
const SHELL_SLEEP = /\bsleep\s+\d/g;
// The Claude CLI's replacement for a tool result it wrote to a file instead,
// leaving the model a preview and the file's path.
const PERSISTED = '<persisted-output>';
// The Claude CLI's reply to a call naming a tool the server does not have; the
// call never reaches the server, so the tap never sees it.
export const NO_SUCH_TOOL = /No such tool available/i;
// What an errored call keeps for the question of whether it carried a graded
// value.
const ERROR_KEEP = 4000;
// Where a surface's replies name a file it wrote: playwright-mcp links one
// ([Snapshot](downloads/page-...yml)), firefox-devtools-mcp prints "Result
// saved to: <path> (9.2KB)". Its own output directory, and the attempt's
// downloads/ and playwright-output/, hold only what a surface wrote.
const REPLY_LINK = /\[([^\]\n]{1,80})\]\(([^)\s]+)\)/g;
const SAVED_TO = /\bsaved to:?\s+(\S+)/gi;
const SURFACE_OUTPUT = /(?:^|\/)(?:downloads|playwright-output)\/|\/\.firefox-devtools-mcp\/output\//;
const filePath = (raw) => {
  const p = String(raw ?? '')
    .trim()
    .replace(/^['"`]+|['"`),.;:]+$/g, '')
    .replace(/^file:\/\//, '')
    .replace(/^(?:\.\/)+/, '');
  return p && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : null;
};
// The words of a shell command that can name a file: a path, or a name with
// an extension.
const commandPaths = (command) =>
  String(command ?? '').split(/[\s|;&<>()'"`=]+/).filter((t) => t.includes('/') || /\.\w{1,5}$/.test(t));

// The tools both shipped surfaces annotate readOnlyHint. A failed one left the
// page as it was, so the agent working on past it is a recovery; a failed
// action is one only once the action itself succeeded.
const READ_ONLY_TOOLS = new Set([
  'list_pages', 'take_snapshot', 'resolve_uid_to_selector', 'list_network_requests', 'get_network_request',
  'list_console_messages', 'screenshot_page', 'screenshot_by_uid', 'list_downloads', 'get_firefox_output',
  'get_firefox_info', 'profiler_is_active', 'list_scripts', 'get_script_source', 'get_logpoint_results',
  'browser_console_messages', 'browser_find', 'browser_network_requests', 'browser_network_request',
  'browser_take_screenshot', 'browser_snapshot', 'browser_wait_for',
]);
const urlArg = (c) => {
  try {
    return JSON.parse(c.args ?? '').url ?? null;
  } catch {
    return null;
  }
};

// The job a page action does, across both surfaces, so a failed call is made
// good by another tool of its surface doing the same job, firefox-devtools-mcp's
// pr-review clicking the line a hover_by_uid could not reach, or by a script
// whose code does that job (SCRIPT_DOES, read from the call's arguments):
// playwright-mcp's brochure-minimal filled, through browser_run_code, the
// fields its browser_fill_form and browser_type could not address.
const ACTION_KIND = {
  fill: [
    'fill_by_uid', 'fill_form_by_uid', 'select_option', 'upload_file_by_uid',
    'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_file_upload', 'browser_drop',
  ],
  pointer: ['click_by_uid', 'hover_by_uid', 'drag_by_uid_to_uid', 'browser_click', 'browser_hover', 'browser_drag'],
  key: ['press_key', 'browser_press_key'],
  navigate: ['navigate_page', 'new_page', 'navigate_history', 'browser_navigate', 'browser_navigate_back'],
  dialog: ['accept_dialog', 'dismiss_dialog', 'browser_handle_dialog'],
};
const kindOf = new Map(Object.entries(ACTION_KIND).flatMap(([kind, tools]) => tools.map((t) => [t, kind])));
// The page calls and DOM writes that do each job in a page script or a
// Playwright one. The arguments are JSON, so a quote in the code is \".
const Q = String.raw`\\?["'\x60]`;
const SCRIPT_DOES = {
  fill: new RegExp(
    String.raw`\.(?:fill|type|pressSequentially|selectOption|setInputFiles|check|uncheck)\(|\.(?:value|checked|selectedIndex|textContent|innerText)\s*=(?!=)` +
      String.raw`|execCommand\(${Q}insertText|new\s+(?:Input)?Event\(${Q}(?:input|change)`
  ),
  pointer: /\.(?:click|dblclick|hover|tap|dragTo|dispatchEvent)\(|\bmouse\.(?:click|down|up|move)\(|new\s+(?:Mouse|Pointer|Drag)Event\(/,
  key: /\bkeyboard\.|\.(?:press|type|pressSequentially)\(|new\s+KeyboardEvent\(/,
  navigate: /\.(?:goto|goBack|goForward|reload)\(|\blocation(?:\.href)?\s*=(?!=)|\blocation\.(?:assign|replace|reload)\(|\bhistory\.(?:back|forward|go)\(|\bwindow\.open\(/,
  dialog: new RegExp(String.raw`\.(?:accept|dismiss)\(|\.on\(${Q}dialog|\bwindow\.(?:confirm|alert|prompt)\s*=(?!=)`),
};

// Which of `errors` a later call made good: a later call to the same tool, or
// to a tool of the same kind (to the same url, for one that takes a url),
// succeeded, or a later script whose code does the failed action's job did,
// and a failed script is made good by any later one; or, for a read-only tool,
// at least two later surface calls succeeded. Uids and refs change with every
// snapshot, so no other argument has to match.
function recoveredErrors(own) {
  return own.flatMap((c, i) => {
    if (!c.isError) return [];
    const later = own.slice(i + 1).filter((x) => x.done && !x.isError);
    const url = urlArg(c);
    const kind = kindOf.get(c.tool);
    const sameJob = (x) =>
      (x.tool === c.tool || (kind && kindOf.get(x.tool) === kind)) && (url == null || urlArg(x) === url);
    const scriptDoes = (x) => EVAL_TOOL.test(x.tool) && (EVAL_TOOL.test(c.tool) || (kind && SCRIPT_DOES[kind].test(x.args ?? '')));
    const recovered =
      later.some(sameJob) ||
      later.some(scriptDoes) ||
      (READ_ONLY_TOOLS.has(c.tool) && later.length >= 2);
    return [{ seq: i + 1, tool: c.tool, recovered, text: c.errorText ?? '', args: c.args ?? '' }];
  });
}

// A value distinctive enough that finding it in a call's arguments or reply
// means the call was about it: six characters, or a letter and a digit as in a
// minted code. "true" or 1600 turn up in any JSON or timing.
const distinctive = (v) => v.length >= 6 || (v.length >= 3 && /\p{L}/u.test(v) && /\d/.test(v));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The surface's own errors a row's failure can be charged to: those no later
// call made good, and those whose arguments or reply carried one of `values`,
// the attempt's truth (surface-reach.mjs truthValues), as a whole token,
// whether or not a later call made them good. A value the answer claimed is
// no such evidence: formula-repair's agent rewrote E14, its own wrong cell,
// and a click that carried "e14" read as the tool failing the row.
export function blameToolErrors(errors, values = []) {
  const wanted = values
    .map((v) => String(v).toLowerCase())
    .filter(distinctive)
    .map((v) => ({ v, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, 'u') }));
  const blamed = [];
  for (const e of errors ?? []) {
    const hay = `${e.args ?? ''}\n${e.text ?? ''}`.toLowerCase();
    const touched = wanted.find(({ re }) => re.test(hay))?.v;
    if (!e.recovered || touched) {
      blamed.push({ seq: e.seq, tool: e.tool, why: touched ? `carried ${JSON.stringify(touched.slice(0, 40))}` : 'unrecovered' });
    }
  }
  return blamed;
}

// A codex code-mode row keeps in its exec cells what no MCP event shows
// (row.code_mode, from the rollout): the waits a cell's own code slept between
// tool calls, the catalog discovery (ALL_TOOLS) every row opens with, and the
// outputs codex cut before the model read them. They fold into the counters
// that mean the same on every other row, so a surface whose agents wait in
// exec cells does not read as never waiting. exec_sleeps counts every literal
// delay in a cell's source, the ones inside an evaluate_script function it
// passes included, and the tap counted those again from the call's arguments
// (script_sleeps), so the larger of the two stands for both. A row without
// code_mode is returned as it is.
export function withCodeMode(friction, codeMode) {
  if (!codeMode) return friction;
  const scripts = friction?.script_sleeps ?? 0;
  return {
    ...friction,
    sleeps: (friction?.sleeps ?? 0) - scripts + Math.max(codeMode.exec_sleeps ?? 0, scripts),
    tool_search: (friction?.tool_search ?? 0) + (codeMode.discovery_execs ?? 0),
    harness_truncated: codeMode.truncated_outputs ?? 0,
  };
}

// Reads one attempt's message stream as it arrives. `surface` is the name the
// backends register the condition's own browser server under.
export function createCallRecorder(surface) {
  const calls = new Map();
  // Agent SDK API messages by id, in order: the tools each one called and the
  // output tokens it spent, so a turn spent only on ToolSearch can be counted.
  const turns = new Map();
  let lastTurn = null;
  let anonymous = 0;
  const upsert = (id, patch) => {
    const key = id ?? `anonymous-${++anonymous}`;
    const call = calls.get(key) ?? {};
    Object.assign(call, patch);
    calls.set(key, call);
  };
  const resultOf = (text, isError) => {
    const out = { chars: text.length, isError: Boolean(isError), done: true };
    if (STALE.test(text)) out.stale = true;
    if (text.includes(PERSISTED)) out.persisted = true;
    if (isError) {
      out.errorText = text.slice(0, ERROR_KEEP);
      if (NO_SUCH_TOOL.test(text)) out.unknownTool = true;
    }
    return out;
  };
  const turnOf = (id) => {
    if (!turns.has(id)) turns.set(id, { tools: [], output: 0 });
    return turns.get(id);
  };
  const snapshotCuts = (text) => ({
    cutAttrs: (text.match(CUT_ATTR) ?? []).length,
    dom: text.includes(DOM_TRUNCATED),
    lines: LINE_CUT.test(text),
  });
  // A script's sleeps are counted from its whole source, which can run past
  // what `args` keeps.
  const argsOf = (tool, input) => {
    const json = JSON.stringify(input ?? {});
    return {
      args: json.slice(0, ERROR_KEEP),
      ...(EVAL_TOOL.test(tool ?? '') ? { sleeps: scriptSleeps(json) } : {}),
      ...(malformedUid(input) ? { malformedUid: true } : {}),
      ...(typeof input?.filename === 'string' ? { saves: input.filename } : typeof input?.saveTo === 'string' ? { saves: input.saveTo } : {}),
    };
  };
  // The files the surface wrote where the agent can read them back, by path,
  // each marked when it holds a snapshot: a name a call passed (playwright-mcp's
  // filename, firefox-devtools-mcp's saveTo), a link in a reply
  // ([Snapshot](downloads/page-...yml)) and a "saved to: <path>" line. A
  // snapshot the agent reads back through the Read tool or its shell reached it
  // all the same: playwright-mcp's action replies link a snapshot file instead
  // of printing one.
  const files = new Map();
  const addFile = (path, snapshot) => {
    const p = filePath(path);
    if (p) files.set(p, Boolean(files.get(p)) || snapshot);
  };
  const surfaceFiles = (call, text) => {
    const snapshot = SNAPSHOT_TOOLS.has(call.tool);
    if (call.saves) addFile(call.saves, snapshot);
    for (const [, label, path] of text.matchAll(REPLY_LINK)) addFile(path, snapshot || /^snapshot/i.test(label));
    for (const [, path] of text.matchAll(SAVED_TO)) addFile(path, snapshot);
  };
  // Whether a Read of `path`, or a shell command naming it, reads a file the
  // surface wrote, and whether that file is a snapshot: a known file, or one
  // under a surface's output directory, where a YAML file is a playwright-mcp
  // snapshot.
  const readOf = (paths) => {
    let found = null;
    for (const raw of paths) {
      const p = filePath(raw);
      if (!p) continue;
      for (const [f, snapshot] of files) {
        if (p === f || p.endsWith(`/${f}`) || f.endsWith(`/${p}`)) found = found === 'snapshot' || snapshot ? 'snapshot' : 'output';
      }
      if (!found && SURFACE_OUTPUT.test(p)) found = /\.ya?ml$/i.test(p) ? 'snapshot' : 'output';
    }
    return found;
  };
  let sdk = false;
  let apiRetries = 0;
  let apiRetryMs = 0;

  return {
    // `receivedAt` (optional) is when the message arrived, for the backends
    // whose events carry no timestamp of their own (codex).
    observe(message, receivedAt = null) {
      if (!message || typeof message !== 'object') return;
      const at = Date.parse(message.timestamp ?? '') || receivedAt;
      // The Agent SDK opens its stream with system/init; the scripted backend,
      // which speaks the same message shapes, sends none and retries nothing.
      if (message.type === 'system' && message.subtype === 'init') sdk = true;
      // The SDK retries a failed API request itself and says so only in the
      // stream: playwright-mcp's maze-escape spent 35 retries' waits in its
      // wall time with nothing on the row.
      if (message.type === 'system' && message.subtype === 'api_retry') {
        apiRetries += 1;
        apiRetryMs += Number(message.retry_delay_ms) || 0;
        return;
      }
      // Agent SDK: an MCP tool is mcp__<server>__<tool>; its result comes back
      // as a tool_result block in a later user message.
      if (message.type === 'stream_event' && message.event?.type === 'message_delta') {
        if (!message.parent_tool_use_id && lastTurn != null) {
          const turn = turnOf(lastTurn);
          turn.output = Math.max(turn.output, message.event.usage?.output_tokens ?? 0);
        }
        return;
      }
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        const own = !message.parent_tool_use_id && message.message.id != null;
        if (own) {
          lastTurn = message.message.id;
          const turn = turnOf(lastTurn);
          turn.output = Math.max(turn.output, message.message.usage?.output_tokens ?? 0);
        }
        for (const block of message.message.content) {
          if (block?.type !== 'tool_use') continue;
          if (own) turnOf(lastTurn).tools.push(block.name);
          const m = /^mcp__(.+?)__(.+)$/.exec(block.name ?? '');
          upsert(
            block.id,
            m
              ? { kind: 'mcp', server: m[1], tool: m[2], ...argsOf(m[2], block.input) }
              : block.name === 'Bash'
                ? { kind: 'shell', command: String(block.input?.command ?? ''), startAt: at, background: Boolean(block.input?.run_in_background) }
                : { kind: 'builtin', tool: block.name, ...(block.name === 'Read' && typeof block.input?.file_path === 'string' ? { path: block.input.file_path } : {}) }
          );
        }
        return;
      }
      if (message.type === 'user' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block?.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue;
          const call = calls.get(block.tool_use_id);
          const text = contentText(block.content);
          if (call.kind === 'mcp' && call.server === surface) surfaceFiles(call, text);
          const read = block.is_error ? null : readOf(call.path ? [call.path] : call.kind === 'shell' ? commandPaths(call.command) : []);
          upsert(block.tool_use_id, {
            ...resultOf(text, block.is_error),
            ...(SNAPSHOT_TOOLS.has(call.tool) ? snapshotCuts(text) : {}),
            ...(call.kind === 'shell' ? { endAt: at } : {}),
            ...(read ? { fileRead: read } : {}),
          });
        }
        return;
      }
      // Codex: one item per call, started then completed under the same id.
      if (!/^item\.(started|updated|completed)$/.test(message.type ?? '') || !message.item) return;
      const item = message.item;
      const completed = message.type === 'item.completed';
      if (item.type === 'mcp_tool_call') {
        const text = contentText(item.result?.content) || String(item.error?.message ?? '');
        const args = argsOf(item.tool, item.arguments);
        if (completed && item.server === surface) surfaceFiles({ tool: item.tool, ...args }, text);
        upsert(item.id, {
          kind: 'mcp',
          server: item.server,
          tool: item.tool,
          ...args,
          ...(completed
            ? {
                ...resultOf(
                  text,
                  item.status === 'failed' || Boolean(item.error) ||
                    item.result?.isError === true || item.result?.is_error === true
                ),
                ...(SNAPSHOT_TOOLS.has(item.tool) ? snapshotCuts(text) : {}),
              }
            : {}),
        });
      } else if (item.type === 'command_execution') {
        const known = calls.get(item.id);
        const command = String(item.command ?? '');
        const failed = item.exit_code != null && item.exit_code !== 0;
        const read = completed && !failed ? readOf(commandPaths(command)) : null;
        upsert(item.id, {
          kind: 'shell',
          command,
          startAt: known?.startAt ?? at,
          ...(completed ? { endAt: at } : {}),
          ...(completed ? resultOf(String(item.aggregated_output ?? ''), failed) : {}),
          ...(read ? { fileRead: read } : {}),
        });
      }
    },

    // The row's contamination counts, and what the surface calls say about the
    // run: a tools map (without latency, which only the tap has), snapshot
    // volume and cuts, and friction counts.
    summary() {
      const all = [...calls.values()];
      const mcp = all.filter((c) => c.kind === 'mcp');
      // A call the client rejected for naming no tool of the server's never
      // reached the surface.
      const rejected = mcp.filter((c) => c.server === surface && c.unknownTool);
      const own = mcp.filter((c) => c.server === surface && !c.unknownTool);
      const searchTurns = [...turns.values()].filter((t) => t.tools.length && t.tools.every((n) => n === 'ToolSearch'));
      const foreign = {};
      for (const c of mcp) {
        if (c.server !== surface) foreign[c.server] = (foreign[c.server] ?? 0) + 1;
      }
      const tools = {};
      for (const c of own) {
        const t = (tools[c.tool] ??= { calls: 0, errors: 0, chars: 0, p50_ms: null });
        t.calls += 1;
        t.errors += c.isError ? 1 : 0;
        t.chars += c.chars ?? 0;
      }
      const snaps = own.filter((c) => SNAPSHOT_TOOLS.has(c.tool));
      let actions = 0;
      let actThenSnap = 0;
      own.forEach((c, i) => {
        if (!ACTION_TOOLS.has(c.tool)) return;
        actions += 1;
        if (SNAPSHOT_TOOLS.has(own[i + 1]?.tool)) actThenSnap += 1;
      });
      const shellSleeps = all
        .filter((c) => c.kind === 'shell')
        .reduce((n, c) => n + (c.command.match(SHELL_SLEEP) ?? []).length, 0);
      const scriptSleepCount = own.reduce((n, c) => n + (c.sleeps ?? 0), 0);
      const reads = (kind) => all.filter((c) => c.fileRead === kind);
      const snapshotReads = reads('snapshot');
      const fileChars = snapshotReads.reduce((n, c) => n + (c.chars ?? 0), 0);
      return {
        surface_calls: own.length,
        // Calls to another MCP server only. A call naming a tool the row's own
        // server lacks (browser_triple_click on firefox-devtools-mcp) is
        // unknown_tools; a row without friction.malformed_uid, which this
        // recorder adds, counted it here too.
        foreign_tools: mcp.filter((c) => c.server !== surface).length,
        foreign_servers: foreign,
        tools,
        snapshot: {
          calls: snaps.length,
          // The snapshot files read back (file_reads, file_chars) included.
          chars: snaps.reduce((n, c) => n + (c.chars ?? 0), 0) + fileChars,
          truncated: snaps.filter((c) => c.cutAttrs || c.dom || c.lines).length,
          cut_attrs: snaps.reduce((n, c) => n + (c.cutAttrs ?? 0), 0),
          line_cut: snaps.filter((c) => c.lines).length,
          dom_truncated: snaps.filter((c) => c.dom).length,
          file_reads: snapshotReads.length,
          file_chars: fileChars,
        },
        friction: {
          actions,
          act_then_snap: actThenSnap,
          eval_calls: own.filter((c) => EVAL_TOOL.test(c.tool)).length,
          // A stale reply to a call whose uid was malformed is malformed_uid.
          stale_uid: own.filter((c) => c.stale && !c.malformedUid).length,
          malformed_uid: own.filter((c) => c.isError && c.malformedUid).length,
          // The other files the surface wrote that the agent read back: a
          // saved script result, a network dump, a download.
          output_file_reads: reads('output').length,
          output_file_chars: reads('output').reduce((n, c) => n + (c.chars ?? 0), 0),
          ...(sdk ? { api_retries: apiRetries, api_retry_s: Math.round(apiRetryMs / 100) / 10 } : {}),
          restarts: own.filter((c) => RESTART_TOOL.test(c.tool)).length,
          // Wait-tool calls, shell sleeps, and the sleeps inside script calls,
          // which script_sleeps counts again on its own: a row without it was
          // written before sleeps counted them.
          sleeps: shellSleeps + own.filter((c) => WAIT_TOOL.test(c.tool)).length + scriptSleepCount,
          script_sleeps: scriptSleepCount,
          // Claude CLI tool discovery: ToolSearch calls, the API turns that
          // called nothing else, and the output those turns spent.
          tool_search: all.filter((c) => c.kind === 'builtin' && c.tool === 'ToolSearch').length,
          tool_search_turns: searchTurns.length,
          tool_search_output_tokens: searchTurns.reduce((n, t) => n + t.output, 0),
          // Tool results the Claude CLI swapped for a <persisted-output> preview:
          // the surface's, then the shell's and the built-in tools'.
          persisted: own.filter((c) => c.persisted).length,
          persisted_other: all.filter((c) => c.persisted && !(c.kind === 'mcp' && c.server === surface)).length,
          unknown_tools: rejected.length,
        },
        tool_errors: recoveredErrors(own),
        // When each shell command ran, for telling a browser it started from the
        // surface's own (scripts/foreign-browser.mjs). A background command may
        // act at any later time, so it has no end.
        shell_windows: all
          .filter((c) => c.kind === 'shell' && c.startAt)
          .map((c) => [c.startAt, c.background ? null : c.endAt ?? null]),
      };
    },
  };
}

// --- the passthrough --------------------------------------------------------

// Splits a byte stream into newline-delimited JSON-RPC messages for `onMessage`,
// never altering what it reads. A line that is not JSON (a server logging to
// stdout) is skipped. Each chunk is searched only once, and a line is joined
// only when its newline arrives, so a reply spanning many chunks costs time
// linear in its size. Splitting bytes is safe: 0x0A never occurs inside a
// multi-byte UTF-8 sequence.
function lineReader(onMessage) {
  let partial = [];
  const onLine = (bytes) => {
    const line = bytes.toString('utf8');
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (message && typeof message === 'object') onMessage(message, bytes.length);
    }
  };
  return (chunk) => {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
      const tail = chunk.subarray(start, nl);
      onLine(partial.length ? Buffer.concat([...partial, tail]) : tail);
      partial = [];
      start = nl + 1;
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  };
}

function runTap(argv) {
  const sep = argv.indexOf('--');
  const logAt = argv.indexOf('--log');
  const logPath = logAt !== -1 && logAt < sep ? argv[logAt + 1] : null;
  const [command, ...args] = sep === -1 ? [] : argv.slice(sep + 1);
  if (!command) {
    process.stderr.write('usage: node mcp-tap.mjs --log <file> -- <command> [args...]\n');
    process.exit(2);
  }
  // Logging is best-effort: a log that cannot be written must never break the
  // server it watches.
  let logging = Boolean(logPath);
  const log = (record) => {
    if (!logging) return;
    try {
      appendFileSync(logPath, JSON.stringify(record) + '\n');
    } catch {
      logging = false;
    }
  };
  if (logging) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
    } catch {}
  }

  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  log({ type: 'start', at: Date.now(), pid: child.pid ?? null });

  // Requests the client sent, by id. A server-initiated request (method set)
  // has ids of its own, and the client's reply to one is not a call, so only
  // responses to these are matched.
  const pending = new Map();
  let seq = 0;
  const fromClient = lineReader((message, bytes) => {
    if (message.id == null || typeof message.method !== 'string') return;
    pending.set(message.id, {
      method: message.method,
      tool: message.params?.name,
      argBytes: Buffer.byteLength(JSON.stringify(message.params?.arguments ?? {})),
      at: Date.now(),
      t0: performance.now(),
      requestBytes: bytes,
    });
  });
  const fromServer = lineReader((message, bytes) => {
    if (message.id == null || typeof message.method === 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    const ms = Math.round((performance.now() - request.t0) * 10) / 10;
    if (request.method === 'tools/call') {
      const result = message.result;
      log({
        type: 'call',
        seq: ++seq,
        tool: request.tool,
        at: request.at,
        ms,
        argBytes: request.argBytes,
        resultChars: message.error
          ? String(message.error.message ?? '').length
          : contentText(result?.content).length,
        bytes,
        isError: Boolean(message.error) || result?.isError === true,
      });
    } else if (request.method === 'tools/list') {
      log({ type: 'tools/list', at: request.at, ms, tools: message.result?.tools ?? null });
    } else if (request.method === 'initialize') {
      log({
        type: 'initialize',
        at: request.at,
        ms,
        protocolVersion: message.result?.protocolVersion ?? null,
        serverInfo: message.result?.serverInfo ?? null,
      });
    }
  });

  process.stdin.on('data', fromClient);
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  // A reply's record is written before the reply is handed on, so whoever
  // reads the log after the client has seen a reply finds its record there.
  child.stdout.on('data', (chunk) => {
    fromServer(chunk);
    if (!process.stdout.write(chunk)) {
      child.stdout.pause();
      process.stdout.once('drain', () => child.stdout.resume());
    }
  });
  // The client went away mid-write: nothing can reach it any more.
  process.stdout.on('error', () => child.kill('SIGTERM'));

  // A signal goes on to the server, whose exit ends the tap. The clients this
  // runs under escalate to SIGKILL about 2s after a SIGTERM, which would orphan
  // a server still shutting down, so the tap escalates first.
  let killTimer = null;
  let finished = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      if (finished) return;
      // Written first, since a SIGKILL may follow before the server closes.
      log({ type: 'signal', at: Date.now(), signal });
      child.kill(signal);
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
    });
  }
  const finish = (code) => {
    finished = true;
    clearTimeout(killTimer);
    process.stdin.unpipe(child.stdin);
    process.stdin.destroy();
    process.exitCode = code;
  };
  child.on('error', (error) => {
    process.stderr.write(`mcp-tap: cannot start ${command}: ${error.message}\n`);
    log({ type: 'exit', at: Date.now(), error: error.message });
    finish(1);
  });
  // 'close' waits for the server's stdout to end, so every byte it wrote has
  // been handed on before the tap lets itself exit.
  child.on('close', (code, signal) => {
    log({ type: 'exit', at: Date.now(), code, signal });
    finish(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
  });
}

// Compared as real paths: import.meta.url is percent-encoded and symlink-free
// (macOS /tmp is /private/tmp), while argv[1] is neither.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(TAP);
  } catch {
    return false;
  }
})();
if (invokedDirectly) runTap(process.argv.slice(2));
