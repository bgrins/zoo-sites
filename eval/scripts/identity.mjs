// What a run measured, as keys that can be compared: the tool builds, the eval
// that graded them, and the agent that drove them. history.mjs files a run
// under these keys, compare.mjs refuses two runs whose keys differ, and every
// report prints the flags that make a run unfit to quote.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { originUrls } from '../../manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(here, '..', 'tasks');

// b9ff01d gave every codex process its own CODEX_HOME. Before it, codex agents
// read the operator's ~/.codex: its plugin skills and its own MCP servers
// (node_repl, a second firefox-devtools), so no earlier codex run measures a
// surface on its own. meta.isolation.toolPolicy.codex.codexHome marks a run
// made after it.
export const ISOLATION_COMMIT = 'b9ff01d';
// 24992a8 priced codex spend per request; earlier codex costs were priced on
// the run's summed tokens and overstate spend (a stored $17.46 reprices to
// $9.49).
export const PRICING_COMMIT = '24992a8';
const PRICING_DATE = Date.parse('2026-09-19T13:36:24Z');

// A row's backend: the field, else the `<backend>/` prefix a multi-backend run
// gives its conditions.
const backendOf = (r) => r.backend ?? (String(r.condition ?? '').includes('/') ? r.condition.split('/')[0] : null);

// Everything that makes a run's numbers unfit to quote or to compare, as short
// flags with the reason. `results` adds the row-level evidence. With
// `condition`, the flags are that condition's: the backend-specific ones follow
// its backend, and the row counts its rows, so one arm of a mixed-backend run
// is not flagged for another's defects.
export function runFlags(meta = {}, results = [], { condition = null } = {}) {
  const flags = [];
  const rows = condition ? results.filter((r) => r.condition === condition) : results;
  const fromRows = [...new Set(rows.map(backendOf).filter(Boolean))];
  const backends = fromRows.length ? fromRows : String(meta.backend ?? '').split(',').filter(Boolean);
  const codex = backends.includes('codex');
  // A run that records no backend at all predates the tool policy too.
  const others = backends.length ? backends.filter((b) => b !== 'codex') : ['unrecorded'];
  // Only a mixed set of backends needs to say which arms a flag covers.
  const arms = (list) => (codex && others.length ? `the ${list.join(', ')} arms: ` : '');
  if (codex && !meta.isolation?.toolPolicy?.codex?.codexHome) {
    flags.push({
      flag: 'contaminated',
      why: `${arms(['codex'])}a codex run from before CODEX_HOME isolation (${ISOLATION_COMMIT}): agents could read the operator's ~/.codex skills and call its MCP servers`,
    });
  }
  if (others.length && !meta.isolation) {
    flags.push({
      flag: 'pre-isolation',
      why: `${arms(others)}a run from before the pinned tool policy (${ISOLATION_COMMIT}): the agent's tool set and environment were not pinned`,
    });
  }
  if (codex && Date.parse(meta.date ?? '') < PRICING_DATE) {
    flags.push({ flag: 'pricing_v1', why: `${arms(['codex'])}codex cost priced before per-request pricing (${PRICING_COMMIT}), so it overstates spend` });
  }
  const foreign = rows.filter((r) => countOf(r.foreign_tools) > 0).length;
  if (foreign) flags.push({ flag: 'foreign-calls', why: `${foreign} row(s) called an MCP server other than their own` });
  const invalid = rows.filter((r) => r.invalid).length;
  if (invalid) flags.push({ flag: 'invalid-rows', why: `${invalid} row(s) are marked invalid` });
  const conditions = new Set(results.map((r) => r.condition));
  if (!meta.seed && conditions.size > 1) {
    flags.push({ flag: 'unseeded', why: 'arms drew their difficulty variants independently' });
  }
  const changed = Object.entries(browserBuilds(rows)).filter(([, builds]) => builds.length > 1);
  if (changed.length) {
    flags.push({
      flag: 'browser-changed',
      why:
        'the Firefox build changed between attempts of one condition: ' +
        changed.map(([c, builds]) => `${c} ${builds.map((b) => `${b.version ?? '?'} ${b.buildID ?? '?'} (${b.rows} rows)`).join(' then ')}`).join('; '),
    });
  }
  if (!meta.builds && !meta.surfaces) flags.push({ flag: 'no-build-identity', why: 'the run records neither meta.builds nor meta.surfaces' });
  if (!meta.git?.commit) flags.push({ flag: 'no-eval-commit', why: 'the run records no eval commit' });
  if (meta.git?.dirty) flags.push({ flag: 'eval-dirty', why: `the eval tree at ${String(meta.git.commit).slice(0, 10)} had uncommitted changes` });
  return flags;
}

// The Firefox builds each condition's rows recorded (row.browser, read at every
// attempt), in the order they first appear: { [condition]: [{ binary, version,
// buildID, rows }] }. A row that recorded none is left out.
export function browserBuilds(results = []) {
  const out = {};
  for (const r of results) {
    const b = r.browser;
    if (!b || (b.version == null && b.buildID == null)) continue;
    const list = (out[r.condition] ??= []);
    const same = list.find((x) => x.version === b.version && x.buildID === b.buildID && x.binary === b.binary);
    if (same) same.rows++;
    else list.push({ binary: b.binary ?? null, version: b.version ?? null, buildID: b.buildID ?? null, rows: 1 });
  }
  return out;
}

