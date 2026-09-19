// Regression history across tool builds: one line per run and condition in
// eval/results/index.jsonl, keyed by the tool build, the eval that graded it and
// the agent that drove it (identity.mjs), with the run's flags.
//
//   node eval/scripts/history.mjs add <run-dir> [--index <file>] [--force]
//   node eval/scripts/history.mjs add-all [--root <results-dir>] [--index <file>]
//   node eval/scripts/history.mjs list [--condition <c>] [--all] [--index <file>]
//   node eval/scripts/history.mjs task <id> [--condition <c>] [--all] [--index <file>]
//
// A legacy run, one with no meta.builds or a codex run from before CODEX_HOME
// isolation, is filed with `contaminated: true` and left out of list and task
// unless --all is given: its numbers mix the surface with whatever else the
// agent could reach. Cost is recorded but never compared across entries, since
// it does not compare across runs.

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { RESULTS_ROOT } from '../run-files.mjs';
import { runFlags, runIdentity, buildKey, sha256 } from './identity.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const VALUED = new Set(['--index', '--condition', '--root']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
const [command, target] = positional;
const INDEX = resolve(flag('index') ?? join(RESULTS_ROOT, 'index.jsonl'));
const ALL = args.includes('--all');

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const gm = (xs) => {
  const v = xs.filter((x) => x > 0);
  return v.length ? Math.exp(v.reduce((a, x) => a + Math.log(x), 0) / v.length) : null;
};

const CONTAMINATING = new Set(['contaminated', 'pre-isolation', 'no-build-identity']);

function entriesFor(runDir) {
  const { meta = {}, results = [] } = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));
  const identity = runIdentity(meta, results);
  const legacy = !meta.builds;
  return [...new Set(results.map((r) => r.condition))].map((condition) => {
    const rows = results.filter((r) => r.condition === condition);
    const flags = runFlags(meta, results, { condition });
    const contaminated = legacy || flags.some((f) => CONTAMINATING.has(f.flag));
    const graded = rows.filter((r) => !r.infra && !r.invalid);
    const valid = graded.filter((r) => !r.error && r.output_tokens > 0);
    const perTask = {};
    for (const task of [...new Set(rows.map((r) => r.task))]) {
      const rs = graded.filter((r) => r.task === task);
      perTask[task] = {
        output: median(rs.filter((r) => !r.error).map((r) => r.output_tokens)),
        passed: rs.filter((r) => r.success).length,
        n: rs.length,
        hash: meta.taskHashes?.[task] ?? null,
      };
    }
    const tool = buildKey(meta, condition);
    // A multi-backend run files each condition under its own backend.
    const backend = rows[0]?.backend ?? identity.agent.backend;
    const agent = {
      backend,
      model: rows[0]?.model ?? identity.agent.models?.[backend] ?? null,
      effort: identity.agent.effort,
      sdk: identity.agent.sdks?.[backend] ?? null,
      extractor: identity.agent.extractor,
    };
    return {
      run: basename(runDir),
      date: meta.date ?? null,
      condition,
      key: {
        tool: sha256(JSON.stringify(tool)).slice(0, 12),
        eval: identity.eval.commit ? `${identity.eval.commit.slice(0, 12)}${identity.eval.dirty ? '+dirty' : ''}` : null,
        agent: sha256(JSON.stringify(agent)).slice(0, 12),
      },
      tool,
      eval: identity.eval,
      agent,
      seed: identity.seed,
      serving: identity.serving,
      legacy,
      contaminated,
      flags: flags.map((f) => f.flag),
      metrics: {
        rows: rows.length,
        graded: graded.length,
        passed: graded.filter((r) => r.success).length,
        invalid: rows.filter((r) => r.invalid).length,
        output_gm: gm(valid.map((r) => r.output_tokens)),
        output_median: median(valid.map((r) => r.output_tokens)),
        turns_median: median(valid.map((r) => r.turns)),
        cost_usd: valid.some((r) => r.cost_usd != null) ? valid.reduce((n, r) => n + (r.cost_usd ?? 0), 0) : null,
      },
      tasks: perTask,
    };
  });
}

