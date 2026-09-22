// The layout of a run directory under results/, shared by the runner that writes
// it and the scripts that read it back (transcript.mjs, bundle.mjs,
// surface-reach.mjs), and readRun, which reads a run's rows whether or not it
// finished.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'results');

// A run writes meta.json and appends each finished row to rows.jsonl as it
// goes, and results.json only once it ends, so a run killed before then (a
// SIGKILL, an out-of-memory stop) has the first two alone.
export const isRunDir = (dir) => existsSync(join(dir, 'results.json')) || existsSync(join(dir, 'rows.jsonl'));

// A finished run's results.json, or, for a killed run, its meta.json and
// rows.jsonl, with meta.interrupted 'killed' so a report says the run did not
// finish. `dir` may also name the results.json itself.
export function readRun(dir) {
  const root = dir.replace(/\/results\.json$/, '');
  const json = join(root, 'results.json');
  if (existsSync(json)) return JSON.parse(readFileSync(json, 'utf8'));
  const rows = join(root, 'rows.jsonl');
  if (!existsSync(rows)) throw new Error(`${root} has neither results.json nor rows.jsonl`);
  const metaPath = join(root, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  const results = readFileSync(rows, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { meta: { ...meta, interrupted: meta.interrupted ?? 'killed' }, results };
}

// Newest run-* directory holding `need` (a file or directory name).
export function latestRun(need = 'results.json') {
  const dirs = existsSync(RESULTS_ROOT)
    ? readdirSync(RESULTS_ROOT)
        .filter((d) => d.startsWith('run-') && existsSync(join(RESULTS_ROOT, d, need)))
        .sort()
    : [];
  if (!dirs.length) throw new Error(`no run under ${RESULTS_ROOT} has ${need}`);
  return join(RESULTS_ROOT, dirs.at(-1));
}

// Transcripts are <label>--<task>[--r<rep>]--a<attempt>.jsonl. The label is a
// condition, or <backend>/<condition> with the '/' written as '--'; neither a
// task id nor a condition contains '--'. `rep` is present exactly when the run
// repeats, and every attempt is numbered, so a retried task's discarded first
// attempt is never mistaken for the graded one.
export function transcriptName({ label, task, rep = null, attempt = 1 }) {
  return `${label.replaceAll('/', '--')}--${task}${rep != null ? `--r${rep}` : ''}--a${attempt}.jsonl`;
}

// Also reads the older forms, which numbered neither rep 1 nor attempt 1.
export function parseTranscriptName(file) {
  const parts = file.replace(/\.jsonl$/, '').split('--');
  let attempt = 1;
  let rep = null;
  if (/^a\d+$/.test(parts.at(-1))) attempt = Number(parts.pop().slice(1));
  if (/^r\d+$/.test(parts.at(-1))) rep = Number(parts.pop().slice(1));
  return { task: parts.at(-1), label: parts.slice(0, -1).join('/'), rep, attempt };
}

// The file that holds a result row's graded attempt: the name the row recorded,
// else the current naming, else the older one.
export function transcriptCandidates(row) {
  if (row.transcript) return [row.transcript];
  const attempt = (row.retries ?? 0) + 1;
  const current = transcriptName({ label: row.condition, task: row.task, rep: row.rep ?? null, attempt });
  const legacy =
    `${row.condition.replaceAll('/', '--')}--${row.task}` +
    `${row.rep > 1 ? `--r${row.rep}` : ''}${attempt > 1 ? `--a${attempt}` : ''}.jsonl`;
  return [current, legacy];
}
