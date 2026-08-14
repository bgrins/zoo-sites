// Codex backend: drives tasks through OpenAI's Codex SDK (@openai/codex-sdk),
// which shells out to the `codex` CLI and streams JSONL events back.
// Same interface as backends/anthropic.mjs (see its header), including the
// onMessage transcript sink (receives raw ThreadEvents).
//
// The MCP server is spawned over stdio (`mcpStdio`) through a `mcp_servers`
//   config override (the SDK flattens `config` into --config flags). Tools
//   are auto-approved (default_tools_approval_mode) since codex otherwise
//   cancels non-read-only MCP tools under approval 'never'. Commands run in
//   a network-enabled workspace-write sandbox (the fixtures are loopback
//   HTTP), so the shell never differs between conditions.
//
// api_duration_ms is not reported by codex; cost_usd is computed locally from
// the reported token counts (codex reports no price of its own).

import { Codex } from '@openai/codex-sdk';
import { tmpdir } from 'node:os';
import { calcPrice } from '@pydantic/genai-prices';

// Pinned explicitly (rather than deferring to ~/.codex/config.toml) so runs
// are reproducible and the model is recorded in results.
export const DEFAULT_MODEL = 'gpt-5.6-terra';

// Codex reports OpenAI-convention usage, where input_tokens counts the cached
// and cache-written tokens too. The clamp keeps inconsistent figures (or a
// switch to the exclusive convention upstream) printing 0 rather than a
// negative; priceRun's own Math.max covers the same case from the other side.
function uncachedInput(usage) {
  if (!usage) return 0;
  const cached = (usage.cached_input_tokens ?? 0) + (usage.cache_write_input_tokens ?? 0);
  return Math.max(0, (usage.input_tokens ?? 0) - cached);
}

// Warn once per model id whose price entry was resolved by approximate match,
// so a silently mispriced model is visible instead of quietly wrong.
const pricingWarned = new Set();

// The anthropic backend gets an authoritative price from its SDK; codex reports
// none, so price the reported tokens against genai-prices' bundled table (no
// network call). Codex uses OpenAI's convention where input_tokens ALREADY
// includes the cached portion, which is what calcPrice expects — it subtracts
// the cached tokens itself and rejects a negative remainder. Best-effort by
// design: an unknown model must never fail a run.
function priceRun(modelId, usage) {
  if (!usage || !modelId) return null;
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  try {
    const priced = calcPrice(
      {
        input_tokens: Math.max(usage.input_tokens ?? 0, cacheRead + cacheWrite),
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        output_tokens: usage.output_tokens ?? 0,
      },
      modelId
    );
    // Unknown models come back as null rather than throwing.
    if (!priced) return null;
    const matched = priced.model?.id;
    if (matched && matched !== modelId && !pricingWarned.has(modelId)) {
      pricingWarned.add(modelId);
      console.log(`[codex] pricing "${modelId}" using the "${matched}" price entry`);
    }
    return priced.total_price ?? null;
  } catch {
    return null;
  }
}

export async function run({ prompt, model, effort, env, cwd, onMessage, mcpStdio, abortController }) {
  const codexOptions = {
    // When env is provided the SDK does not inherit process.env, so run.mjs
    // builds it from the full process.env.
    env: { ...env },
    config: {
      approval_policy: 'never',
      ...(effort ? { model_reasoning_effort: effort } : {}),
    },
  };
  // Every condition gets the same network-enabled shell so the only
  // difference is how the browser is driven.
  codexOptions.config.sandbox_workspace_write = {
    network_access: true,
    writable_roots: [tmpdir()],
  };
  codexOptions.config.shell_environment_policy = {
    inherit: 'all',
    set: {
      ...(env?.PATH ? { PATH: env.PATH } : {}),
    },
  };
  {
    codexOptions.config.mcp_servers = {
      firefox: {
        command: mcpStdio.command,
        args: mcpStdio.args,
        // Codex cancels non-read-only MCP tools under approval 'never';
        // auto-approve this server's tools instead.
        default_tools_approval_mode: 'approve',
        // Headroom for Firefox's lazy cold start inside the first tool call.
        startup_timeout_sec: 60,
        tool_timeout_sec: 180,
      },
    };
  }
  const codex = new Codex(codexOptions);
  const thread = codex.startThread({
    ...(model ? { model } : {}),
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
  });

  const started = Date.now();
  const { events } = await thread.runStreamed(prompt);
  let usage = null;
  let text = '';
  let toolCalls = 0;
  let failure = null;
  for await (const event of events) {
    // The SDK exposes no cancellation, so honour the harness ceilings by
    // leaving the stream. The codex process may linger briefly after this.
    if (abortController?.signal.aborted) {
      failure = { message: abortController.signal.reason ?? 'aborted by harness limit' };
      break;
    }
    onMessage?.(event);
    if (event.type === 'turn.completed') {
      usage = event.usage;
    } else if (event.type === 'turn.failed') {
      failure = event.error;
    } else if (event.type === 'error') {
      failure = { message: event.message };
    } else if (event.type === 'item.completed') {
      const item = event.item;
      if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
        toolCalls++;
      } else if (item.type === 'agent_message') {
        text = item.text ?? text;
      }
    }
  }
  if (failure) {
    throw new Error(`codex turn failed: ${failure.message}`);
  }
  return {
    text,
    // Codex reports one "turn" per run; approximate agent turns as tool-call
    // rounds plus the final response.
    turns: toolCalls + 1,
    // Normalized to the backend interface's uncached-remainder convention:
    // codex reports an input_tokens INCLUSIVE of both cache figures, so
    // reporting it raw put an inclusive number in the same report column as
    // anthropic's exclusive one and read as a 10000x input gap.
    input_tokens: uncachedInput(usage),
    cache_creation: usage?.cache_write_input_tokens ?? 0,
    cache_read: usage?.cached_input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cost_usd: priceRun(model ?? DEFAULT_MODEL, usage),
    duration_ms: Date.now() - started,
    api_duration_ms: null,
  };
}
