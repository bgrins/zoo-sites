// Package a finished run into a portable, self-describing results bundle.
//
//   node bundle.mjs [run-dir] [--out <path>] [--no-transcripts] [--keep-paths]
//
// Defaults to the most recent run under results/. Produces a zip whose
// contents stand on their own: what was measured, how, what every agent did, and
// what the numbers do and do not support. Local absolute paths are rewritten to
// `~` unless --keep-paths is given.
//
// The bundle deliberately excludes the answer key (answers.mjs) and the
// validators: a recipient can see every task's prompt and every agent's full
// transcript, but not the grading key.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basicTasks } from '../tasks/basic.mjs';
import { webTasks } from '../tasks/web.mjs';
import { devtoolsTasks } from '../tasks/devtools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
// Skip the value of any flag that takes one, or `--out x.zip` donates "x.zip"
// as the run directory and the run then fails to find its results.json.
const VALUED_FLAGS = new Set(['--out']);
const positional = args.find(
  (a, i) => !a.startsWith('--') && !VALUED_FLAGS.has(args[i - 1])
);
const KEEP_PATHS = args.includes('--keep-paths');
const NO_TRANSCRIPTS = args.includes('--no-transcripts');

if (args.includes('--help')) {
  console.log(`Package a finished eval run into a portable results bundle.

Usage: node bundle.mjs [run-dir] [options]

  run-dir            a directory under results/ (default: most recent)
  --out <path>       output zip path (default: results/<run>-bundle.zip)
  --no-transcripts   omit per-agent transcripts (much smaller, far less useful)
  --keep-paths       do not rewrite local absolute paths to ~

Contents: manifest.json (what ran, and in what environment), results.json,
report.md, tasks.json (every task's prompt), transcripts/, and a README that
explains the metrics and their known caveats. The answer key and validators are
excluded by design.`);
  process.exit(0);
}

const resultsRoot = join(here, '..', 'results');
function latestRun() {
  const dirs = readdirSync(resultsRoot)
    .filter((d) => d.startsWith('run-'))
    .filter((d) => existsSync(join(resultsRoot, d, 'results.json')))
    .sort();
  if (!dirs.length) throw new Error(`no completed runs under ${resultsRoot}`);
  return join(resultsRoot, dirs.at(-1));
}

const runDir = resolve(positional ? positional.replace(/\/results\.json$/, '') : latestRun());
if (!existsSync(join(runDir, 'results.json'))) {
  throw new Error(`${runDir} has no results.json`);
}
const run = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));

const sh = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: here, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};

// Absolute local paths leak a home directory and add noise for anyone reading
// the bundle elsewhere; rewrite them unless asked not to.
const home = homedir();
const scrub = (text) =>
  KEEP_PATHS ? text : text.split(home).join('~').split(tmpdir()).join('/tmp');

const rows = run.results ?? [];
const conditions = [...new Set(rows.map((r) => r.condition))];
const backends = [...new Set(rows.map((r) => r.backend))].filter(Boolean);
const tasksSeen = [...new Set(rows.map((r) => r.task))];

const manifest = {
  bundleFormat: 1,
  createdAt: new Date().toISOString(),
  run: basename(runDir),
  meta: run.meta ?? {},
  shape: {
    conditions,
    backends,
    tasks: tasksSeen.length,
    rows: rows.length,
    repeats: run.meta?.repeat ?? 1,
    // Which axis this run can attribute a difference to.
    variedAxes: [
      conditions.length > 1 ? 'tool surface' : null,
      backends.length > 1 ? 'agent harness' : null,
    ].filter(Boolean),
  },
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    gitCommit: sh('git', ['rev-parse', 'HEAD']),
    gitDirty: (sh('git', ['status', '--porcelain']) ?? '') !== '',
  },
  versions: {
    playwrightMcp: (() => {
      const p = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).version : null;
    })(),
  },
  totals: run.totals ?? null,
};

const staging = mkdtempSync(join(tmpdir(), 'eval-bundle-'));
const bundleName = `${basename(runDir)}-bundle`;
const root = join(staging, bundleName);
mkdirSync(root, { recursive: true });

writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(
  join(root, 'results.json'),
  scrub(JSON.stringify({ meta: run.meta, results: rows, totals: run.totals }, null, 2)) + '\n'
);
if (existsSync(join(runDir, 'report.md'))) {
  writeFileSync(join(root, 'report.md'), scrub(readFileSync(join(runDir, 'report.md'), 'utf8')));
}

