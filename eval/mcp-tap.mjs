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

// The {command, args} that runs `spec` through the tap, logging to `logPath`.
export function tapSpec(spec, logPath) {
  return {
    command: process.execPath,
    args: [TAP, '--log', logPath, '--', spec.command, ...(spec.args ?? [])],
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
// firefox-devtools-mcp's stale-uid errors, then playwright-mcp's stale-ref one.
const STALE = /stale\/invalid|from a stale snapshot|invalid or from an old snapshot|not found in the current page snapshot/i;
// firefox-devtools-mcp cuts an attribute value to 27 characters plus "...", and
// marks a walker cut and a line cap in the reply's header and footer.
const CUT_ATTR = /="[^"\n]{0,27}\.\.\."/g;
const DOM_TRUNCATED = '[DOM truncated]';
const LINE_CUT = /\[\+\d+ lines, use maxLines to see more\]/;
const SHELL_SLEEP = /\bsleep\s+\d/g;

// Reads one attempt's message stream as it arrives. `surface` is the name the
// backends register the condition's own browser server under.
export function createCallRecorder(surface) {
  const calls = new Map();
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
    return out;
  };
  const snapshotCuts = (text) => ({
    cutAttrs: (text.match(CUT_ATTR) ?? []).length,
    dom: text.includes(DOM_TRUNCATED),
    lines: LINE_CUT.test(text),
  });

  return {
    observe(message) {
      if (!message || typeof message !== 'object') return;
      // Agent SDK: an MCP tool is mcp__<server>__<tool>; its result comes back
      // as a tool_result block in a later user message.
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block?.type !== 'tool_use') continue;
          const m = /^mcp__(.+?)__(.+)$/.exec(block.name ?? '');
          upsert(
            block.id,
            m
              ? { kind: 'mcp', server: m[1], tool: m[2] }
              : block.name === 'Bash'
                ? { kind: 'shell', command: String(block.input?.command ?? '') }
                : { kind: 'builtin', tool: block.name }
          );
        }
        return;
      }
      if (message.type === 'user' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block?.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue;
          const call = calls.get(block.tool_use_id);
          const text = contentText(block.content);
          upsert(block.tool_use_id, {
            ...resultOf(text, block.is_error),
            ...(SNAPSHOT_TOOLS.has(call.tool) ? snapshotCuts(text) : {}),
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
        upsert(item.id, {
          kind: 'mcp',
          server: item.server,
          tool: item.tool,
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
        upsert(item.id, {
          kind: 'shell',
          command: String(item.command ?? ''),
          ...(completed
            ? resultOf(String(item.aggregated_output ?? ''), item.exit_code != null && item.exit_code !== 0)
            : {}),
        });
      }
    },

    // The row's contamination counts, and what the surface calls say about the
    // run: a tools map (without latency, which only the tap has), snapshot
    // volume and cuts, and friction counts.
    summary() {
      const all = [...calls.values()];
      const mcp = all.filter((c) => c.kind === 'mcp');
      const own = mcp.filter((c) => c.server === surface);
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
      return {
        surface_calls: own.length,
        foreign_tools: mcp.length - own.length,
        foreign_servers: foreign,
        tools,
        snapshot: {
          calls: snaps.length,
          chars: snaps.reduce((n, c) => n + (c.chars ?? 0), 0),
          truncated: snaps.filter((c) => c.cutAttrs || c.dom || c.lines).length,
          cut_attrs: snaps.reduce((n, c) => n + (c.cutAttrs ?? 0), 0),
          line_cut: snaps.filter((c) => c.lines).length,
          dom_truncated: snaps.filter((c) => c.dom).length,
        },
        friction: {
          actions,
          act_then_snap: actThenSnap,
          eval_calls: own.filter((c) => EVAL_TOOL.test(c.tool)).length,
          stale_uid: own.filter((c) => c.stale).length,
          restarts: own.filter((c) => RESTART_TOOL.test(c.tool)).length,
          sleeps: shellSleeps + own.filter((c) => WAIT_TOOL.test(c.tool)).length,
        },
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
