// Re-grade a finished run with the validators as they stand now, from what each
// row kept: the server state it was graded against (row.state_file) and the
// extractor's raw { value, quote } pairs (row.extraction_raw). No agent runs and
// no model is called, so it is free; the quote gate is re-applied locally.
//
//   node eval/scripts/regrade.mjs <run-dir> [--out <file>] [--dry-run]
//
// Writes <run-dir>/regraded.json (never results.json): every row's old and new
// verdict, and the flips. A row whose task definition changed since the run
// (meta.taskHashes against the current hash) is flagged, because its flip may
// be the new task rather than the new validator. Rows from runs that kept no
// state cannot be regraded, and are counted rather than guessed at.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { originUrls } from '../../manifest.mjs';
import { enforceQuotes, normalise } from '../extract.mjs';
import { readStateFile } from './state-file.mjs';
import { PLACEHOLDER_BASE, taskHash } from './identity.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!dir || !existsSync(join(dir, 'results.json'))) {
  console.error('usage: node eval/scripts/regrade.mjs <run-dir> [--out <file>] [--dry-run]');
  process.exit(1);
}
const run = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
const meta = run.meta ?? {};

// Validators close over the URLs their task was built with (phish-pick names
// an origin, mirror-reroute its mirror), so a task is rebuilt against the base
// and origins its row ran on, which the state file's envelope records. A file
// or row that records neither is rebuilt against the first loopback origin the
// answer names, which is exact for a single-origin run, and otherwise against a
// placeholder.
function baseOf(row, file) {
  if (row.base) return { base: row.base, origins: row.origins ?? file.origins, how: 'row.base' };
  if (file.base) return { base: file.base, origins: file.origins, how: 'state file' };
  const seen = /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/.exec(row.answer_full ?? row.answer ?? '');
  if (seen && (meta.serving ?? 'single-origin') === 'single-origin') return { base: seen[0], origins: null, how: 'answer' };
  return { base: PLACEHOLDER_BASE, origins: null, how: 'placeholder' };
}

const taskCache = new Map();
async function tasksFor(base, origins) {
  const key = JSON.stringify([base, origins ?? null]);
  if (!taskCache.has(key)) {
    const o = origins ?? originUrls(base);
    const { basicTasks } = await import('../tasks/basic.mjs');
    const { webTasks } = await import('../tasks/web.mjs');
    const { devtoolsTasks } = await import('../tasks/devtools.mjs');
    const list = [...basicTasks(base, o), ...(await webTasks(base, o)), ...(await devtoolsTasks(base, o))];
    taskCache.set(key, new Map(list.map((t) => [t.id, t])));
  }
  return taskCache.get(key);
}

const git = (gitArgs) => {
  const r = spawnSync('git', gitArgs, { encoding: 'utf8', cwd: dirname(fileURLToPath(import.meta.url)) });
  return r.status === 0 ? r.stdout.trim() : null;
};

const out = [];
const counts = { regraded: 0, same: 0, flippedUp: 0, flippedDown: 0, noState: 0, noRaw: 0, gone: 0, unreadable: 0, errors: 0 };
const current = await tasksFor(PLACEHOLDER_BASE);
for (const row of run.results ?? []) {
  const entry = { condition: row.condition, task: row.task, rep: row.rep ?? null, was: !!row.success };
  out.push(entry);
  if (row.infra || row.error) {
    entry.status = 'never graded';
    continue;
  }
  const statePath = row.state_file ? join(dir, row.state_file) : null;
  if (!statePath || !existsSync(statePath)) {
    entry.status = 'no state file';
    counts.noState++;
    continue;
  }
  let file;
  try {
    file = readStateFile(statePath);
  } catch (error) {
    entry.status = `unreadable state file: ${error?.message ?? error}`;
    counts.unreadable++;
    continue;
  }
  const { base, origins, how } = baseOf(row, file);
  const task = (await tasksFor(base, origins)).get(row.task);
  if (!task) {
    entry.status = 'task no longer defined';
    counts.gone++;
    continue;
  }
  const then = meta.taskHashes?.[row.task];
  const now = taskHash(current.get(row.task));
  entry.taskChanged = then ? then !== now : null;
  entry.base = how;
  const answer = row.answer_full ?? row.answer ?? '';
  let fields = null;
  if (task.answerSchema) {
    if (row.extraction_raw) {
      fields = enforceQuotes(row.extraction_raw, normalise(answer));
    } else {
      // Without the raw pairs the gate cannot be re-applied, so the stored
      // fields stand and only the validator is new.
      fields = row.fields ?? null;
      entry.fieldsReused = true;
      counts.noRaw++;
    }
  }
  try {
    const verdict = task.validate
      ? task.validate(answer, { pages: { state: file.state } }, fields)
      : { pass: task.expect.test(answer.replace(/[*_~`]+/g, '')) };
    entry.now = !!verdict.pass;
    entry.detail = verdict.detail;
    if (task.answerSchema) entry.fields = fields;
  } catch (error) {
    entry.now = false;
    entry.status = `validator error: ${error?.message ?? error}`;
    counts.errors++;
    continue;
  }
  counts.regraded++;
  if (entry.now === entry.was) counts.same++;
  else if (entry.now) counts.flippedUp++;
  else counts.flippedDown++;
  entry.status = entry.now === entry.was ? 'same' : entry.now ? 'FAIL -> PASS' : 'PASS -> FAIL';
}

const flips = out.filter((e) => e.status === 'FAIL -> PASS' || e.status === 'PASS -> FAIL');
const rows = out.length;
console.log(
  `${dir}: ${counts.regraded} of ${rows} rows regraded; ${counts.same} unchanged, ` +
    `${counts.flippedUp} FAIL -> PASS, ${counts.flippedDown} PASS -> FAIL` +
    (counts.noState ? `; ${counts.noState} kept no state file` : '') +
    (counts.noRaw ? `; ${counts.noRaw} kept no raw extraction, so their stored fields were reused` : '') +
    (counts.gone ? `; ${counts.gone} name a task that no longer exists` : '') +
    (counts.unreadable ? `; ${counts.unreadable} state files could not be read` : '') +
    (counts.errors ? `; ${counts.errors} validator errors` : '')
);
for (const f of flips) {
  console.log(
    `  ${f.status}  ${f.condition}/${f.task}${f.rep ? ` (r${f.rep})` : ''}` +
      (f.taskChanged ? '  [task definition changed since the run]' : f.taskChanged == null ? '  [task hash not recorded]' : '') +
      (f.base === 'placeholder' ? '  [rebuilt against a placeholder base]' : '') +
      `: ${String(f.detail ?? '').slice(0, 160)}`
  );
}
if (!counts.regraded) {
  console.log('Nothing to write: no row kept both a state file and a grade.');
} else if (!args.includes('--dry-run')) {
  const path = resolve(flag('out') ?? join(dir, 'regraded.json'));
  writeFileSync(
    path,
    JSON.stringify(
      {
        meta: {
          regradedAt: new Date().toISOString(),
          evalCommit: git(['rev-parse', 'HEAD']),
          evalDirty: (git(['status', '--porcelain']) ?? '') !== '',
          gradedAt: meta.git ?? null,
          run: dir,
        },
        counts,
        flips,
        results: out,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`wrote ${path}`);
}
