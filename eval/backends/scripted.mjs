// Scripted backend: no model. It runs the task's golden-path driver
// (verify-drivers/) against the condition's own MCP server, started from the
// command run.mjs hands every backend (through the tap), and answers with the
// driver's text and fields. A sweep through it costs nothing, so CI can run
// run.mjs, its reports and the A/B pipeline end to end.
//
// The interface of backends/anthropic.mjs (see its header), plus:
//   run() also takes `task` and `pages`, the attempt's task and pages server,
//   and resolves with `fields`, the driver's structured answer, which run.mjs
//   grades without calling the paid extractor (OWN_FIELDS);
//   supportsCondition(condition) and supportsTask(task), which run.mjs checks
//   before any browser starts;
//   MODELS, the only ids --model may name. 'golden-path' answers with what the
//   driver returns. 'wrong-fields' drives the same path and answers with the
//   driver's first wrongFields, which the gate proves its validator rejects,
//   so a run under it is a negative control: every row has to FAIL.
// Every tool call streams to onMessage as an Agent SDK tool_use and tool_result
// pair, and the answer as a result message, so transcript.mjs, tool-stats.mjs,
// triage.mjs and surface reach read a scripted row like an anthropic one.
//
// Usage is fixed by the answer and spends nothing: no input or cache tokens,
// cost 0, and output_tokens set to a quarter of the answer's characters, a
// stand-in that gives ab.mjs a nonzero figure to pair. Two identical builds tie
// on it only where the answer's length is fixed under a seed; a task that mints
// its values with randomBytes can differ by a token. `turns` counts the tool
// calls plus the answer.

import { startMcpServer } from '../mcp-stdio.mjs';
import { makeHelpers } from '../verify-drivers/helpers.mjs';
import { DRIVERS } from '../verify-drivers/index.mjs';

export const DEFAULT_MODEL = 'golden-path';
export const MODELS = [DEFAULT_MODEL, 'wrong-fields'];
export const OWN_FIELDS = true;
// Nothing reasons, so every level any backend takes is accepted and ignored.
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const TOOL_POLICY = {
  tools: "the golden-path driver's calls to the condition's MCP server",
  shell: false,
};

const DEVTOOLS = 'firefox-devtools-mcp';
// The drivers call firefox-devtools-mcp's tools by name, so no other surface
// can run them.
export const supportsCondition = (condition) => condition === DEVTOOLS || condition.startsWith(`${DEVTOOLS}@`);
export const supportsTask = (task) => Boolean(DRIVERS[task.id]);

// The name run.mjs and the other backends register the browser server under.
const SURFACE_SERVER = 'firefox';
const NO_USAGE = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
// What a failed attempt spent, in the shape run.mjs reads off the throw.
const NO_SPEND = { input_tokens: 0, cache_creation: 0, cache_read: 0, output_tokens: 0, cost_usd: 0 };
// How long a stopped attempt waits for its driver to finish. Once stopped, the
// driver's next MCP call or sleep throws, so only Node-side HTTP it already
// started is left, and that answers from a local server in milliseconds.
const SETTLE_MS = 10_000;

