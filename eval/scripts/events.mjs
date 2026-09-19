// One reading of a stored transcript, shared by every script that reads one
// (transcript.mjs, tool-stats.mjs, triage.mjs, judge.mjs), so a tool call is
// numbered, labelled and judged an error the same way everywhere. A judge that
// cites "step 14" and the digest a human reads must mean the same call.
//
// Normalizes both backend event shapes: Claude Agent SDK messages and Codex
// ThreadEvents.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transcriptCandidates } from '../run-files.mjs';

// The name both backends give the condition's own browser server
// (backends/anthropic.mjs and backends/codex.mjs). Any other MCP server a row
// calls is foreign to the condition.
export const SURFACE_SERVER = 'firefox';

export function readEvents(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// The graded attempt's transcript for a row of a run directory, or null.
export function rowTranscript(runDir, row) {
  if (!runDir) return null;
  return (
    transcriptCandidates(row)
      .map((name) => join(runDir, 'transcripts', name))
      .find((path) => existsSync(path)) ?? null
  );
}

export function rowEvents(runDir, row) {
  const file = rowTranscript(runDir, row);
  return file ? readEvents(file) : null;
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

// mcp__<server>__<tool>, the Agent SDK's name for an MCP tool.
function splitSdkName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
  return m ? { server: m[1], tool: m[2] } : { server: null, tool: name };
}

// Codex marks a failed MCP call with status 'failed' and, in almost every case,
// leaves `error` null and puts the reason in the result text: in
// run-2026-08-18T19-55-49-724Z, 231 of 234 failed calls had no `error`.
function codexCallFailed(item) {
  return item.status === 'failed' || !!item.error || item.result?.isError === true;
}

// Steps in transcript order: {kind: 'tool'|'tool_result'|'thinking'|'text'|'final', ...}.
// A 'tool' step carries n (its 1-based number among tool steps), server (null
// for a built-in tool or the shell), tool and label; its result, when the
// backend reported one, is the 'tool_result' step with the same n.
export function normalize(events) {
  const steps = [];
  let n = 0;
  const pending = new Map();
  for (const e of events) {
    // --- Claude Agent SDK messages ---
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type === 'thinking' && block.thinking?.trim()) {
          steps.push({ kind: 'thinking', text: block.thinking });
        } else if (block.type === 'text' && block.text?.trim()) {
          steps.push({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          const { server, tool } = splitSdkName(block.name);
          let detail;
          if (block.name === 'Bash') {
            detail = block.input?.command ?? '';
          } else if (block.name === 'ToolSearch') {
            detail = block.input?.query ?? '';
          } else {
            detail = JSON.stringify(block.input ?? {});
          }
          n += 1;
          const step = {
            kind: 'tool',
            n,
            server,
            tool,
            label: server ? `mcp:${server}/${tool}` : block.name,
            detail,
            args: block.input ?? {},
            id: block.id,
            at: Date.parse(e.timestamp ?? '') || null,
          };
          pending.set(block.id, step);
          steps.push(step);
        }
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type !== 'tool_result') continue;
        const call = pending.get(block.tool_use_id);
        const at = Date.parse(e.timestamp ?? '') || null;
        steps.push({
          kind: 'tool_result',
          n: call?.n ?? null,
          text: contentText(block.content),
          isError: block.is_error ?? false,
          // The SDK timestamps both messages, so the gap is the tool's latency
          // plus transport. Codex events carry no timestamps at all.
          ms: call?.at && at ? at - call.at : null,
        });
      }
    } else if (e.type === 'result') {
      const u = e.usage ?? {};
      steps.push({
        kind: 'final',
        text: e.result ?? '',
        info:
          `turns=${e.num_turns} in=${u.input_tokens ?? '?'} ` +
          `cacheW=${u.cache_creation_input_tokens ?? '?'} cacheR=${u.cache_read_input_tokens ?? '?'} ` +
          `out=${u.output_tokens ?? '?'} cost=$${e.total_cost_usd?.toFixed?.(4) ?? '?'}`,
      });
    }
    // --- Codex ThreadEvents ---
    else if (e.type === 'item.completed' && e.item) {
      const item = e.item;
      if (item.type === 'agent_message' && item.text?.trim()) {
        steps.push({ kind: 'text', text: item.text });
      } else if (item.type === 'reasoning' && item.text?.trim()) {
        steps.push({ kind: 'thinking', text: item.text });
      } else if (item.type === 'command_execution') {
        n += 1;
        const command = item.command?.replace(/^\/bin\/\w+ -lc /, '') ?? '';
        steps.push({ kind: 'tool', n, server: null, tool: 'shell', label: 'shell', detail: command, args: { command } });
        if (item.aggregated_output) {
          steps.push({
            kind: 'tool_result',
            n,
            text: item.aggregated_output,
            isError: item.exit_code != null && item.exit_code !== 0,
            ms: null,
          });
        }
      } else if (item.type === 'mcp_tool_call') {
        n += 1;
        steps.push({
          kind: 'tool',
          n,
          server: item.server ?? null,
          tool: item.tool,
          label: `mcp:${item.server}/${item.tool}`,
          detail: JSON.stringify(item.arguments ?? {}),
          args: item.arguments ?? {},
        });
        const resultText = contentText(item.result?.content);
        const failed = codexCallFailed(item);
        if (resultText || item.error || failed) {
          steps.push({
            kind: 'tool_result',
            n,
            text: item.error?.message ?? resultText,
            isError: failed,
            ms: null,
          });
        }
      }
    } else if (e.type === 'turn.completed' && e.usage) {
      steps.push({
        kind: 'final',
        text: '',
        info:
          `in=${e.usage.input_tokens} cacheW=${e.usage.cache_write_input_tokens ?? '?'} ` +
          `cacheR=${e.usage.cached_input_tokens} out=${e.usage.output_tokens}`,
      });
    }
  }
  return steps;
}

// Every tool call with its result folded in:
// [{ n, server, tool, label, detail, args, text, isError, ms }].
export function toolCalls(events) {
  const calls = [];
  const byN = new Map();
  for (const step of normalize(events)) {
    if (step.kind === 'tool') {
      const call = {
        n: step.n,
        server: step.server,
        tool: step.tool,
        label: step.label,
        detail: step.detail,
        args: step.args,
        text: '',
        isError: false,
        ms: null,
      };
      byN.set(step.n, call);
      calls.push(call);
    } else if (step.kind === 'tool_result' && byN.has(step.n)) {
      const call = byN.get(step.n);
      call.text = step.text ?? '';
      call.isError = !!step.isError;
      call.ms = step.ms ?? null;
    }
  }
  return calls;
}