// The variants a row faced, from row.draws ({ scope, pick } per ctx.pick call).
// A site picks once per session and every call advances the scope, so an agent
// that opened a second session logs a second draw for the same scope; the
// first pick per scope stands for the variant the row faced, and the rest are
// counted as `extra`.
export function drawKey(draws) {
  const first = new Map();
  let extra = 0;
  for (const d of Array.isArray(draws) ? draws : []) {
    if (first.has(d.scope)) extra++;
    else first.set(d.scope, d.pick);
  }
  return { key: JSON.stringify([...first].sort(([x], [y]) => String(x).localeCompare(String(y)))), extra };
}

// A count from a field a runner may write as a number, a list or a map.
export function countOf(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object') {
    return Object.values(value).reduce((n, v) => n + (typeof v === 'number' ? v : countOf(v?.calls ?? v)), 0);
  }
  return 0;
}

// The condition a meta.builds entry measured. run.mjs records it as
// `condition`, and gives the default firefox-devtools-mcp condition a null
// label.
export const buildName = (b) =>
  b.condition ?? (b.label == null ? 'firefox-devtools-mcp' : `firefox-devtools-mcp@${b.label}`);

// A row's condition carries a `<backend>/` prefix when the run had several
// backends; meta.builds and meta.surfaces are keyed without it.
export function findBuild(meta, condition) {
  const bare = String(condition).split('/').pop();
  const builds = meta?.builds ?? [];
  return (
    builds.find((b) => b.condition != null && (b.condition === condition || b.condition === bare)) ??
    builds.find((b) => b.condition == null && (buildName(b) === bare || (b.label != null && bare === b.label))) ??
    null
  );
}

// One condition's build, as specific as the run recorded it.
export function buildKey(meta, condition) {
  const build = findBuild(meta, condition);
  if (build) {
    return {
      condition,
      version: build.version ?? null,
      sha256: build.sha256 ?? null,
      walkerSha256: build.walkerSha256 ?? null,
      toolsHash: build.tools?.hash ?? null,
    };
  }
  const plain = condition.split('/').pop();
  const surface = meta.surfaces?.[plain] ?? meta.surfaces?.[plain.split('@')[0]];
  if (surface) {
    return {
      condition,
      version: surface.version ?? null,
      sha256: surface.sha256 ?? null,
      walkerSha256: surface.walkerSha256 ?? null,
      commit: surface.commit ?? null,
      dirty: surface.dirty ?? null,
      command: surface.command ?? null,
    };
  }
  return { condition, unknown: true };
}

export function runIdentity(meta = {}, results = []) {
  const conditions = [...new Set(results.map((r) => r.condition))];
  return {
    tool: conditions.map((c) => buildKey(meta, c)),
    eval: { commit: meta.git?.commit ?? null, dirty: meta.git?.dirty ?? null, suite: meta.suite ?? null },
    agent: {
      backend: meta.backend ?? null,
      models: meta.models ?? (meta.model ? { [meta.backend]: meta.model } : null),
      effort: meta.effort ?? null,
      sdks: meta.sdks ?? null,
      extractor: meta.extractor ?? null,
    },
    seed: meta.seed ?? null,
    serving: meta.serving ?? 'single-origin',
  };
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A task's definition, hashed: what it asks, how its answer is shaped and how it
// is graded. Built against a fixed base so the loopback port a run happened to
// get never changes the hash. The helpers a validator calls and the answer key
// sit outside it; the eval commit covers those.
export function taskHash(task) {
  return sha256(
    JSON.stringify({
      id: task.id,
      ask: task.ask ?? null,
      answerSchema: task.answerSchema ?? null,
      validate: task.validate ? String(task.validate) : null,
      expect: task.expect ? String(task.expect) : null,
      truth: task.truth ?? null,
      serverModes: task.serverModes ?? null,
      tier: task.tier ?? null,
    })
  ).slice(0, 16);
}

export const PLACEHOLDER_BASE = 'http://127.0.0.1:1';

// Every task the eval defines now, with its family, capability areas and hash.
// Tasks stamp `family` and `areas` themselves once eval/tasks/areas.json exists;
// before that the family is the module a web task came from.
export async function taskInfo(base = PLACEHOLDER_BASE) {
  const origins = originUrls(base);
  const info = new Map();
  const areasPath = join(TASKS_DIR, 'areas.json');
  const areas = existsSync(areasPath) ? JSON.parse(readFileSync(areasPath, 'utf8')) : {};
  const add = (task, family) =>
    info.set(task.id, {
      family: task.family ?? family,
      areas: task.areas ?? (Array.isArray(areas[task.id]) ? areas[task.id] : []),
      hash: taskHash(task),
      task,
    });
  const { basicTasks } = await import('../tasks/basic.mjs');
  const { devtoolsTasks } = await import('../tasks/devtools.mjs');
  for (const t of basicTasks(base, origins)) add(t, 'basic');
  for (const t of await devtoolsTasks(base, origins)) add(t, 'devtools');
  for (const file of readdirSync(join(TASKS_DIR, 'web')).filter((f) => f.endsWith('.mjs')).sort()) {
    const family = file.replace(/\.mjs$/, '');
    const mod = await import(pathToFileURL(join(TASKS_DIR, 'web', file)).href);
    const factory = mod[`${family}Tasks`];
    if (typeof factory !== 'function') continue;
    for (const t of await factory(base, origins)) add(t, family);
  }
  return info;
}
