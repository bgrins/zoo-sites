// Scripted backend: no model. It runs the task's golden-path driver
// (verify-drivers/) against the condition's own MCP server, started from the
// command run.mjs hands every backend (through the tap), and answers with the
// driver's text and fields. A sweep through it costs nothing, so CI can run
// run.mjs, its reports and the A/B pipeline end to end.
//
// The interface of backends/anthropic.mjs (see its header), plus:
//   run() also takes `task` and `pages`, the attempt's task and pages server,
//   and resolves with `fields`, the driver's structured answer, which run.mjs
//   grades without calling the paid extractor;
//   supportsCondition(condition) and supportsTask(task), which run.mjs checks
//   before any browser starts;
//   ownsFields(model), whether a model's rows skip the extractor;
//   extract({ answer }), the stub extractor EVAL_EXTRACTOR=scripted selects
//   in extract.mjs;
//   MODELS, the only ids --model may name. 'golden-path' answers with what the
//   driver returns. 'wrong-fields' drives the same path and answers with the
//   driver's first wrongFields, which the gate proves its validator rejects,
//   so a run under it is a negative control: every row has to FAIL.
//   The TEXT_MODELS answer with text alone, so run.mjs grades them through the
//   extractor path a paid row takes, and the stub returns the driver's fields
//   for that answer as { value, quote } pairs. 'extracted' appends a
//   `path = value` line per field and quotes those lines, so every row has to
//   PASS. 'misquoted' answers with those lines alone and quotes them in a form
//   the answer never contains, so the quote gate nulls every field and every
//   row has to FAIL. The gate keeps a distinctive string the answer states
//   whatever its quote, so its lines withhold every string value and its
//   answer drops the driver's prose, which states them.
//   'extractor-down' makes every extraction throw, so run.mjs grades null
//   fields, flags extraction_failed, and every row has to FAIL.
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

import { copyFileSync } from 'node:fs';
import { startMcpServer } from '../mcp-stdio.mjs';
import { makeHelpers } from '../verify-drivers/helpers.mjs';
import { DRIVERS } from '../verify-drivers/index.mjs';

export const DEFAULT_MODEL = 'golden-path';
const TEXT_MODELS = ['extracted', 'misquoted', 'extractor-down'];
export const MODELS = [DEFAULT_MODEL, 'wrong-fields', ...TEXT_MODELS];
export const ownsFields = (model) => !TEXT_MODELS.includes(model ?? DEFAULT_MODEL);
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
// The raw extraction for each answer a TEXT_MODELS attempt gave, filled by
// run() and read by extract(); EXTRACTOR_DOWN marks one that has to fail.
const STUB_EXTRACTIONS = new Map();
const EXTRACTOR_DOWN = Symbol('extractor-down');

// `value` as the { value, quote } pairs a faithful extractor returns under
// `schema`, the shape extract.mjs's quotedSchema asks for. Each leaf's line is
// pushed onto `lines`; its quote is that line, or under `misquote` a form no
// answer contains, which the quote gate has to null, and the line withholds a
// string value.
function quotePairs(value, schema, path, lines, misquote) {
  if (!schema) return null;
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, child]) => [
        key,
        quotePairs(value[key] ?? null, child, path ? `${path}.${key}` : key, lines, misquote),
      ])
    );
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return null;
    return value.map((item, i) => quotePairs(item, schema.items, `${path}[${i}]`, lines, misquote));
  }
  if (value === null || value === undefined) return { value: null, quote: null };
  const line = `${path} = ${value}`;
  lines.push(misquote && typeof value === 'string' ? `${path} = [withheld]` : line);
  return { value, quote: misquote ? `${path}: «${value}»` : line };
}

export async function extract({ answer }) {
  if (!STUB_EXTRACTIONS.has(answer)) {
    throw new Error('extraction failed: the scripted extractor reads only answers the scripted backend gave');
  }
  const raw = STUB_EXTRACTIONS.get(answer);
  if (raw === EXTRACTOR_DOWN) throw new Error('extraction failed: extractor-down');
  return { raw, output_tokens: 0, cost_usd: 0 };
}

// How long a stopped attempt waits for its driver to finish. Once stopped, the
// driver's next MCP call or sleep throws, so only Node-side HTTP it already
// started is left, and that answers from a local server in milliseconds.
const SETTLE_MS = 10_000;

export async function run({ task, pages, model, condition, env, cwd, onMessage, mcpStdio, abortController, videoPath }) {
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
  const server = await startMcpServer({
    command: mcpStdio.command,
    args: mcpStdio.args,
    env: mcpStdio.env,
    baseEnv: env ?? process.env,
    cwd,
  });
  if (videoPath) {
    try {
      const started = await server.call('screencast_start', { frameRate: 12 });
      if (started.isError) throw new Error(`screencast_start: ${JSON.stringify(started.content)}`);
    } catch (error) {
      await server.close();
      throw error;
    }
  }
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
      if (videoPath && (name === 'navigate_page' || name === 'new_page')) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
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
  let videoError = null;
  try {
    if (videoPath) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const stopped = await server.call('screencast_stop', {});
      const message = (stopped.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const saved = !stopped.isError && message.match(/Screencast saved to: (.+\.webm)/)?.[1];
      if (!saved) throw new Error(`screencast_stop: ${message}`);
      copyFileSync(saved, videoPath);
    }
  } catch (error) {
    videoError = error;
  } finally {
    await server.close();
  }
  failure ??= videoError;
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
  if (TEXT_MODELS.includes(mode)) {
    const lines = [];
    const raw = quotePairs(fields, task.answerSchema, '', lines, mode === 'misquoted');
    if (lines.length) text = mode === 'misquoted' ? lines.join('\n') : `${text}\n\n${lines.join('\n')}`;
    STUB_EXTRACTIONS.set(text, mode === 'extractor-down' ? EXTRACTOR_DOWN : raw);
    fields = undefined;
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
