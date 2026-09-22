// The bookkeeping of `node eval/verify.mjs --extract`: each case graded the
// way run.mjs grades a paid row, the JSONL log that explains an outcome, and
// the summary. It lives outside verify.mjs so eval/scripts/rule-checks.mjs can
// run all of it against a stub extractor for free.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractFields, normalise } from './extract.mjs';

export const EXTRACT_ATTEMPTS = 3;

// One case: up to EXTRACT_ATTEMPTS extraction attempts, then the validator
// over the gated fields, or over null fields once every attempt has thrown,
// as run.mjs does. Each attempt keeps its own cost, a failed one's too when
// the extractor reported it on the error. A driver's answer comes with the
// driver's own fields, which an extraction that came back is compared with.
export async function extractCase(task, ctx, { name, text, expect, driverFields }, extract = extractFields) {
  const record = {
    task: task.id,
    case: name,
    expect: expect ? 'pass' : 'fail',
    answer: text,
    raw: null,
    fields: null,
    extraction: null,
    attempts: [],
  };
  while (!record.extraction && record.attempts.length < EXTRACT_ATTEMPTS) {
    try {
      const { fields, raw, extraction } = await extract({ ask: task.ask, answer: text, schema: task.answerSchema });
      Object.assign(record, { raw, fields, extraction });
      record.attempts.push({ ok: true, cost_usd: extraction.cost_usd ?? null });
    } catch (error) {
      record.attempts.push({ ok: false, error: String(error?.message ?? error), cost_usd: error?.cost_usd ?? null });
    }
  }
  if (!record.extraction) {
    record.extractorError = `all ${EXTRACT_ATTEMPTS} attempts threw, the last with: ${record.attempts.at(-1).error}`;
  }
  record.cost_usd = record.attempts.reduce((n, a) => n + (a.cost_usd ?? 0), 0);
  if (driverFields !== undefined) {
    record.driverFields = driverFields;
    if (record.extraction) record.differs = leafDiff(driverFields, record.fields);
  }
  try {
    const r = task.validate(text, ctx, record.fields);
    record.pass = r.pass === true;
    record.detail = r.detail ?? null;
  } catch (error) {
    record.pass = false;
    record.validatorError = String(error?.message ?? error);
  }
  return record;
}

// The leaves where an extraction of the driver's answer differs from the
// fields the driver returned, strings compared as normalise() leaves them. A
// validator's tolerance can pass such a leaf, so this is the extractor's own
// disagreement, not a verdict.
export function leafDiff(want, got, path = '') {
  if (want !== null && typeof want === 'object') {
    const keys = Array.isArray(want)
      ? [...Array(Math.max(want.length, Array.isArray(got) ? got.length : 0)).keys()]
      : Object.keys(want);
    return keys.flatMap((k) =>
      leafDiff(want[k] ?? null, got?.[k] ?? null, Array.isArray(want) ? `${path}[${k}]` : `${path}.${k}`)
    );
  }
  const same =
    typeof want === 'string' && typeof got === 'string' ? normalise(want) === normalise(got) : want === got;
  return same ? [] : [{ path: path || '.', want, got }];
}

// A case that ran cleanly and did not grade as expected: a driver answer or an
// alsoCorrect string that failed, or a wrong string that passed.
export const unexpected = (r) => !r.extractorError && !r.validatorError && r.pass !== (r.expect === 'pass');

const KINDS = ['driver', 'wrong', 'alsoCorrect'];
const kindOf = (r) => r.case.replace(/\[\d+\]$/, '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The counts the summary prints and the log's closing line records. `queued`
// is every task the run meant to drive and `reached` the ones whose free
// checks passed, so --extract ran on them.
export function extractCounts(records, { queued = [], reached = [] } = {}) {
  const byKind = (list) => Object.fromEntries(KINDS.map((k) => [k, list.filter((r) => kindOf(r) === k).length]));
  const attempts = records.flatMap((r) => r.attempts);
  const differing = records.filter((r) => r.differs?.length);
  const seen = new Set(reached);
  return {
    cases: records.length,
    byKind: byKind(records),
    tasks: new Set(records.map((r) => r.task)).size,
    calls: attempts.length,
    cost_usd: records.reduce((n, r) => n + r.cost_usd, 0),
    unpricedCalls: attempts.filter((a) => a.cost_usd == null).length,
    retriedCases: records.filter((r) => r.extraction && r.attempts.length > 1).length,
    unexpected: byKind(records.filter(unexpected)),
    extractorErrors: records.filter((r) => r.extractorError).length,
    validatorErrors: records.filter((r) => r.validatorError).length,
    differingDrivers: differing.length,
    differingLeaves: differing.reduce((n, r) => n + r.differs.length, 0),
    skippedTasks: queued.filter((id) => !seen.has(id)),
  };
}

export function extractSummary(counts, { extractor, model, log }) {
  const kinds = (o) => KINDS.map((k) => `${o[k]} ${k}`).join(', ');
  const total = KINDS.reduce((n, k) => n + counts.unexpected[k], 0);
  const skipped = counts.skippedTasks;
  return [
    `--extract: ${plural(counts.cases, 'case')} (${kinds(counts.byKind)}) over ${plural(counts.tasks, 'task')}, ` +
      `${extractor} ${model}`,
    `  ${plural(counts.calls, 'extraction call')}, $${counts.cost_usd.toFixed(3)}` +
      (counts.unpricedCalls ? `, ${counts.unpricedCalls} of them with no reported cost` : '') +
      (counts.retriedCases ? `; ${plural(counts.retriedCases, 'case')} needed a retry` : ''),
    `  outcome not as expected: ${total} (${kinds(counts.unexpected)})`,
    `  every attempt threw: ${counts.extractorErrors}; validator threw: ${counts.validatorErrors}`,
    `  driver answers whose extracted fields differ from the driver's own: ${counts.differingDrivers} ` +
      `(${counts.differingLeaves} ${counts.differingLeaves === 1 ? 'leaf' : 'leaves'})`,
    ...(skipped.length
      ? [
          `  never reached --extract, a free check failing first or the task never running: ` +
            `${skipped.length} (${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''})`,
        ]
      : []),
    `  log: ${log}`,
  ];
}

// The eval code a log was graded on: HEAD, and the files under the paths
// run.mjs counts as eval code that differ from it, as `git status` lines.
export function evalGit(repo) {
  const git = (gitArgs) => spawnSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  const status = git([
    'status', '--porcelain', '--untracked-files=all', '--',
    'eval', 'sites', 'pages', 'server.mjs', 'serve.mjs', 'manifest.mjs',
  ]);
  const dirtyFiles = status.status === 0 ? status.stdout.split('\n').filter(Boolean) : null;
  return {
    commit: head.status === 0 ? head.stdout.trim() : null,
    dirty: dirtyFiles ? dirtyFiles.length > 0 : null,
    dirtyFiles: dirtyFiles ?? [],
  };
}

// A JSONL log, one line per event, appended as the run goes so an interrupted
// run keeps every case it finished: a `run` line first, a `task` line before
// each task's cases, a `case` line per case, and a `summary` line only once
// the run completes.
export function openExtractLog(path, header) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ kind: 'run', ...header }) + '\n');
  return (kind, entry) => appendFileSync(path, JSON.stringify({ kind, ...entry }) + '\n');
}

export function readExtractLog(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    run: lines.find((l) => l.kind === 'run') ?? null,
    tasks: new Map(lines.filter((l) => l.kind === 'task').map((l) => [l.task, l])),
    cases: lines.filter((l) => l.kind === 'case'),
    summary: lines.find((l) => l.kind === 'summary') ?? null,
  };
}
