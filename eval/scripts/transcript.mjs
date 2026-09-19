// Render eval run transcripts (transcripts/*.jsonl) into a readable digest:
// per task, per condition, the tool-call sequence with thinking/text snippets
// and the final answer. Both backend event shapes are read through events.mjs.
//
//   node transcript.mjs [run-dir] [--task <id>] [--full] [--md]
//
// run-dir defaults to the newest results/run-*; --md writes
// transcripts.md into the run dir (shareable next to report.md).

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { latestRun, parseTranscriptName } from '../run-files.mjs';
import { normalize, readEvents } from './events.mjs';

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
    for (const step of normalize(readEvents(join(transcriptsDir, file)))) {
      if (step.kind === 'tool') {
        out.push(`${String(step.n).padStart(3)}. ${step.label}: ${trunc(step.detail, 140)}`);
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
