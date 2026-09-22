// What a run measured, as keys that can be compared: the tool builds, the eval
// that graded them, and the agent that drove them. history.mjs files a run
// under these keys, compare.mjs refuses two runs whose keys differ, and every
// report prints the flags that make a run unfit to quote.

import { createHash } from 'node:crypto';
import { originUrls } from '../../manifest.mjs';
import { shellAssistedOf } from './row-evidence.mjs';

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
// is not flagged for another's defects. `runDir` lets a row that predates
// row.shell_assisted be read from its state file (row-evidence.mjs).
export function runFlags(meta = {}, results = [], { condition = null, runDir = null } = {}) {
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
  const foreign = rows.filter((r) => foreignCallsOf(r) > 0).length;
  if (foreign) flags.push({ flag: 'foreign-calls', why: `${foreign} row(s) called an MCP server other than their own` });
  const invalid = rows.filter((r) => r.invalid).length;
  if (invalid) flags.push({ flag: 'invalid-rows', why: `${invalid} row(s) are marked invalid` });
  const assisted = rows.filter((r) => shellAssistedOf(r, runDir)).length;
  if (assisted) {
    flags.push({
      flag: 'shell-assisted',
      why: `${assisted} row(s) got answers through the agent's shell from a graded fixture route, so their pass counts compare only without them`,
    });
  }
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
  // A run that hashed its eval paths (run.mjs gitState) and found none changed
  // ran its commit's eval code, whatever else was dirty.
  const evalClean = meta.git?.dirtyFiles && meta.git.diffSha256 == null && !meta.git.diffError;
  if (meta.git?.dirty && !evalClean) flags.push({ flag: 'eval-dirty', why: `the eval tree at ${String(meta.git.commit).slice(0, 10)} had uncommitted changes` });
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

// The Firefox a condition ran on, which is not its tool build: `builds` the
// builds its rows recorded, else the one its preflight read (meta.env), as
// "<version> <buildID>", empty for a run that recorded neither; `userAgent`
// the version its preflight's user agent named, which names the major release
// alone; `pinned` the spec --devtools-firefox pinned it by (meta.devtoolsFirefox,
// null for the installed Firefox or a condition it does not pin). Null when
// none of them was recorded.
export function browserKey(meta = {}, condition, rows = []) {
  const bare = String(condition).split('/').pop();
  const show = (b) => `${b.version ?? '?'} ${b.buildID ?? '?'}`;
  const seen = browserBuilds(rows.filter((r) => r.condition === condition))[condition] ?? [];
  const preflight = meta.env?.[bare]?.build;
  const builds = seen.length ? seen.map(show) : preflight && (preflight.version || preflight.buildID) ? [show(preflight)] : [];
  const userAgent = meta.env?.[bare]?.firefox ?? null;
  return builds.length || userAgent ? { builds, userAgent, pinned: meta.devtoolsFirefox?.[bare]?.spec ?? null } : null;
}

// A browserKey as one line: its builds, else the user agent's version.
export const describeBrowserKey = (k) =>
  k?.builds?.length ? k.builds.join(' then ') : k?.userAgent ? `${k.userAgent} (user agent; build not recorded)` : 'not recorded';

// What verify.mjs --telemetry-diff says about two telemetry files' browsers,
// or null when nothing moved: their builds where both name one, else the user
// agent's version, which names the major release alone and is all a file from
// before `browser` holds.
export function telemetryBrowserNote(a, b) {
  const build = (t) => (t.browser?.version || t.browser?.buildID ? `${t.browser.version ?? '?'} ${t.browser.buildID ?? '?'}` : null);
  const version = (t) => t.firefox ?? t.browser?.version ?? null;
  const major = (t) => String(version(t) ?? '').split('.')[0] || null;
  const moved = 'so every figure below may move with the browser';
  if (build(a) && build(b)) return build(a) === build(b) ? null : `the Firefox builds differ, ${moved}: ${build(a)} -> ${build(b)}`;
  if (major(a) && major(b) && major(a) !== major(b)) return `the Firefox versions differ, ${moved}: ${version(a)} -> ${version(b)}`;
  const unrecorded = [build(a) ? null : 'the baseline', build(b) ? null : 'the new file'].filter(Boolean).join(' and ');
  return (
    `${unrecorded} recorded no Firefox build, so only a change of major version would show` +
    (major(a) && major(b) ? `, and both ran Firefox ${major(a)}` : ', and neither was recorded')
  );
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

// A row's calls to an MCP server other than its own. A row without
// friction.malformed_uid, written by an older recorder, counted in
// foreign_tools the calls its client rejected for naming a tool the row's own
// server lacks (browser_triple_click and browser_scroll sent to
// firefox-devtools-mcp), which flagged 11 Haiku rows FOREIGN-CALLS with
// foreign_servers {}; foreign_servers, which only another server's calls
// fill, is written wherever foreign_tools is not 0.
export function foreignCallsOf(row) {
  const servers = row?.foreign_servers;
  return servers && typeof servers === 'object' ? countOf(servers) : countOf(row?.foreign_tools);
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

// The mode codex offered its MCP tools in (backends/codex.mjs TOOL_MODE), which
// changes what a codex number measures, down to what a turn is. A codex run
// that predates the field ran the shipped code_mode_only. Null when the rows'
// backends, else the meta's, include no codex.
export const SHIPPED_CODEX_TOOL_MODE = 'code_mode_only';
export function codexToolMode(meta = {}, rows = []) {
  const fromRows = [...new Set(rows.map(backendOf).filter(Boolean))];
  const backends = fromRows.length ? fromRows : String(meta.backend ?? '').split(',').filter(Boolean);
  if (!backends.includes('codex')) return null;
  const row = rows.find((r) => (backendOf(r) ?? 'codex') === 'codex' && r.tool_mode);
  return meta.isolation?.toolPolicy?.codex?.toolMode ?? row?.tool_mode ?? SHIPPED_CODEX_TOOL_MODE;
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
      codexToolMode: codexToolMode(meta, results),
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

// Every task the eval defines now, with its family, capability areas and hash:
// the suites run.mjs's `--suite all` builds, each task stamped with `family`
// and `areas` by its factory (tasks/web.mjs tagTasks).
export async function taskInfo(base = PLACEHOLDER_BASE) {
  const origins = originUrls(base);
  const { basicTasks } = await import('../tasks/basic.mjs');
  const { webTasks } = await import('../tasks/web.mjs');
  const { devtoolsTasks } = await import('../tasks/devtools.mjs');
  const tasks = [...basicTasks(base, origins), ...(await webTasks(base, origins)), ...(await devtoolsTasks(base, origins))];
  return new Map(tasks.map((task) => [task.id, { family: task.family, areas: task.areas, hash: taskHash(task), task }]));
}
