// Package a run into a portable, self-describing results bundle: a finished
// run's results.json, or a killed run's meta.json and rows.jsonl (readRun).
//
//   node bundle.mjs [run-dir] [--out <path>] [--no-transcripts] [--keep-paths]
//
// Defaults to the most recent run under results/. Produces a zip whose
// contents stand on their own: what was measured, how, what every agent did, and
// what the numbers do and do not support. Local absolute paths are rewritten to
// `~` unless --keep-paths is given.
//
// The bundle deliberately excludes the answer key (answers.mjs), the
// validators and the run's states/ directory, whose per-attempt server state
// holds every code the server minted: a recipient can see every task's prompt
// and every agent's full transcript, but not the grading key.

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGINS, originUrls } from '../../manifest.mjs';
import { pathSpellings, tempRootPath } from '../agent-env.mjs';
import { latestRun, readRun, RESULTS_ROOT as resultsRoot } from '../run-files.mjs';
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
explains the metrics and their known caveats. The answer key, the validators
and states/ (the server state each attempt was graded on) are excluded by
design.`);
  process.exit(0);
}

const runDir = resolve(positional ? positional.replace(/\/results\.json$/, '') : latestRun());
const run = readRun(runDir);

const sh = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: here, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};

// Absolute local paths leak a home directory and add noise for anyone reading
// the bundle elsewhere; rewrite them unless asked not to.
const home = homedir();
// Attempt dirs are recorded by their real path (macOS /private/var/...), which
// tmpdir() (/var/...) does not prefix, and live under the harness's own temp
// root (agent-env.mjs tempRootPath), which neither prefixes.
const temps = [...new Set([realpathSync(tmpdir()), tmpdir(), ...pathSpellings(tempRootPath())])].sort(
  (x, y) => y.length - x.length
);
const scrub = (text) =>
  KEEP_PATHS ? text : temps.reduce((t, dir) => t.split(dir).join('/tmp'), text.split(home).join('~'));

const rows = run.results ?? [];
const conditions = [...new Set(rows.map((r) => r.condition))];
const backends = [...new Set(rows.map((r) => r.backend))].filter(Boolean);
const tasksSeen = [...new Set(rows.map((r) => r.task))];

const manifest = {
  bundleFormat: 2,
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
  // The run records the commit it ran on; a run older than that record only
  // has the commit this bundle was made from, which may be a different tree.
  environment: {
    node: run.meta?.node ?? null,
    platform: `${process.platform} ${process.arch}`,
    gitCommit: run.meta?.git?.commit ?? null,
    gitDirty: run.meta?.git?.dirty ?? null,
    bundledFrom: {
      node: process.version,
      gitCommit: sh('git', ['rev-parse', 'HEAD']),
      gitDirty: (sh('git', ['status', '--porcelain']) ?? '') !== '',
    },
  },
  // What the run recorded, and null where it recorded nothing: the version
  // installed when the bundle is made is not the one an older run measured.
  versions: {
    playwrightMcp: run.meta?.surfaces?.['playwright-mcp']?.version ?? null,
  },
  surfaces: run.meta?.surfaces ?? null,
  builds: run.meta?.builds ?? null,
  totals: run.totals ?? null,
};

const staging = mkdtempSync(join(tmpdir(), 'eval-bundle-'));
const bundleName = `${basename(runDir)}-bundle`;
const root = join(staging, bundleName);
mkdirSync(root, { recursive: true });

writeFileSync(join(root, 'manifest.json'), scrub(JSON.stringify(manifest, null, 2)) + '\n');
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
// A per-origin run gave each site a port of its own, stood in for by the
// manifest's; a run that records no serving mode was single-origin.
const BASE_PLACEHOLDER = 'http://localhost';
const origins =
  run.meta?.serving === 'origins'
    ? originUrls(BASE_PLACEHOLDER, ORIGINS.map((o) => ({ ...o, url: `${BASE_PLACEHOLDER}:${o.port}` })))
    : undefined;
const tasks = [
  ...basicTasks(BASE_PLACEHOLDER, origins),
  ...(await webTasks(BASE_PLACEHOLDER, origins)),
  ...(await devtoolsTasks(BASE_PLACEHOLDER, origins)),
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

// Only transcripts/ is copied out of the run directory. states/ stays behind
// (see the header), and a row's state_file names a file the bundle leaves out.
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
Serving: ${run.meta?.serving === 'origins' ? 'one loopback origin per site' : 'single-origin, every site under a path prefix'}.
Runs served differently are separate measurement epochs.${
  run.meta?.env
    ? `\n\`meta.env\` records each condition's browser environment, and report.md\nflags any mismatch between them.`
    : ''
}

## Files

- \`manifest.json\` — what ran, in what environment, with what versions.
- \`results.json\` — one row per task run: pass/fail, a \`detail\` string naming
  every sub-check the validator evaluated, token counts, cost, timings.
- \`report.md\` — the human-readable summary${manifest.shape.repeats > 1 ? ', including per-task medians with ranges' : ''}.
- \`tasks.json\` — every task's id, wall-clock tier, and the exact prompt given.
- \`transcripts/\` — full agent message streams, one JSONL per attempt: every
  thought, tool call, tool result, and final answer. A row's \`transcript\`
  names the file of the attempt it reports.

The grading key, the validator source and the per-attempt server state
(\`states/\`, which holds every code the server minted) are excluded by design.

## Reading the numbers

- **Output tokens are the comparable efficiency metric.**
- **Turns compare only between runs whose backend counts a turn the same way.**
  A turn is a model request: the Agent SDK's own count, and for codex the
  requests its rollout records, or tool calls plus one on a row without its
  rollout, which overcounts: one script can make several MCP calls. Surfaces
  also pack different amounts of work into one call: a shell-driven surface
  measures about 1.21 browser operations per turn against 1.00 for a per-tool
  MCP surface.
- **A shell-assisted row is not a surface pass.** A row marked
  \`shell_assisted\` got answers through the agent's shell from a graded
  fixture route (an API or the /collect sink answered 2xx or 5xx, or a page a
  site hook writes session values into, fetched with a session), so report.md
  leaves it out of the pass counts it compares between conditions.
- **Cost compares within one run and never between two.** Every condition in a
  run meets the same prompt cache, so a ratio there is fair; across runs,
  cache-creation volume swings enough to move a ratio from 1.03 to 1.50 at
  identical turn counts. Treat a run's cost as its budget, not its score.
- **A pass rate counts graded attempts.** A row marked \`infra\` never reached a
  grade, because an API or transport error outlived the retries or an interrupt
  stopped it. A row whose
  \`error\` names a harness limit is a FAILURE, not infra: the agent hit the
  wall clock or the output-token ceiling on every attempt it was given.
- **Wall time carries machine noise**, more so if the run used parallelism
  (\`parallelTasks\` in \`meta\`). A task has been observed at 94.9s versus 27.9s
  across repeats with an identical turn count.
- **Pass rate is near ceiling** on most tasks by design: the suite is built so
  that efficiency, not success, is the discriminator. A failure is therefore
  interesting — read its \`detail\` string, which names the sub-check that failed.
- Rows carrying \`retries\` were re-run after a transient error or a wall-limit
  stop. The spend of every discarded attempt is on its row as \`discarded_*\`
  and totalled in report.md, outside the per-condition columns.
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
