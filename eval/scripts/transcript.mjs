// Render eval run transcripts (transcripts/*.jsonl) into a readable digest:
// per task, per condition, the tool-call sequence with thinking/text snippets
// and the final answer. Normalizes both backend event shapes (Claude Agent SDK
// messages, Codex ThreadEvents).
//
//   node transcript.mjs [run-dir] [--task <id>] [--full] [--md]
//
// run-dir defaults to the newest results/run-*; --md writes
// transcripts.md into the run dir (shareable next to report.md).

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { latestRun, parseTranscriptName } from '../run-files.mjs';

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const MD = args.includes('--md');
const taskIdx = args.indexOf('--task');
const ONLY_TASK = taskIdx !== -1 ? args[taskIdx + 1] : null;
const dirArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--task');

const runDir = dirArg ?? latestRun('transcripts');
const transcriptsDir = join(runDir, 'transcripts');
if (!existsSync(transcriptsDir)) {
  throw new Error(`no transcripts/ in ${runDir}`);
}

const resultsMeta = existsSync(join(runDir, 'results.json'))
  ? JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'))
  : null;

const trunc = (s, n) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return FULL || one.length <= n ? one : one.slice(0, n) + '…';
};

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

// Normalize one jsonl transcript into steps:
// {kind: 'tool'|'tool_result'|'thinking'|'text'|'final', ...}
function normalize(lines) {
  const steps = [];
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // --- Claude Agent SDK messages ---
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type === 'thinking' && block.thinking?.trim()) {
          steps.push({ kind: 'thinking', text: block.thinking });
        } else if (block.type === 'text' && block.text?.trim()) {
          steps.push({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          const name = block.name.replace(/^mcp__[^_]+__/, 'mcp:');
          let detail;
          if (block.name === 'Bash') {
            detail = block.input?.command ?? '';
          } else if (block.name === 'ToolSearch') {
            detail = block.input?.query ?? '';
          } else {
            detail = JSON.stringify(block.input ?? {});
          }
          steps.push({ kind: 'tool', name, detail, id: block.id });
        }
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type === 'tool_result') {
          steps.push({
            kind: 'tool_result',
            text: contentText(block.content),
            isError: block.is_error ?? false,
          });
        }
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
        steps.push({
          kind: 'tool',
          name: 'shell',
          detail: item.command?.replace(/^\/bin\/\w+ -lc /, '') ?? '',
        });
        if (item.aggregated_output) {
          steps.push({
            kind: 'tool_result',
            text: item.aggregated_output,
            isError: item.exit_code != null && item.exit_code !== 0,
          });
        }
      } else if (item.type === 'mcp_tool_call') {
        steps.push({
          kind: 'tool',
          name: `mcp:${item.tool}`,
          detail: JSON.stringify(item.arguments ?? {}),
        });
        const resultText = contentText(item.result?.content);
        if (resultText || item.error) {
          steps.push({
            kind: 'tool_result',
            text: item.error?.message ?? resultText,
            isError: !!item.error,
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

// The row a transcript belongs to. A row names its graded attempt's transcript
// (or, in older runs, is matched by label, task and rep); any other attempt of
// the same task was discarded by a retry or a harness stop.
function metaFor(file, label, task, rep, attempt) {
  const rows = resultsMeta?.results ?? [];
  const same = (x) =>
    x.task === task &&
    (x.condition === label || x.condition === label.split('/').pop()) &&
    (x.rep ?? 1) === (rep ?? 1);
  const r =
    rows.find((x) => x.transcript === file) ??
    rows.find((x) => !x.transcript && same(x) && (x.retries ?? 0) + 1 === attempt);
  if (!r) return rows.some(same) ? ' — discarded attempt' : '';
  const bits = [
    r.success ? 'PASS' : 'FAIL',
    r.turns != null ? `${r.turns} turns` : null,
    r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : null,
    r.wall_s != null ? `${r.wall_s}s` : null,
    r.detail || r.error || null,
  ].filter(Boolean);
  return ` — ${bits.join(', ')}`;
}

const files = readdirSync(transcriptsDir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort();

const byTask = new Map();
for (const file of files) {
  const { task, label, rep, attempt } = parseTranscriptName(file);
  if (ONLY_TASK && task !== ONLY_TASK) continue;
  if (!byTask.has(task)) byTask.set(task, []);
  byTask.get(task).push({ label, rep, attempt, file });
}

// Preserve suite ordering from results.json where available.
const taskOrder = resultsMeta
  ? [...new Set(resultsMeta.results.map((r) => r.task))]
  : [...byTask.keys()];
const orderedTasks = [
  ...taskOrder.filter((t) => byTask.has(t)),
  ...[...byTask.keys()].filter((t) => !taskOrder.includes(t)),
];

const out = [];
out.push(`# Transcripts — ${runDir.split('/').pop()}`);
if (resultsMeta?.meta) {
  const m = resultsMeta.meta;
  const models = m.models
    ? Object.entries(m.models)
        .map(([b, mod]) => `${b}:${mod}`)
        .join(' ')
    : m.model;
  out.push(
    `backend=${m.backend} model=${models} effort=${m.effort ?? '(default)'} ` +
      `suite=${m.suite} conditions=${m.conditions}` +
      (m.mcpCommand ? ` mcpCommand="${m.mcpCommand}"` : '') +
      (m.interrupted ? ` INTERRUPTED(${m.interrupted})` : '')
  );
}

for (const task of orderedTasks) {
  out.push('', `## ${task}`);
  for (const { label, rep, attempt, file } of byTask.get(task)) {
    const heading =
      `${label}${rep ? ` (r${rep})` : ''}${attempt > 1 ? ` [attempt ${attempt}]` : ''}` +
      metaFor(file, label, task, rep, attempt);
    out.push('', `### ${heading}`, '');
    const lines = readFileSync(join(transcriptsDir, file), 'utf8').trim().split('\n');
    let n = 0;
    for (const step of normalize(lines)) {
      if (step.kind === 'tool') {
        n += 1;
        out.push(`${String(n).padStart(3)}. ${step.name}: ${trunc(step.detail, 140)}`);
      } else if (step.kind === 'tool_result') {
        const mark = step.isError ? 'x' : '->';
        out.push(`       ${mark} ${trunc(step.text, 120)}`);
      } else if (step.kind === 'thinking') {
        out.push(`     \ ${trunc(step.text, 160)}`);
      } else if (step.kind === 'text') {
        out.push(`     ◆ ${trunc(step.text, 300)}`);
      } else if (step.kind === 'final') {
        out.push(`     ■ ${step.info}${step.text ? ` — ${trunc(step.text, 200)}` : ''}`);
      }
    }
  }
}

const text = out.join('\n') + '\n';
if (MD) {
  const mdPath = join(runDir, 'transcripts.md');
  writeFileSync(mdPath, text);
  console.log(`wrote ${mdPath}`);
} else {
  console.log(text);
}