export async function run({ task, pages, model, condition, env, cwd, onMessage, mcpStdio, abortController }) {
  if (!supportsCondition(condition)) {
    throw new Error(`the scripted backend runs firefox-devtools-mcp conditions only, not ${condition}`);
  }
  const mode = model ?? DEFAULT_MODEL;
  if (!MODELS.includes(mode)) throw new Error(`the scripted backend has no model "${mode}" (${MODELS.join(', ')})`);
  const driver = DRIVERS[task.id];
  if (!driver) throw new Error(`the scripted backend has no golden-path driver for task "${task.id}"`);
  const started = Date.now();
  const signal = abortController?.signal;
  const stopError = () => new Error(`scripted run aborted: ${signal.reason ?? 'stopped'}`);
  let ended = false;
  const emit = (message) => ended || onMessage?.({ ...message, timestamp: new Date().toISOString() });
  const server = await startMcpServer({ command: mcpStdio.command, args: mcpStdio.args, baseEnv: env ?? process.env, cwd });
  let calls = 0;
  const mcp = async (name, toolArgs = {}) => {
    if (signal?.aborted) throw stopError();
    const n = ++calls;
    const id = `toolu_scripted_${n}`;
    emit({
      type: 'assistant',
      message: {
        id: `msg_scripted_${n}`,
        role: 'assistant',
        model: mode,
        content: [{ type: 'tool_use', id, name: `mcp__${SURFACE_SERVER}__${name}`, input: toolArgs }],
        usage: NO_USAGE,
      },
      parent_tool_use_id: null,
    });
    const replied = (content, isError) =>
      emit({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
        parent_tool_use_id: null,
      });
    try {
      const result = await server.call(name, toolArgs);
      // Text blocks only: a screenshot's base64 would bloat the transcript, and
      // no reader of one looks at images.
      replied((result.content ?? []).filter((c) => c.type === 'text'), Boolean(result.isError));
      return result;
    } catch (error) {
      replied(String(error?.message ?? error), true);
      throw error;
    }
  };
  const helpers = makeHelpers({ mcp, pages, signal });
  helpers.taskId = task.id;
  helpers.phase = 'driver';
  // A driver that sets this.wrongFields while it runs writes to its own
  // attempt's copy, never to one a parallel attempt of the same task reads.
  const attempt = Object.create(driver);
  // A harness stop has to end the attempt even while the driver waits on a
  // call, so the driver races the abort.
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(stopError());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  const driving = Promise.resolve().then(() => attempt.run(helpers, { pages }));
  let out;
  let failure = null;
  try {
    out = await Promise.race([driving, stopped]);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    // Whatever the driver does from here on must not write past the attempt's
    // transcript.
    ended = true;
  }
  signal?.removeEventListener('abort', onAbort);
  await server.close();
  if (failure) {
    // run.mjs resets the pages server for a retry as soon as this returns, so
    // the stopped driver has to finish first or its Node-side requests would
    // land in the retry's state.
    let timer;
    const settled = await Promise.race([
      driving.then(() => true, () => true),
      new Promise((resolve) => (timer = setTimeout(resolve, SETTLE_MS, false))),
    ]);
    clearTimeout(timer);
    if (!settled) console.error(`[scripted] ${task.id}: the driver was still running ${SETTLE_MS / 1000}s after it stopped`);
    failure.spend ??= NO_SPEND;
    throw failure;
  }
  let text = typeof out === 'string' ? out : String(out?.text ?? '');
  // Null, not absent, when a driver returns bare text: run.mjs then grades
  // null fields rather than paying the extractor for them.
  let fields = typeof out === 'string' ? null : (out?.fields ?? null);
  if (mode === 'wrong-fields') {
    const wrong = [attempt.wrongFields ?? []].flat()[0];
    if (wrong === undefined) {
      throw Object.assign(new Error(`task "${task.id}" has no wrongFields for the wrong-fields model`), { spend: NO_SPEND });
    }
    fields = wrong;
    text = JSON.stringify(wrong);
  }
  const duration_ms = Date.now() - started;
  const output_tokens = Math.ceil(text.length / 4);
  emit({
    type: 'assistant',
    message: {
      id: `msg_scripted_${calls + 1}`,
      role: 'assistant',
      model: mode,
      content: [{ type: 'text', text }],
      usage: { ...NO_USAGE, output_tokens },
    },
    parent_tool_use_id: null,
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    num_turns: calls + 1,
    duration_ms,
    total_cost_usd: 0,
    usage: { ...NO_USAGE, output_tokens },
  });
  return {
    text,
    fields,
    turns: calls + 1,
    input_tokens: 0,
    cache_creation: 0,
    cache_read: 0,
    output_tokens,
    cost_usd: 0,
    duration_ms,
    api_duration_ms: null,
  };
}