function readIndex() {
  if (!existsSync(INDEX)) return [];
  return readFileSync(INDEX, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function add(runDir) {
  const have = new Set(readIndex().map((e) => `${e.run}|${e.condition}`));
  let added = 0;
  for (const entry of entriesFor(runDir)) {
    if (have.has(`${entry.run}|${entry.condition}`) && !args.includes('--force')) {
      console.log(`  skip ${entry.run} ${entry.condition}: already in ${INDEX}`);
      continue;
    }
    appendFileSync(INDEX, JSON.stringify(entry) + '\n');
    added++;
    console.log(
      `  add ${entry.run} ${entry.condition}${entry.contaminated ? ' [contaminated: ' + entry.flags.join(', ') + ']' : ''}`
    );
  }
  return added;
}

const fmt = (x, d = 0) => (x == null ? 'n/a' : Number(x).toFixed(d));
const describeTool = (t) =>
  t.unknown ? 'unknown build' : [t.version, t.sha256 && `sha ${t.sha256.slice(0, 8)}`, t.commit && `commit ${t.commit.slice(0, 8)}${t.dirty ? '+dirty' : ''}`].filter(Boolean).join(' ');

if (command === 'add' && target) {
  const n = add(resolve(target));
  console.log(`${n} entr${n === 1 ? 'y' : 'ies'} appended to ${INDEX}`);
} else if (command === 'add-all') {
  let n = 0;
  const root = resolve(flag('root') ?? RESULTS_ROOT);
  for (const d of existsSync(root) ? readdirSync(root).sort() : []) {
    if (d.startsWith('run-') && existsSync(join(root, d, 'results.json'))) n += add(join(root, d));
  }
  console.log(`${n} entr${n === 1 ? 'y' : 'ies'} appended to ${INDEX}`);
} else if (command === 'list') {
  const entries = readIndex().filter((e) => (ALL || !e.contaminated) && (!flag('condition') || e.condition === flag('condition')));
  const hidden = readIndex().length - entries.length;
  console.log('| date | run | condition | build | eval | agent | seed | pass | output GM | flags |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const e of entries) {
    console.log(
      `| ${String(e.date ?? '').slice(0, 16)} | ${e.run} | ${e.condition} | ${describeTool(e.tool)} | ${e.key.eval ?? 'n/a'} | ` +
        `${e.agent.backend} ${e.agent.model ?? ''} ${e.agent.effort ?? ''} | ${e.seed ?? 'none'} | ` +
        `${e.metrics.passed}/${e.metrics.graded} | ${fmt(e.metrics.output_gm)} | ${e.flags.join(', ')} |`
    );
  }
  if (hidden && !ALL) console.log(`\n${hidden} contaminated or filtered entr${hidden === 1 ? 'y' : 'ies'} hidden; --all shows them.`);
} else if (command === 'task' && target) {
  const entries = readIndex().filter(
    (e) => e.tasks?.[target] && (ALL || !e.contaminated) && (!flag('condition') || e.condition === flag('condition'))
  );
  console.log(`| date | run | condition | build | eval | agent | task hash | output (median) | pass |`);
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const e of entries) {
    const t = e.tasks[target];
    console.log(
      `| ${String(e.date ?? '').slice(0, 16)} | ${e.run} | ${e.condition} | ${describeTool(e.tool)} | ${e.key.eval ?? 'n/a'} | ` +
        `${e.key.agent} | ${t.hash ?? 'n/a'} | ${fmt(t.output)} | ${t.passed}/${t.n} |`
    );
  }
  // The newest entry moved when its median falls outside every earlier entry
  // with the same agent, the same condition and the same task definition.
  const byCondition = new Map();
  for (const e of entries) {
    const k = `${e.condition}|${e.key.agent}|${e.tasks[target].hash}`;
    if (!byCondition.has(k)) byCondition.set(k, []);
    byCondition.get(k).push(e);
  }
  for (const list of byCondition.values()) {
    if (list.length < 3) continue;
    const [newest, ...earlier] = [...list].sort((x, y) => String(y.date).localeCompare(String(x.date)));
    const outs = earlier.map((e) => e.tasks[target].output).filter((x) => x != null);
    const now = newest.tasks[target].output;
    if (now != null && outs.length && (now < Math.min(...outs) || now > Math.max(...outs))) {
      console.log(
        `\nMOVED: ${newest.condition} ${newest.run} median ${now} lies outside the ${outs.length} earlier entries' range ` +
          `${Math.min(...outs)}-${Math.max(...outs)}`
      );
    }
  }
  if (!entries.length) console.log(`no ${ALL ? '' : 'clean '}entry records ${target}${ALL ? '' : '; --all includes contaminated runs'}`);
} else {
  console.error(
    'usage: node eval/scripts/history.mjs add <run-dir> | add-all | list [--condition c] | task <id> [--condition c]  [--all] [--index <file>]'
  );
  process.exit(1);
}
