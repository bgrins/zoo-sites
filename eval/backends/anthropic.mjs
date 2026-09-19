// Anthropic backend: drives tasks through the Claude Agent SDK.
// Backend interface (shared with backends/codex.mjs):
//   run({ prompt, model, effort, condition, env, cwd, onMessage, onOutputTokens,
//         mcpStdio, abortController }) ->
//     { text, turns, input_tokens, cache_creation, cache_read, output_tokens,
//       cost_usd, duration_ms, api_duration_ms, stream_errors? }
// `input_tokens` is the UNCACHED remainder only, never the total, so that
// input_tokens + cache_creation + cache_read is total input for every backend
// and the three columns stay additive. Anthropic's SDK already reports it that
// way; codex normalizes to it (see backends/codex.mjs).
// The MCP server is spawned over stdio from `mcpStdio` ({command, args}).
// onMessage (optional): called with every raw agent message as it streams
// (thinking, tool calls, tool results, final result) for transcript logging.
// onOutputTokens (optional): called with the run's output tokens so far, for
// run.mjs's --max-output ceiling. A backend that cannot count mid-run never
// calls it.
// stream_errors (optional): errors the backend recovered from before the run
// completed, kept so they stay visible on the row.
// A run that ends in an API error, rather than an answer, throws; run.mjs
// retries it when the message reads transient. A thrown error carries `spend`
// (the same token and cost fields) when the attempt spent anything the backend
// could measure, so run.mjs can report it.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { priceTokens } from './pricing.mjs';

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The built-in tool set is pinned rather than left to the CLI's default, which
// offered live web (WebFetch, WebSearch), subagents and orchestration (Task,
// Workflow, SendMessage), scheduling (Cron*, ScheduleWakeup, Monitor) and push
// notifications: none belong in a local browser task, and each lets a run
// differ from its pair by more than the tool surface. ToolSearch stays because
// the MCP tools are deferred behind it, and TaskOutput/TaskStop because a
// background Bash command needs them. Every condition gets a shell so the ONLY
// difference is how the browser is driven; a cost/turn gap must measure the tool
// surface, never shell access.
const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'ToolSearch', 'TaskOutput', 'TaskStop'];
// Denied by name as well, so a CLI that widened `tools` still could not hand
// these out.
const DISALLOWED_TOOLS = [
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'Workflow', 'SendMessage',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Monitor', 'PushNotification',
];
// dontAsk denies every tool not allowed here, so Write and Edit need a rule or
// each call burns a turn on a denial. An Edit rule covers Write too, and the
// leading `//` makes the path absolute: file tools write in the attempt
// directory only, as codex's workspace-write sandbox does.
const allowedTools = (cwd) => ['mcp__firefox', 'Bash', ...(cwd ? [`Edit(/${cwd}/**)`] : [])];

// Recorded in each run's meta, so results from before and after a policy
// change stay distinguishable.
export const TOOL_POLICY = {
  tools: TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  allowedTools: allowedTools('/<attempt dir>'),
  permissionMode: 'dontAsk',
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
};

// Output tokens per API message. The SDK streams an assistant message once per
// content block, each carrying the usage as of message_start, so those alone
// covered 11-43% of the true output in stored runs; message_delta carries the
// message's cumulative output. Both are max-ed per message id, and the result
// message never feeds the running count (it repeats the total).
function usageTracker() {
  const byId = new Map();
  let current = null;
  const take = (id, usage) => {
    if (!id || !usage) return;
    const u = byId.get(id) ?? { input_tokens: 0, cache_creation: 0, cache_read: 0, output_tokens: 0 };
    u.input_tokens = Math.max(u.input_tokens, usage.input_tokens ?? 0);
    u.cache_creation = Math.max(u.cache_creation, usage.cache_creation_input_tokens ?? 0);
    u.cache_read = Math.max(u.cache_read, usage.cache_read_input_tokens ?? 0);
    u.output_tokens = Math.max(u.output_tokens, usage.output_tokens ?? 0);
    byId.set(id, u);
  };
  const total = (key) => [...byId.values()].reduce((n, u) => n + u[key], 0);
  return {
    // Returns true when the message changed a count.
    observe(message) {
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        take(message.message?.id, message.message?.usage);
        return true;
      }
      if (message.type === 'stream_event' && !message.parent_tool_use_id) {
        const event = message.event;
        if (event?.type === 'message_start') {
          current = event.message?.id ?? null;
          take(current, event.message?.usage);
        } else if (event?.type === 'message_delta') {
          take(current, event.usage);
          return true;
        }
      }
      return false;
    },
    output: () => total('output_tokens'),
    requests: () => byId.size,
    totals: () => ({
      input_tokens: total('input_tokens'),
      cache_creation: total('cache_creation'),
      cache_read: total('cache_read'),
      output_tokens: total('output_tokens'),
    }),
  };
}