// Every task's prompt, so a reader can see exactly what was asked. Built from the
// task factories themselves: scraping task literals out of source with a regex
// silently emits an empty list the moment the tasks move between files, so this
// asserts non-empty rather than trusting a regex.
// Only {id, tier, prompt} is emitted: the task objects also carry answerSchema,
// which describes the grading shape this bundle deliberately excludes. The base
// is a stand-in for the loopback URL the harness assigns at run time, so a reader
// sees the shape of the prompt without a port that means nothing outside its run.
const BASE_PLACEHOLDER = 'http://localhost';
const tasks = [
  ...basicTasks(BASE_PLACEHOLDER),
  ...(await webTasks(BASE_PLACEHOLDER)),
  ...(await devtoolsTasks(BASE_PLACEHOLDER)),
]
  .filter((t) => tasksSeen.includes(t.id))
  .map((t) => ({
    id: t.id,
    tier: t.tier ?? 'standard',
    prompt: String(t.ask ?? '').replace(/\s+/g, ' ').trim(),
  }));
if (!tasks.length) {
  throw new Error(
    `no task definitions matched the ${tasksSeen.length} task ids in this run — ` +
      'the task factories or their ids have moved'
  );
}
const promptless = tasks.filter((t) => !t.prompt).map((t) => t.id);
if (promptless.length) {
  throw new Error(`these tasks produced an empty prompt: ${promptless.join(', ')}`);
}
writeFileSync(join(root, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n');

if (!NO_TRANSCRIPTS && existsSync(join(runDir, 'transcripts'))) {
  const dest = join(root, 'transcripts');
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(join(runDir, 'transcripts'))) {
    const text = readFileSync(join(runDir, 'transcripts', f), 'utf8');
    writeFileSync(join(dest, f), scrub(text));
  }
}

writeFileSync(join(root, 'README.md'), `# Eval results bundle

Run \`${manifest.run}\`, packaged ${manifest.createdAt}.

## What this measured

Agents drove ~${manifest.shape.tasks} tasks against locally served simulated
websites — no live web, all invented content. Success is graded by validators
that prefer SERVER-OBSERVED state (what the site's server actually recorded)
over what the agent claimed, so a task cannot be passed by asserting success.

Axes varied in this run: ${manifest.shape.variedAxes.join(' and ') || 'none (single configuration)'}.
Conditions: ${conditions.join(', ')}. Agent harnesses: ${backends.join(', ') || 'n/a'}.
Repeats per cell: ${manifest.shape.repeats}.

## Files

- \`manifest.json\` — what ran, in what environment, with what versions.
- \`results.json\` — one row per task run: pass/fail, a \`detail\` string naming
  every sub-check the validator evaluated, token counts, cost, timings.
- \`report.md\` — the human-readable summary${manifest.shape.repeats > 1 ? ', including per-task medians with ranges' : ''}.
- \`tasks.json\` — every task's id, wall-clock tier, and the exact prompt given.
- \`transcripts/\` — full agent message streams, one JSONL per task run: every
  thought, tool call, tool result, and final answer.

The grading key and validator source are excluded by design.

## Reading the numbers

- **Output tokens** and **cost** are the comparable efficiency metrics.
- **Turns are not comparable across conditions.** A shell-driven condition can
  chain several browser commands into one turn (measured at 1.21 browser
  operations per turn against 1.00 for a per-tool MCP surface), and one harness
  only approximates a turn count. Treat turns as diagnostic.
- **Absolute cost is not comparable across runs.** Prompt-cache creation volume
  varies enough between runs to move a cost ratio substantially with identical
  turn counts. Compare within a run.
- **Wall time carries machine noise**, more so if the run used parallelism
  (\`parallelTasks\` in \`meta\`). A task has been observed at 94.9s versus 27.9s
  across repeats with an identical turn count.
- **Pass rate is near ceiling** on most tasks by design: the suite is built so
  that efficiency, not success, is the discriminator. A failure is therefore
  interesting — read its \`detail\` string, which names the sub-check that failed.
- Rows carrying \`retries\` hit a transient infrastructure error and were re-run;
  rows whose \`error\` mentions a harness limit hit a wall-clock or output-token
  ceiling rather than failing the task.
`);

const outPath = resolve(flag('out', join(resultsRoot, `${bundleName}.zip`)));
rmSync(outPath, { force: true });
const zipped = spawnSync('zip', ['-qr', outPath, bundleName], { cwd: staging, encoding: 'utf8' });
if (zipped.status !== 0) {
  const tar = outPath.replace(/\.zip$/, '.tar.gz');
  const t = spawnSync('tar', ['-czf', tar, bundleName], { cwd: staging, encoding: 'utf8' });
  if (t.status !== 0) throw new Error(`could not archive: ${zipped.stderr ?? t.stderr}`);
  console.log(`zip unavailable; wrote ${tar}`);
} else {
  const size = (statSync(outPath).size / 1048576).toFixed(1);
  console.log(`wrote ${outPath} (${size} MB)`);
}
console.log(
  `  ${manifest.shape.rows} rows, ${manifest.shape.tasks} tasks, ` +
    `${conditions.length} condition(s), ${backends.length || 1} harness(es)` +
    (NO_TRANSCRIPTS ? ', transcripts omitted' : '')
);
rmSync(staging, { recursive: true, force: true });