export function agentOptions({ model, effort, env, cwd, mcpStdio, abortController }) {
  return {
    model,
    permissionMode: TOOL_POLICY.permissionMode,
    cwd,
    settingSources: TOOL_POLICY.settingSources,
    tools: TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    allowedTools: allowedTools(cwd),
    strictMcpConfig: TOOL_POLICY.strictMcpConfig,
    persistSession: TOOL_POLICY.persistSession,
    // Only for the message_start/message_delta usage above; content deltas are
    // dropped before they reach the transcript.
    includePartialMessages: true,
    ...(effort ? { effort } : {}),
    // Lets run.mjs stop a task on its backend-agnostic token/wall ceilings.
    ...(abortController ? { abortController } : {}),
    env: env ?? process.env,
    mcpServers: {
      firefox: { type: 'stdio', command: mcpStdio.command, args: mcpStdio.args },
    },
  };
}

export async function run({
  prompt, model, effort, env, cwd, onMessage, onOutputTokens, mcpStdio, abortController,
}) {
  const options = agentOptions({ model, effort, env, cwd, mcpStdio, abortController });
  const started = Date.now();
  const tracker = usageTracker();
  // What an attempt spent when no result message will ever say: an abort, or a
  // stream that died. The cost is priced from the observed tokens.
  const partialSpend = () => {
    const counts = tracker.totals();
    const cost_usd = priceTokens(model ?? DEFAULT_MODEL, counts, 'anthropic', tracker.requests());
    return { ...counts, cost_usd, cost_estimated: true };
  };
  // A run can emit MORE THAN ONE result message: if the agent starts a background
  // Bash task (agents do this to wait for an async page reply), its completion
  // re-invokes the agent and the SDK emits a fresh result for that continuation.
  // `usage` and `num_turns` are PER-SEGMENT while `total_cost_usd` and the
  // durations are CUMULATIVE — so usage must be summed and the rest taken at its
  // last value. Keeping only the last result reports a 26-turn/2392-token run as
  // 1 turn and 53 tokens, silently understating the suite's primary metric by 45x.
  const results = [];
  const resultSpend = () => {
    const sum = (pick) => results.reduce((n, r) => n + (pick(r.usage ?? {}) ?? 0), 0);
    return {
      input_tokens: sum((u) => u.input_tokens),
      cache_creation: sum((u) => u.cache_creation_input_tokens),
      cache_read: sum((u) => u.cache_read_input_tokens),
      output_tokens: sum((u) => u.output_tokens),
      cost_usd: results.at(-1).total_cost_usd ?? null,
    };
  };
  try {
    for await (const message of query({ prompt, options })) {
      const counted = tracker.observe(message);
      if (message.type === 'stream_event' && message.event?.type !== 'message_delta') continue;
      onMessage?.(message);
      if (counted) onOutputTokens?.(tracker.output());
      if (message.type === 'result') {
        results.push(message);
      }
    }
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    // An API failure ("API Error: 529 ...") arrives as a result flagged
    // is_error, and the SDK throws "Claude Code returned an error result: <its
    // text>" once the CLI exits, so that result's exact spend is already here.
    error.spend ??= results.at(-1)?.is_error ? resultSpend() : partialSpend();
    throw error;
  }
  if (!results.length) {
    const error = new Error('no result message from agent');
    error.spend = partialSpend();
    throw error;
  }
  const last = results.at(-1);
  // The same failure when the CLI exits cleanly. Either way run.mjs retries it
  // when the text reads transient.
  if (last.is_error) {
    const error = new Error(
      'agent result is_error' +
        (last.api_error_status != null ? ` (API status ${last.api_error_status})` : '') +
        `: ${String(last.result ?? last.errors?.join('; ') ?? last.subtype).slice(0, 300)}`
    );
    error.spend = resultSpend();
    throw error;
  }
  return {
    text: last.subtype === 'success' ? last.result : `[${last.subtype}]`,
    turns: results.reduce((n, r) => n + (r.num_turns ?? 0), 0),
    ...resultSpend(),
    duration_ms: last.duration_ms ?? Date.now() - started,
    // Time spent in API calls (vs tool execution etc.), when reported.
    api_duration_ms: last.duration_api_ms ?? null,
    segments: results.length,
  };
}
