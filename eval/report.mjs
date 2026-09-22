// Pure reporting over a run's result rows: per-condition totals, per-task
// medians across repeats, and the shareable report.md. run.mjs writes both at
// the end of a run (and on an interrupt), and --report-from re-renders them
// from a finished run's results.json. Every field a newer runner writes is
// optional here, so a results.json from any earlier run still renders.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCallRecorder, serverExitText, withCodeMode } from './mcp-tap.mjs';
import { rowEvents, SURFACE_SERVER } from './scripts/events.mjs';
import { foreignBrowser, tapWindows } from './scripts/foreign-browser.mjs';
import { browserBuilds, buildName, drawKey, foreignCallsOf, runFlags } from './scripts/identity.mjs';
import { rowState, shellAssistedOf, withRolloutFacts } from './scripts/row-evidence.mjs';
import { conditionGroups, conditionLedgerLines, lateServerRows, ledgerFailures } from './scripts/token-ledger.mjs';
import { runToolStats, sumToolStats } from './scripts/tool-stats.mjs';
import { classOf, triageLines, triageRun } from './scripts/triage.mjs';
import { createReachRecorder, gradedValues, truthValues } from './surface-reach.mjs';

const SUMMED = [
  'turns', 'input_tokens', 'cache_creation', 'cache_read', 'output_tokens', 'cost_usd',
  'duration_s', 'api_s', 'wall_s',
];

export function totalsByCondition(results) {
  const totals = {};
  const known = {};
  for (const r of results) {
    const t = (totals[r.condition] ??= {
      tasks: 0, passed: 0, infra: 0, invalid: 0, turns: 0, input_tokens: 0, cache_creation: 0,
      cache_read: 0, output_tokens: 0, cost_usd: 0, duration_s: 0, api_s: 0, wall_s: 0,
      discarded_attempts: 0, discarded_output_tokens: 0, discarded_cost_usd: 0,
      discarded_unknown: 0, invalid_output_tokens: 0, invalid_cost_usd: 0,
    });
    const k = (known[r.condition] ??= new Set());
    // Every attempt that was discarded (a retry, a harness stop, the attempts
    // of a row that errored out) was really spent, so each row carries that
    // spend as discarded_* and it is totalled separately here rather than lost.
    // Rows written before discarded_attempts existed only carried the spend.
    t.discarded_attempts +=
      r.discarded_attempts ?? (r.discarded_cost_usd != null ? (r.retries ?? 1) : 0);
    t.discarded_output_tokens += r.discarded_output_tokens ?? 0;
    t.discarded_cost_usd += r.discarded_cost_usd ?? 0;
    t.discarded_unknown += r.discarded_unknown ?? 0;
    // A row that never called its own surface (row.invalid) measured nothing
    // about it, so, like infra, it stays out of the pass rate and the sums. Its
    // spend was real, so it is totalled on its own.
    if (r.invalid) {
      t.invalid++;
      t.invalid_output_tokens += r.output_tokens ?? 0;
      t.invalid_cost_usd += r.cost_usd ?? 0;
      continue;
    }
    // `tasks` counts every row charged to the agent: graded attempts, and error
    // rows that are not infra (harness stops, backend errors), which fail. A
    // pass rate never charges the agent for an infra row. The token and cost
    // sums take each row's graded attempt only; an error row has none, so it
    // adds nothing there.
    if (r.infra) t.infra++;
    else t.tasks++;
    t.passed += r.success ? 1 : 0;
    for (const key of SUMMED) {
      t[key] += r[key] ?? 0;
      if (r[key] != null) k.add(key);
    }
  }
  for (const [condition, t] of Object.entries(totals)) {
    t.cost_usd = Math.round(t.cost_usd * 10000) / 10000;
    t.discarded_cost_usd = Math.round(t.discarded_cost_usd * 10000) / 10000;
    t.invalid_cost_usd = Math.round(t.invalid_cost_usd * 10000) / 10000;
    for (const key of ['duration_s', 'api_s', 'wall_s']) {
      t[key] = Math.round(t[key] * 10) / 10;
    }
    // A figure no row reported is unknown, not zero: codex reports no API time,
    // and a sum of nothing printed as 0 reads as a measurement.
    for (const key of SUMMED) {
      if (!known[condition].has(key)) t[key] = null;
    }
  }
  return totals;
}

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// "12 (11-33)" — median plus the observed range, so an unstable task is visible
// at a glance instead of hiding behind its median. spread = max/min on output
// tokens, the metric least polluted by machine contention.
function spanOf(values, digits = 0) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return '';
  const fmt = (x) => (digits ? x.toFixed(digits) : String(Math.round(x)));
  const med = median(v);
  if (v.length === 1 || v[0] === v.at(-1)) return fmt(med);
  return `${fmt(med)} (${fmt(v[0])}-${fmt(v.at(-1))})`;
}

function medianLines(results, runDir = null) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.condition}|${r.task}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const lines = [
    '',
    '## Per-task medians across repeats',
    '',
    'Each cell is `median (min-max)`. `spread` is max/min output tokens: >2 means',
    'a single sample of that task is not trustworthy. `scripted writes` sums the script',
    'calls that wrote the page themselves rather than through the surface\'s action tools.',
    '',
    '| condition | task | pass | turns | output | cost (USD) | wall (s) | api (s) | spread | scripted writes |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [key, rs] of groups) {
    const [condition, task] = key.split('|');
    // Invalid rows measured nothing about the surface, so, as in the totals,
    // they stay out of every cell and are only counted.
    const valid = rs.filter((r) => !r.invalid);
    const graded = valid.filter((r) => !r.infra);
    const passed = graded.filter((r) => r.success).length;
    const outs = valid.map((r) => r.output_tokens).filter((x) => x != null);
    const lo = Math.min(...outs);
    const spread = outs.length > 1 && lo > 0 ? (Math.max(...outs) / lo).toFixed(1) + 'x' : '';
    const infra = valid.length - graded.length;
    const invalid = rs.length - valid.length;
    const writes = valid.map((r) => frictionOf(r, runDir).scripted_writes);
    lines.push(
      `| ${condition} | ${task} | ${passed}/${graded.length}` +
        `${infra ? ` (+${infra} infra)` : ''}${invalid ? ` (+${invalid} invalid)` : ''} | ` +
        `${spanOf(valid.map((r) => r.turns))} | ${spanOf(outs)} | ` +
        `${spanOf(valid.map((r) => r.cost_usd), 4)} | ${spanOf(valid.map((r) => r.wall_s), 1)} | ` +
        `${spanOf(valid.map((r) => r.api_s), 1)} | ${spread} | ` +
        `${writes.some((w) => w != null) ? writes.reduce((n, w) => n + (w ?? 0), 0) : 'n/a'} |`
    );
  }
  const unstable = [...groups.entries()].filter(([, rs]) => {
    const o = rs.filter((r) => !r.invalid).map((r) => r.output_tokens).filter((x) => x != null);
    return o.length > 1 && Math.min(...o) > 0 && Math.max(...o) / Math.min(...o) > 2;
  });
  if (unstable.length) {
    lines.push(
      '',
      `Unstable (>2x output-token spread), treat single samples as unreliable: ` +
        unstable.map(([k]) => k.replace('|', '/')).join(', ')
    );
  }
  return lines;
}

const SERVING_NOTE = {
  origins: "one origin per site, each on its own loopback port with its directory at '/'",
  'single-origin': 'single-origin, every site under its pages/ directory on one port',
  vhosts: "host-routed, one listener with each site at http://<key>.localhost:<port>/",
};

const na = (x) => (x == null ? 'n/a' : x);
const short = (h) => (h ? String(h).slice(0, 12) : '?');

// Counters newer than the recorder that wrote a row, each under the key whose
// absence marks a row that predates it. With the run directory at hand, a row
// that predates them is read back from its transcript, state file and tap log
// instead, so a re-rendered report of an older run shows them too. `sleeps`
// is re-read with script_sleeps, which it has counted since 2026-09-20, and
// `stale_uid` with malformed_uid: a row without malformed_uid counted a
// malformed uid's reply as stale. api_retries is only on an Agent SDK row.
// malformed_uid is re-read with scripted_writes, since a row without it
// counted no playwright-mcp malformed ref. A row without act_then_read
// predates the counters firefox-devtools-mcp 0.10 needed: get_page_text reads,
// browser closes, and a browser closed and launched again
// (close_firefox_session) as a restart.
const NEW_FRICTION = {
  tool_search: ['tool_search', 'tool_search_turns', 'tool_search_output_tokens', 'persisted', 'persisted_other', 'unknown_tools'],
  script_sleeps: ['script_sleeps', 'sleeps'],
  malformed_uid: ['malformed_uid', 'stale_uid', 'output_file_reads', 'output_file_chars', 'api_retries', 'api_retry_s'],
  scripted_writes: ['scripted_writes', 'malformed_uid', 'stale_uid'],
  act_then_read: ['act_then_read', 'act_then_snap', 'page_text_reads', 'page_text_chars', 'restarts', 'closes', 'closed_at_end'],
};
const DERIVED = new WeakMap();
function derivedOf(row, runDir) {
  if (!runDir) return {};
  if (DERIVED.has(row)) return DERIVED.get(row);
  const out = {};
  const wantsState = row.foreign_browser === undefined || (row.ledger?.non_browser && !row.ledger.non_browser_by_status);
  const stale = Object.keys(NEW_FRICTION).filter((marker) => row.friction?.[marker] == null);
  // A row whose snapshot counts predate the snapshot files read back.
  const staleSnapshot = row.snapshot && row.snapshot.file_reads == null;
  let shell = [];
  if (runDir && (stale.length || wantsState || staleSnapshot)) {
    const events = rowEvents(runDir, row);
    if (events) {
      const recorder = createCallRecorder(SURFACE_SERVER);
      for (const e of events) recorder.observe(e);
      const summary = recorder.summary();
      if (stale.length) {
        out.friction = Object.fromEntries(
          stale.flatMap((marker) => NEW_FRICTION[marker]).filter((k) => k in summary.friction).map((k) => [k, summary.friction[k]])
        );
      }
      if (staleSnapshot) {
        const { file_reads, file_chars } = summary.snapshot;
        out.snapshot = { ...row.snapshot, chars: (row.snapshot.chars ?? 0) + file_chars, file_reads, file_chars };
      }
      shell = summary.shell_windows;
    }
  }
  const state = runDir && wantsState ? rowState(row, runDir) : null;
  if (state) {
    if (row.foreign_browser === undefined && row.transcript) {
      const tap = join(runDir, 'tool-calls', row.transcript);
      out.foreign_browser = foreignBrowser(state.ledger, { windows: existsSync(tap) ? tapWindows(tap) : null, shell });
    }
    if (row.ledger?.non_browser && !row.ledger.non_browser_by_status && Array.isArray(state.ledger)) {
      const by = {};
      for (const e of state.ledger.filter((x) => (x.client ? x.client !== 'browser' : !x.dest))) {
        const s = String(e.status ?? 'none');
        by[s] = (by[s] ?? 0) + 1;
      }
      out.non_browser_by_status = by;
    }
  }
  DERIVED.set(row, out);
  return out;
}

// Actions that replied success and did not land, as the validator counted them
// from what the server saw: a key=value pair of its detail whose key ends in
// NoOps, noops or misses (pointer-drag's dragNoOps=2 against a
// drag_by_uid_to_uid that replied "drag 1_80→1_40", scene-calibrate's misses=1
// against "filled 3 fields"). A miss also counts an apply the agent typed wrong
// values into, so the count bounds the no-ops from above. The tap cannot see
// these: the reply was not an error. Null when the validator counts none.
export function noopsOf(row) {
  const text = String(row.detail ?? '').replace(/\bfields=[\[{][\s\S]*$/, '');
  const found = [...text.matchAll(/\b(\w*(?:NoOps|noops|misses))=(\d+)\b/g)];
  if (!found.length) return null;
  return { count: found.reduce((n, [, , v]) => n + Number(v), 0), keys: found.map(([, k, v]) => `${k}=${v}`) };
}

// A row's friction as every reader should count it: the row's own counters,
// the counters newer than its recorder read back from its transcript, a codex
// code-mode row's exec cells folded in (mcp-tap.mjs withCodeMode), and the
// validator's no-op count.
export function frictionOf(row, runDir = null) {
  const own = { ...(row.friction ?? {}), ...(derivedOf(row, runDir).friction ?? {}) };
  const noops = noopsOf(row);
  return { ...withCodeMode(own, row.code_mode), ...(noops ? { noops: noops.count } : {}) };
}
// A row's snapshot counts, with the snapshot files the agent read back through
// the Read tool or its shell counted in `chars` (mcp-tap.mjs): a row that
// predates that count is re-read from its transcript. playwright-mcp's agents
// read 558,757 characters of saved snapshots back in 60 reads in the Haiku
// sweep run-2026-09-20T18-32-34-183Z, which its snapshot count left out.
export function snapshotOf(row, runDir = null) {
  if (!row.snapshot) return row.snapshot ?? null;
  return derivedOf(row, runDir).snapshot ?? row.snapshot;
}
const foreignOf = (row, runDir) => (row.foreign_browser !== undefined ? row.foreign_browser : derivedOf(row, runDir).foreign_browser ?? null);
const shellStatusOf = (row, runDir) => row.ledger?.non_browser_by_status ?? derivedOf(row, runDir).non_browser_by_status ?? null;
const statusList = (by) => Object.entries(by ?? {}).map(([s, n]) => `${s}: ${n}`).join(', ');
const round = (x) => (x == null ? null : Math.round(x));

// A row's surface record as the recorder that wrote it saw the replies. With
// the run directory, each value it recorded as truncated is re-read from the
// transcript with today's reachOf, which decodes a script result's JSON
// escapes: search-decoy's address read as cut on a row whose script reply had
// carried it whole, with its newlines escaped.
const SURFACE = new WeakMap();
function surfaceOf(row, runDir) {
  return reread(row, runDir).surface;
}
// The row's surface record re-read, and the reach recorder that read it.
function reread(row, runDir) {
  if (!runDir || !row.surface?.truncated?.length) return { surface: row.surface ?? null, rec: null };
  if (SURFACE.has(row)) return SURFACE.get(row);
  let out = { surface: row.surface, rec: null };
  const events = rowEvents(runDir, row);
  if (events) {
    // A row records each value cut to 80 characters, so the graded value one
    // opens is tested whole.
    const graded = gradedValues(row.fields ?? {});
    const whole = row.surface.truncated.map((v) => graded.find((g) => g.slice(0, 80) === v) ?? v);
    const rec = createReachRecorder();
    for (const e of events) rec.observe(e);
    const states = rec.reach(whole);
    const { truncated: recorded, ...rest } = row.surface;
    const truncated = recorded.filter((v, i) => states[whole[i]] === 'truncated');
    out = { surface: { ...rest, ...(truncated.length ? { truncated } : {}) }, rec };
  }
  SURFACE.set(row, out);
  return out;
}

const taskOf = (tasks, id) => {
  const t = tasks?.get?.(id) ?? tasks?.[id] ?? null;
  return t?.task ?? t;
};

// Whether a passing row still passes with `value` cut back to `head` in its
// fields and its answer, re-graded against the attempt's state as regrade.mjs
// grades. Null when that cannot be told: the stored row does not pass again.
function passesCut(row, task, state, value, head) {
  const answer = row.answer_full ?? row.answer ?? '';
  const grade = (text, fields) => {
    try {
      return task.validate(text, { pages: { state } }, fields);
    } catch {
      return null;
    }
  };
  if (!grade(answer, row.fields)?.pass) return null;
  const cut = (node) =>
    node === value
      ? head
      : Array.isArray(node)
        ? node.map(cut)
        : node && typeof node === 'object'
          ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, cut(v)]))
          : node;
  const verdict = grade(answer.split(value).join(head), cut(row.fields));
  return verdict ? Boolean(verdict.pass) : null;
}

// Graded values a passing row claimed although the surface cut them before
// they reached the agent, and that the pass rested on: the agent completed
// each one without seeing it. With the task and the attempt's state, the
// validator is re-run with each such value cut back to the opening the surface
// showed, and a value whose cut copy still passes passed nothing: embargo-wait
// grades only the headline's company names, which the cut opening holds, so
// the tail its agent invented was never graded. A task that names its truth
// (truth.values) grades those values, so only a claim among them counts.
// Without a validator to re-run, every cut claim counts.
function guessedValues(row, runDir, tasks = null) {
  const { surface, rec } = reread(row, runDir);
  const truncated = surface?.truncated ?? [];
  if (!row.success || !truncated.length) return [];
  const graded = gradedValues(row.fields ?? {});
  const claimed = truncated.filter((v) => graded.some((g) => g.slice(0, 80) === v));
  const task = taskOf(tasks, row.task);
  const state = claimed.length && typeof task?.validate === 'function' ? rowState(row, runDir) : null;
  if (!state) return claimed;
  const named = typeof task.truth?.values === 'function' ? new Set(truthValues(state, task)) : null;
  return claimed.filter((v) => {
    const whole = graded.find((g) => g.slice(0, 80) === v);
    if (named && !named.has(whole)) return false;
    const head = rec?.shownHead(whole);
    return !head || passesCut(row, task, state, whole, head) !== true;
  });
}

// Whether the Claude CLI deferred MCP tools behind ToolSearch in this run: the
// harness pins ENABLE_TOOL_SEARCH, and a run that records no pin left it to
// the CLI's default, which defers them.
function toolSearchSetting(meta) {
  const pinned = meta.isolation?.toolPolicy?.anthropic?.cliEnv?.ENABLE_TOOL_SEARCH;
  return pinned == null ? 'not pinned (the CLI default defers every MCP tool)' : `ENABLE_TOOL_SEARCH=${pinned}`;
}

// pick(A) / pick(B) over paired rows, [[rowA, rowB]], as ab.mjs reads a ratio:
// the geometric mean over tasks of each task's mean log ratio across its
// repeats, since a few long tasks dominate a ratio of sums (docs/process.md).
// Tasks and each task's values add in sorted order, so the rows' order does
// not reach the last digit.
function gmRatio(pairs, pick) {
  const logs = new Map();
  for (const [x, y] of pairs) {
    const [u, v] = [pick(x), pick(y)];
    if (!(u > 0 && v > 0)) continue;
    if (!logs.has(x.task)) logs.set(x.task, []);
    logs.get(x.task).push(Math.log(u) - Math.log(v));
  }
  if (!logs.size) return 'n/a';
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const perTask = [...logs.keys()].sort().map((t) => avg(logs.get(t).sort((p, q) => p - q)));
  return Math.exp(avg(perTask)).toFixed(3);
}

// ToolSearch's share of each condition's turns and output, and the surface
// ratios with and without it, over the tasks both conditions of a backend
// graded. A ToolSearch-only turn is an API request whose every tool call was
// ToolSearch: tool discovery, not surface work.
function toolSearchLines(results, meta, runDir) {
  const rows = results.filter((r) => !r.invalid && !r.error && r.turns != null);
  const backendOf = (r) => r.backend ?? (r.condition.includes('/') ? r.condition.split('/')[0] : meta.backend);
  const anthropic = rows.filter((r) => backendOf(r) === 'anthropic');
  if (!anthropic.length) return [];
  // In the order --conditions named them, so the ratio's first condition, its
  // numerator, does not depend on which row finished first.
  const named = String(meta.conditions ?? '').split(',').map((c) => c.trim());
  const rank = (c) => {
    const i = named.findIndex((n) => n === c || n === c.split('/').pop());
    return i === -1 ? named.length : i;
  };
  const conditions = [...new Set(anthropic.map((r) => r.condition))].sort((x, y) => rank(x) - rank(y));
  const sums = (rs) => {
    const f = rs.map((r) => frictionOf(r, runDir));
    const known = f.some((x) => x.tool_search != null);
    const add = (pick) => rs.reduce((n, r, i) => n + (pick(r, f[i]) ?? 0), 0);
    return {
      rows: rs.length,
      known,
      calls: known ? add((_, x) => x.tool_search) : null,
      searchTurns: known ? add((_, x) => x.tool_search_turns) : null,
      searchOut: known ? add((_, x) => x.tool_search_output_tokens) : null,
      turns: add((r) => r.turns),
      output: add((r) => r.output_tokens),
    };
  };
  const lines = [
    '',
    '## Tool discovery (ToolSearch)',
    '',
    `MCP tool loading: ${toolSearchSetting(meta)}. A ToolSearch-only turn is an API request whose every tool call was ToolSearch; ` +
      '"without" leaves those turns and their output tokens out.',
    '',
    '| condition | rows | ToolSearch calls | ToolSearch-only turns | their output | turns | turns without | output | output without |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of conditions) {
    const s = sums(anthropic.filter((r) => r.condition === c));
    lines.push(
      `| ${c} | ${s.rows} | ${na(s.calls)} | ${na(s.searchTurns)} | ${na(s.searchOut)} | ${s.turns} | ` +
        `${s.known ? s.turns - s.searchTurns : 'n/a'} | ${s.output} | ${s.known ? s.output - s.searchOut : 'n/a'} |`
    );
  }
  if (conditions.length > 1) {
    const [a, ...others] = conditions;
    const key = (r) => `${r.task}#${r.rep ?? 1}`;
    // A shell-assisted row measured the shell as well as the surface, so its
    // pair stays out of the ratio.
    const assisted = new Set(anthropic.filter((r) => shellAssistedOf(r, runDir)));
    const surface = anthropic.filter((r) => !assisted.has(r));
    for (const b of others) {
      const shelled = [...assisted].some((r) => r.condition === a || r.condition === b) ? ', shell-assisted rows left out' : '';
      const bRows = new Map(surface.filter((r) => r.condition === b).map((r) => [key(r), r]));
      const pairs = surface.filter((r) => r.condition === a && bRows.has(key(r))).map((r) => [r, bRows.get(key(r))]);
      if (!pairs.length) continue;
      const f = (r) => frictionOf(r, runDir);
      const known = [0, 1].every((i) => pairs.some((p) => f(p[i]).tool_search != null));
      const pick = {
        turns: (r) => r.turns,
        turnsWithout: (r) => r.turns - (f(r).tool_search_turns ?? 0),
        output: (r) => r.output_tokens,
        outputWithout: (r) => r.output_tokens - (f(r).tool_search_output_tokens ?? 0),
      };
      const tasks = new Set(pairs.map(([r]) => r.task)).size;
      lines.push(
        '',
        `Surface ratio ${a} / ${b}, the geometric mean over ${tasks} paired tasks (${pairs.length} paired rows${shelled}): turns ${gmRatio(pairs, pick.turns)}` +
          (known ? ` (${gmRatio(pairs, pick.turnsWithout)} without ToolSearch)` : '') +
          `, output ${gmRatio(pairs, pick.output)}` +
          (known ? ` (${gmRatio(pairs, pick.outputWithout)} without ToolSearch)` : '') +
          '.'
      );
    }
  }
  return lines;
}

// Which build each condition ran: meta.builds for firefox-devtools-mcp builds
// run as named conditions, meta.surfaces for every condition. A run with
// neither predates build identity.
function buildLines(meta) {
  const builds = meta.builds ?? [];
  const surfaces = Object.entries(meta.surfaces ?? {});
  if (!builds.length && !surfaces.length) return [];
  const lines = ['', '## Tool builds', ''];
  if (builds.length) {
    lines.push(
      '| condition | version | dist sha256 | walker sha256 | tools | schema chars | instructions chars | tools/list hash | root |',
      '|---|---|---|---|---|---|---|---|---|'
    );
    for (const b of builds) {
      const twin = builds.find((o) => o !== b && o.sha256 && o.sha256 === b.sha256 && o.walkerSha256 === b.walkerSha256);
      // Twins that drove two Firefox builds are no A/A pair.
      const fx = (x) => (x.firefox?.version || x.firefox?.buildID ? `${x.firefox.version ?? '?'} ${x.firefox.buildID ?? '?'}` : null);
      const apart = twin && fx(b) && fx(twin) && fx(b) !== fx(twin) ? `, on Firefox ${fx(b)} against its ${fx(twin)}` : '';
      // A preflight that predates the instructions record left no key.
      const told = !b.tools || !('instructions' in b.tools) ? 'n/a' : (b.tools.instructions?.chars ?? 0);
      lines.push(
        `| ${buildName(b)}${twin ? ` (same build as ${buildName(twin)}${apart})` : ''} | ${na(b.version)} | ` +
          `${short(b.sha256)} | ${short(b.walkerSha256)} | ${na(b.tools?.count)} | ${na(b.tools?.schemaChars)} | ` +
          `${told} | ${short(b.tools?.hash)} | ${na(b.root)} |`
      );
    }
    const [first, ...rest] = builds.filter((b) => b.tools?.names);
    for (const b of rest) {
      const base = new Set(first.tools.names);
      const mine = new Set(b.tools.names);
      const added = [...mine].filter((n) => !base.has(n));
      const removed = [...base].filter((n) => !mine.has(n));
      if (added.length || removed.length) {
        lines.push(
          '',
          `tools/list of ${buildName(b)} against ${buildName(first)}:` +
            (added.length ? ` adds ${added.join(', ')}` : '') +
            (removed.length ? `${added.length ? ';' : ''} drops ${removed.join(', ')}` : '')
        );
      } else if (b.tools.hash !== first.tools.hash) {
        lines.push('', `tools/list of ${buildName(b)} names the same tools as ${buildName(first)} with different schemas.`);
      }
    }
  }
  if (surfaces.length) {
    lines.push('', '| condition | source | version | entry sha256 | commit | command |', '|---|---|---|---|---|---|');
    for (const [c, s] of surfaces) {
      const core = s.core ? `; playwright-core ${na(s.core.version)} ${short(s.core.coreBundle)}, ${short(s.core.utilsBundle)}` : '';
      lines.push(
        `| ${c} | ${na(s.source)} | ${na(s.version)} | ${s.sha256 ? short(s.sha256) : 'n/a'}${core} | ` +
          `${s.commit ? `${short(s.commit)}${s.dirty ? ' (dirty)' : ''}` : 'n/a'} | ${s.command ?? ''} |`
      );
    }
  }
  return lines;
}

// Rows that never called their own browser server measured nothing about it.
function invalidLines(results, totals) {
  const invalid = results.filter((r) => r.invalid);
  if (!invalid.length) return [];
  const lines = [
    '',
    `Invalid rows: ${invalid.length} row(s) never called their own browser server, or served the fixture to a browser ` +
      'their surface did not start, so they are left out of every column above (their spend below). A pass there came ' +
      'through another route and says nothing about the surface:',
  ];
  for (const r of invalid) {
    const foreign = foreignCallsOf(r) ? `; ${foreignCallsOf(r)} call(s) to other MCP servers` : '';
    const browser = r.foreign_browser?.sessions ? `; ${r.foreign_browser.sessions} foreign browser session(s)` : '';
    const died = r.server_exit ? `; ${serverExitText(r.server_exit)}` : '';
    lines.push(`  - ${r.condition}/${r.rep ? `${r.task} (r${r.rep})` : r.task}: ${r.invalid}, ${r.success ? 'passed' : 'failed'}${foreign}${browser}${died}`);
  }
  for (const [condition, t] of Object.entries(totals).filter(([, t]) => t.invalid)) {
    lines.push(`  - ${condition} spend on invalid rows: ${t.invalid_output_tokens} output tokens, $${t.invalid_cost_usd.toFixed(4)}`);
  }
  return lines;
}

// Rows a browser other than the surface's reached (scripts/foreign-browser.mjs).
// A row written before the guard existed is checked from its state file and
// tap log, and stays counted: only its row can say it is invalid.
function foreignLines(results, runDir) {
  const hit = results.map((r) => [r, foreignOf(r, runDir)]).filter(([, f]) => f?.sessions);
  if (!hit.length) return [];
  const lines = [
    '',
    `Foreign browser: ${hit.length} row(s) served pages to a browser session their surface did not start ` +
      '(the agent\'s shell reached another browser, such as the operator\'s):',
  ];
  for (const [r, f] of hit) {
    const first = f.first?.[0];
    lines.push(
      `  - ${r.condition}/${r.rep ? `${r.task} (r${r.rep})` : r.task}: ${f.sessions} session(s), ${f.requests} request(s) by ${f.method}` +
        (first ? `, first ${first.path} at ${first.at}${first.why ? ` (${first.why})` : ''}` : '') +
        (r.foreign_browser === undefined ? '; checked from the state file, the row predates the guard and still counts' : '')
    );
  }
  return lines;
}

// Rows whose shell got answers from a graded fixture route
// (scripts/row-evidence.mjs): their pass is not the surface's, so they are
// listed, and the totals give the pass count without them.
function shellAssistedLines(results, assisted) {
  const hit = results.map((r, i) => [r, assisted[i]]).filter(([, a]) => a);
  if (!hit.length) return [];
  const lines = [
    '',
    `Shell-assisted rows: ${hit.length} row(s) got answers through the agent's shell from a graded fixture route ` +
      '(an API or the /collect sink answered 2xx or 5xx, or a page a site hook writes session values into, fetched ' +
      'with a session), so a pass there did not come through the surface alone. ' +
      '`passed via surface` leaves them out, and eval/ab.mjs pairs without them:',
  ];
  for (const [r, a] of hit) {
    lines.push(`  - ${r.condition}/${r.rep ? `${r.task} (r${r.rep})` : r.task}: ${r.success ? 'passed' : 'failed'}, ${a.requests} request(s): ${a.paths.join(', ')}`);
  }
  return lines;
}

function sumRowTools(rows, runDir = null) {
  const tools = {};
  const ms = {};
  for (const r of rows) {
    for (const [name, t] of Object.entries(r.tools ?? {})) {
      const s = (tools[name] ??= { calls: 0, errors: 0, chars: 0, rows: 0 });
      s.calls += t?.calls ?? 0;
      s.errors += t?.errors ?? 0;
      s.chars += t?.chars ?? 0;
      s.rows++;
      if (t?.p50_ms != null) (ms[name] ??= []).push(t.p50_ms);
    }
  }
  for (const [name, list] of Object.entries(ms)) tools[name].p50_ms = median(list);
  const snapshots = rows.map((r) => snapshotOf(r, runDir));
  const sum = (key) =>
    snapshots.some((s) => s?.[key] != null) ? snapshots.reduce((n, s) => n + (s?.[key] ?? 0), 0) : null;
  const friction = rows.map((r) => frictionOf(r, runDir));
  const sumFriction = (key) =>
    friction.some((f) => f[key] != null) ? friction.reduce((n, f) => n + (f[key] ?? 0), 0) : null;
  return {
    rows: rows.length,
    tools,
    snapshot: {
      calls: sum('calls'), chars: sum('chars'), truncated: sum('truncated'), file_reads: sum('file_reads'), file_chars: sum('file_chars'),
    },
    friction: Object.fromEntries(
      [
        'act_then_snap', 'act_then_read', 'actions', 'eval_calls', 'scripted_writes', 'page_text_reads', 'page_text_chars', 'stale_uid',
        'malformed_uid', 'restarts', 'closes', 'closed_at_end', 'sleeps', 'persisted',
        'persisted_other', 'unknown_tools', 'tool_search', 'harness_truncated', 'noops', 'output_file_reads',
        'api_retries', 'api_retry_s',
      ].map(
        (k) => [k, sumFriction(k)]
      )
    ),
  };
}

// Per condition, what each tool was asked for and what it returned: from the
// MCP tap on rows that carry `tools`, else recovered from the transcripts.
function toolLines(results, runDir) {
  const conditions = [...new Set(results.map((r) => r.condition))];
  const graded = results.filter((r) => !r.infra && !r.error);
  const tapped = graded.some((r) => r.tools);
  if (!tapped && !runDir) return [];
  const derived = tapped ? null : runToolStats(runDir, graded);
  if (derived && !derived.some((d) => d.stats)) return [];
  const lines = [
    '',
    '## Per-tool summary',
    '',
    tapped
      ? 'From the MCP tap on each row. `p50 ms` is the median of the rows\' own p50s.'
      : 'Recovered from the transcripts (eval/scripts/tool-stats.mjs), because these rows predate the MCP tap. Codex events carry no timestamps, so codex rows have no latency.',
  ];
  for (const condition of conditions) {
    const rows = graded.filter((r) => r.condition === condition);
    const t = tapped
      ? sumRowTools(rows.filter((r) => r.tools), runDir)
      : sumToolStats(derived.filter((d) => d.row.condition === condition).map((d) => d.stats));
    const names = Object.entries(t.tools).sort((a, b) => b[1].calls - a[1].calls);
    if (!names.length) continue;
    lines.push('', `**${condition}** (${t.rows} rows)`, '', '| tool | calls | rows | errors | chars/call | p50 ms |', '|---|---|---|---|---|---|');
    for (const [name, s] of names.slice(0, 15)) {
      lines.push(`| ${name} | ${s.calls} | ${s.rows} | ${s.errors} | ${Math.round(s.chars / (s.calls || 1))} | ${na(round(s.p50_ms))} |`);
    }
    if (names.length > 15) lines.push(`| ${names.length - 15} more | ${names.slice(15).reduce((n, [, s]) => n + s.calls, 0)} | | | | |`);
    const sn = t.snapshot ?? {};
    const fr = t.friction ?? {};
    const bits = [
      sn.calls != null &&
        `snapshots ${sn.calls} (${na(sn.chars)} chars${sn.file_reads ? `, ${sn.file_chars} of them from ${sn.file_reads} snapshot file(s) read back` : ''}, ${na(sn.truncated)} with a cut)`,
      fr.eval_calls != null && `script calls ${fr.eval_calls}${fr.scripted_writes ? ` (${fr.scripted_writes} writing the page)` : ''}`,
      fr.page_text_reads ? `page text reads ${fr.page_text_reads} (${na(fr.page_text_chars)} chars)` : null,
      fr.act_then_snap != null && `action then snapshot ${fr.act_then_snap}${fr.actions ? `/${fr.actions}` : ''}`,
      fr.act_then_read != null && `action then any read ${fr.act_then_read}${fr.actions ? `/${fr.actions}` : ''}`,
      fr.stale_uid != null && `stale uid ${fr.stale_uid}`,
      fr.malformed_uid ? `malformed uid or ref ${fr.malformed_uid}` : null,
      fr.output_file_reads ? `other surface files read back ${fr.output_file_reads}` : null,
      fr.api_retries ? `API retries ${fr.api_retries} (${Math.round(fr.api_retry_s ?? 0)} s waited)` : null,
      fr.restarts != null && `restarts ${fr.restarts}`,
      fr.closes ? `browser closes ${fr.closes} (${fr.closed_at_end ?? 0} as a row's last call)` : null,
      fr.sleeps != null && `waits ${fr.sleeps}`,
      fr.persisted != null && `results spilled to <persisted-output> ${fr.persisted}${fr.persisted_other ? ` (+${fr.persisted_other} shell or file-tool)` : ''}`,
      fr.unknown_tools ? `calls to tools the server lacks ${fr.unknown_tools}` : null,
      fr.tool_search ? `tool discovery calls ${fr.tool_search}` : null,
      fr.harness_truncated ? `outputs the harness cut before the model read them ${fr.harness_truncated}` : null,
      fr.noops ? `no-ops and misses the validators counted ${fr.noops}` : null,
      !tapped && t.no_surface_rows != null && `rows with no surface call ${t.no_surface_rows}`,
      !tapped && t.foreign_rows != null && `rows calling another MCP server ${t.foreign_rows}`,
    ].filter(Boolean);
    if (bits.length) lines.push('', bits.join(' · '));
  }
  return lines;
}

// What the server saw each row request, summed per condition (state.ledger).
function ledgerLines(results) {
  const rows = results.filter((r) => r.ledger);
  if (!rows.length) return [];
  const lines = [
    '',
    '## Server ledger',
    '',
    '`shell` counts requests without the browser\'s Fetch Metadata, which on these loopback origins only a client outside the page sends (the agent\'s curl).',
    '',
    '| condition | rows | requests | documents | scripted | shell | shell rows | by status |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const condition of [...new Set(rows.map((r) => r.condition))]) {
    const rs = rows.filter((r) => r.condition === condition);
    const sum = (k) => rs.reduce((n, r) => n + (r.ledger[k] ?? 0), 0);
    const status = {};
    for (const r of rs) for (const [s, n] of Object.entries(r.ledger.byStatus ?? {})) status[s] = (status[s] ?? 0) + n;
    lines.push(
      `| ${condition} | ${rs.length} | ${sum('requests')} | ${sum('documents')} | ${sum('scripted')} | ` +
        `${sum('non_browser')} | ${rs.filter((r) => r.ledger.non_browser).length} | ${statusList(status)} |`
    );
  }
  return lines;
}

// Paired rows (one task and repeat under several conditions) should face the
// same difficulty draws when the run is seeded; the draw log on each row says
// whether they did.
function drawLines(results) {
  const groups = new Map();
  for (const r of results.filter((x) => Array.isArray(x.draws))) {
    const k = `${r.task}#${r.rep ?? 1}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const paired = [...groups.values()].filter((rs) => new Set(rs.map((r) => r.condition)).size > 1);
  if (!paired.length) return [];
  const name = (r) => r.task + (r.rep ? ` (r${r.rep})` : '');
  const differ = paired.filter((rs) => new Set(rs.map((r) => drawKey(r.draws).key)).size > 1);
  const extra = results.filter((r) => Array.isArray(r.draws) && drawKey(r.draws).extra);
  const lines = [
    '',
    differ.length
      ? `DRAWS DIFFER on ${differ.length} of ${paired.length} paired task repeats, so those conditions faced different variants: ` +
        differ.slice(0, 10).map((rs) => name(rs[0])).join(', ')
      : `Draws: every one of ${paired.length} paired task repeats faced the same first pick per scope in every condition.`,
  ];
  if (extra.length) {
    lines.push(
      `${extra.length} row(s) drew a scope again after its first pick (a later session), which the comparison above leaves out: ` +
        extra.slice(0, 10).map((r) => `${r.condition}/${name(r)} +${drawKey(r.draws).extra}`).join(', ')
    );
  }
  return lines;
}

// What the preflight measured, as [label, read(env)] columns. The user agent is
// compared with its version numbers removed, since `firefox` already compares
// those.
const ENV_COLUMNS = [
  ['Firefox', (e) => e.firefox],
  ['locale', (e) => e.locale],
  ['Accept-Language', (e) => e.acceptLanguage],
  ['time zone', (e) => e.timeZone],
  ['viewport', (e) => e.viewport],
  ['colour scheme', (e) => e.colorScheme],
];
export const ENV_COMPARED = [
  ...ENV_COLUMNS,
  ['navigator.languages', (e) => (e.languages ?? []).join(',')],
  ['device pixel ratio', (e) => e.devicePixelRatio],
  ['user agent', (e) => String(e.userAgent ?? '').replace(/\d+(\.\d+)*/g, 'N')],
  // Whether a PDF opens in pdf.js or downloads: unflagged, pdf-bill compared
  // the viewer against a host pdftotext of downloaded bills. A run whose
  // preflight predates the measurement is read from its build's files.
  ['navigator.pdfViewerEnabled', (e) => e.pdfViewerEnabled ?? (e.build?.pdfjs ? e.build.pdfjs.startsWith('enabled') : null)],
];
// The pins a measured value is held to, by column label.
export const PINNED = {
  locale: 'locale',
  'time zone': 'timeZone',
  viewport: 'viewport',
  'colour scheme': 'colorScheme',
  'navigator.pdfViewerEnabled': 'pdfViewerEnabled',
};

// A condition's Firefox build as its files named it (mcp-stdio.mjs
// firefoxBuild): two builds can report one version, as a release Firefox and
// Playwright's patched build of it would.
const buildOf = (e) => (e?.build && (e.build.version || e.build.buildID) ? `${e.build.version ?? '?'} ${e.build.buildID ?? '?'}` : null);

// Every way the conditions' browsers differed from each other or from their
// pins. A run's numbers compare surfaces only as far as these allow.
export function envMismatches(meta) {
  const measured = Object.entries(meta.env ?? {}).filter(([, e]) => !e.unmeasured);
  const out = Object.entries(meta.env ?? {})
    .filter(([, e]) => e.unmeasured)
    .map(([c, e]) => `${c} unmeasured (${e.unmeasured})`);
  // Over the conditions whose build was read; --mcp-command's never is, and
  // the build table says so. When every measured condition's was, the line
  // names each user agent's version too, so one difference is not counted as
  // two.
  const builds = Object.entries(meta.env ?? {}).map(([c, e]) => [c, buildOf(e), e]).filter(([, b]) => b);
  const buildsDiffer = new Set(builds.map(([, b]) => b)).size > 1;
  const folded = buildsDiffer && measured.every(([c]) => builds.some(([b]) => b === c));
  if (buildsDiffer) {
    const ua = (e) => (folded && !e.unmeasured && e.firefox ? ` (user agent ${e.firefox})` : '');
    out.push(`Firefox build differs: ${builds.map(([c, b, e]) => `${c} ${b}${ua(e)}`).join(', ')}`);
  }
  for (const [label, read] of ENV_COMPARED) {
    if (folded && label === 'Firefox') continue;
    const values = measured.map(([c, e]) => [c, read(e)]);
    if (new Set(values.map(([, v]) => JSON.stringify(v))).size > 1) {
      out.push(`${label} differs: ${values.map(([c, v]) => `${c} ${v}`).join(', ')}`);
    }
    const pin = meta.envPins?.[PINNED[label]];
    if (pin == null) continue;
    for (const [c, v] of values) {
      if (v !== pin) out.push(`${c} ${label} is ${v}, not the pinned ${pin}`);
    }
  }
  return out;
}

// How a --rerun-failed top-up's browsers differed from those of the run it tops
// up, whose rows it is read with. `prior` is that run's meta; one without env
// predates the pins.
export function envDrift(prior, meta) {
  if (!prior.env || !prior.envPins) {
    return ['that run predates the browser pins of 2026-09-19, so its rows ran unpinned'];
  }
  const out = [];
  for (const [c, now] of Object.entries(meta.env ?? {})) {
    const then = prior.env[c];
    if (!then) {
      out.push(`${c} was not measured in that run`);
    } else if (then.unmeasured || now.unmeasured) {
      if (!then.unmeasured !== !now.unmeasured) {
        out.push(`${c} was ${then.unmeasured ? 'unmeasured' : 'measured'} then, ${now.unmeasured ? 'unmeasured' : 'measured'} now`);
      }
    } else {
      const rebuilt = buildOf(then) && buildOf(now) && buildOf(then) !== buildOf(now);
      if (rebuilt) {
        const ua = then.firefox !== now.firefox ? ` (user agent ${then.firefox}, now ${now.firefox})` : '';
        out.push(`${c} Firefox build was ${buildOf(then)}, now ${buildOf(now)}${ua}`);
      }
      for (const [label, read] of ENV_COMPARED) {
        if (rebuilt && label === 'Firefox') continue;
        if (JSON.stringify(read(then)) !== JSON.stringify(read(now))) {
          out.push(`${c} ${label} was ${read(then)}, now ${read(now)}`);
        }
      }
    }
  }
  const pins = meta.envPins ?? {};
  const changed = Object.keys({ ...prior.envPins, ...pins }).filter(
    (k) => JSON.stringify(prior.envPins[k]) !== JSON.stringify(pins[k])
  );
  if (changed.length) out.push(`pins changed: ${changed.join(', ')}`);
  return out;
}

// A condition's PDF handling as its preflight measured it, else as its build's
// files say, else as its browser is known to ship: Playwright's Firefox build
// turns pdf.js off in its playwright.cfg, so a PDF downloads there unless the
// pin turns it back on (Playwright's launch sets the pinned pref again over the
// cfg, and firefox-devtools-mcp's needs the policy mcp-stdio.mjs
// devtoolsFirefoxLaunch writes), and renders inline in pdf.js in a release
// Firefox.
function pdfViewer(condition, env) {
  const build = env?.build;
  const why = build?.pdfjs && build.pdfjs !== 'enabled' ? `; ${build.pdfjs}` : '';
  if (typeof env?.pdfViewerEnabled === 'boolean') {
    return `${env.pdfViewerEnabled ? 'pdf.js (renders inline)' : 'none (downloads)'}${why}`;
  }
  if (build?.pdfjs) {
    return build.pdfjs.startsWith('enabled') ? `pdf.js (renders inline)${why}` : `${build.pdfjs} (downloads)`;
  }
  const bare = condition.split('/').pop();
  return bare === 'playwright-mcp'
    ? 'disabled by playwright.cfg (downloads); not recorded, Playwright\'s build'
    : bare.startsWith('firefox-devtools-mcp')
      ? 'pdf.js (renders inline); not recorded, a release Firefox'
      : '?';
}

// What a dirty eval tree differed by, for a run that recorded it.
function dirtyNote(git) {
  if (!git?.dirtyFiles) return '';
  const diff = git.diffError ? `eval diff not hashed: ${git.diffError}` : `eval diff sha256 ${short(git.diffSha256)}`;
  return ` (${git.dirtyFiles.length} dirty file(s); ${diff})`;
}

// Which Firefox build each condition's rows ran on: the preflight's reading,
// then every build the rows recorded, so a desktop Firefox that updated
// between two attempts shows as two builds.
function buildTableLines(meta, results) {
  const conditions = Object.keys(meta.env ?? {});
  if (!conditions.length) return [];
  const perRow = browserBuilds(results);
  const lines = [
    '',
    '| condition | binary | version | build ID | PDF viewer | builds the rows ran on |',
    '|---|---|---|---|---|---|',
  ];
  for (const c of conditions) {
    const b = meta.env[c]?.build;
    const seen = Object.entries(perRow)
      .filter(([label]) => label.split('/').pop() === c)
      .flatMap(([, builds]) => builds);
    lines.push(
      `| ${c} | ${b?.binary ?? 'not recorded'} | ${b?.version ?? meta.env[c]?.firefox ?? '?'} | ${b?.buildID ?? 'not recorded'} | ` +
        `${pdfViewer(c, meta.env[c])} | ${seen.length ? seen.map((s) => `${s.version ?? '?'} ${s.buildID ?? '?'} (${s.rows} rows)`).join('; ') : 'not recorded per row'} |`
    );
  }
  return lines;
}

// The two tools launch Firefox their own ways, which no pin covers and which
// holds whatever the build: Playwright sets its prefs again over
// playwright.cfg once the browser is up, and firefox-devtools-mcp's
// geckodriver, with the Remote Agent it starts, leaves prefs set that
// Playwright's launch leaves at their defaults (spikes/launch-prefs.mjs lists
// them). Null unless `conditions` hold a measured firefox-devtools-mcp
// condition and playwright-mcp.
export function launcherNote(meta, conditions = Object.keys(meta.env ?? {})) {
  const bare = (c) => String(c).split('/').pop();
  const ran = (c) => meta.env?.[bare(c)] && !meta.env[bare(c)].unmeasured;
  const build = (c) => buildOf(meta.env?.[bare(c)]);
  const pw = conditions.filter((c) => bare(c) === 'playwright-mcp' && ran(c));
  const dt = conditions.filter((c) => bare(c).startsWith('firefox-devtools-mcp') && ran(c));
  if (!pw.length || !dt.length) return null;
  const shared = dt.filter((c) => build(c) && pw.some((p) => build(p) === build(c)));
  const list = (xs) => (xs.length > 2 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs.join(' and '));
  return (
    `${list([...dt, ...pw])} launch Firefox their own ways, whatever the build: firefox-devtools-mcp's geckodriver, ` +
    "with the Remote Agent it starts, sets prefs that Playwright's launch leaves at their defaults, such as " +
    'dom.successive_dialog_time_limit and dom.navigation.navigationRateLimit.count (eval/spikes/launch-prefs.mjs lists them)' +
    (shared.length ? `; ${list(shared)} ran ${list(pw)}'s Firefox build, ${build(shared[0])}, so these prefs, not the build, are what differs` : '')
  );
}

function envLines(meta, results = []) {
  if (!meta.env) return [];
  const pins = meta.envPins ?? {};
  const lines = [
    '',
    '## Condition environment',
    '',
    `What each condition's browser reported in the preflight. Pinned for every ` +
      `condition: locale ${pins.locale}, time zone ${pins.timeZone}, viewport ` +
      `${pins.viewport}, colour scheme ${pins.colorScheme}` +
      `${pins.pdfViewerEnabled == null ? '' : `, pdf.js ${pins.pdfViewerEnabled ? 'on' : 'off'}`}.`,
    '',
    `| condition | ${ENV_COLUMNS.map(([label]) => label).join(' | ')} |`,
    `|---|${ENV_COLUMNS.map(() => '---').join('|')}|`,
  ];
  for (const [condition, e] of Object.entries(meta.env)) {
    lines.push(
      e.unmeasured
        ? `| ${condition} | ${ENV_COLUMNS.map(() => '?').join(' | ')} |`
        : `| ${condition} | ${ENV_COLUMNS.map(([, read]) => read(e) ?? '?').join(' | ')} |`
    );
  }
  lines.push(...buildTableLines(meta, results));
  const mismatches = envMismatches(meta);
  const launchers = launcherNote(meta);
  lines.push('');
  if (mismatches.length) {
    lines.push('ENVIRONMENT MISMATCH, so a difference between these conditions may come from these rather than the surface:');
    for (const m of mismatches) lines.push(`  - ${m}`);
  } else {
    lines.push(
      launchers
        ? 'The conditions ran in the same measured browser environment, apart from the launch prefs below.'
        : 'The conditions ran in the same browser environment.'
    );
  }
  if (launchers) lines.push('', `LAUNCH PREFS DIFFER: ${launchers}.`);
  if (meta.rerunEnvDrift?.length) {
    lines.push(
      '',
      `ENVIRONMENT DIFFERS from ${meta.rerunFailed}, the run this tops up, so a row here ` +
        'and a row there may differ by environment rather than by surface:'
    );
    for (const d of meta.rerunEnvDrift) lines.push(`  - ${d}`);
  }
  return lines;
}

// The rows as the report reads them, and the totals and shell assistance its
// totals table is built from. A codex row that predates row.code_mode is read
// with its rollout's, and its turns become the rollout's model requests
// (row-evidence.mjs), so the totals are summed again over those rows.
// scripts/run-health.mjs holds a stored report.md's table to this.
export function headline({ results: stored, totals: given = null, runDir = null }) {
  const results = stored.map((r) => withRolloutFacts(r, runDir));
  const totals = given && results.every((r, i) => r === stored[i]) ? given : totalsByCondition(results);
  const assisted = results.map((r) => shellAssistedOf(r, runDir));
  return { results, totals, assisted };
}

// The totals table, header first, one line per condition.
export function totalsTableLines({ results, totals, assisted }) {
  const lines = [
    '| condition | passed | infra | invalid | shell-assisted | passed via surface | turns | input | cache write | cache read | output | cost (USD) | api (s) | wall (s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [condition, t] of Object.entries(totals)) {
    const shelled = results.filter((r, i) => r.condition === condition && assisted[i] && !r.invalid && !r.infra);
    const shelledPasses = shelled.filter((r) => r.success).length;
    lines.push(
      `| ${condition} | ${t.passed}/${t.tasks} | ${t.infra} | ${t.invalid ?? 0} | ${shelled.length} | ` +
        `${t.passed - shelledPasses}/${t.tasks - shelled.length} | ${na(t.turns)} | ${na(t.input_tokens)} | ` +
        `${na(t.cache_creation)} | ${na(t.cache_read)} | ${na(t.output_tokens)} | ${na(t.cost_usd)} | ${na(t.api_s)} | ${na(t.wall_s)} |`
    );
  }
  return lines;
}

// `runDir`, when given, lets the report read the run's transcripts for what
// older rows do not carry: per-tool telemetry and the evidence triage needs.
// `tasks` (identity.mjs taskInfo) lets triage test a task's named truth.
// `health` is the run's health in one line (scripts/run-health.mjs healthLine),
// which the header prints when given.
export function markdownReport({ meta, results: stored, totals: given, runDir = null, tasks = null, health = null }) {
  const { results, totals, assisted } = headline({ results: stored, totals: given, runDir });
  const models = Object.entries(meta.models ?? {})
    .map(([b, m]) => `${b}: ${m}`)
    .join(', ');
  const mismatches = envMismatches(meta);
  const flags = runFlags(meta, results, { runDir });
  const arms = new Set(results.map((r) => r.condition)).size;
  // Triaged here even when a row carries its own class: only the whole run
  // shows whether every other arm failed the same task alike.
  const triages = triageRun(results, { runDir, tasks });
  const lines = [
    `# zoo-sites eval report`,
    '',
    `- date: ${meta.date}`,
    `- backend: ${meta.backend} · models: ${models} · effort: ${meta.effort} · suite: ${meta.suite}` +
      (meta.repeat ? ` · repeat: ${meta.repeat}` : '') +
      (meta.seed ? ` · seed: ${meta.seed}` : ''),
    ...(meta.interrupted
      ? [
          `- INTERRUPTED by ${meta.interrupted}: tasks it kept from starting are missing, and ` +
            `the attempts it stopped count as infra` +
            (meta.unsettled
              ? `. ${meta.unsettled} attempt(s) still running when this was written are missing too`
              : '') +
            (meta.tasks ? '. `--rerun-failed` on this run selects the missing tasks' : ''),
        ]
      : []),
    `- tasks are simulated local pages (no live web); harness: run.mjs`,
    ...(health ? [`- ${health}`] : []),
    // Unseeded, each arm draws its own difficulty variants (seat-picker's plan,
    // pr-review's defect), so a paired difference carries draw noise too.
    ...(!meta.seed && arms > 1
      ? [
          `- UNSEEDED multi-arm run: each of the ${arms} arms drew its own difficulty variants, so a ratio ` +
            'between them includes draw-to-draw differences. Seed paired runs (--seed).',
        ]
      : []),
    ...flags
      .filter((f) => ['contaminated', 'pre-isolation', 'pricing_v1', 'foreign-calls', 'browser-changed', 'eval-dirty'].includes(f.flag))
      .map((f) => `- ${f.flag.toUpperCase()}: ${f.why}${f.flag === 'eval-dirty' ? dirtyNote(meta.git) : ''}`),
    // Serving is a measurement epoch: single-origin URLs name the pages/
    // directory, which can describe the test (/flaky/slow.html, /maze/).
    `- serving: ${SERVING_NOTE[meta.serving ?? 'single-origin']}.` +
      (meta.serving ? '' : ' Not recorded: the run predates per-origin serving.') +
      ' Runs served differently are separate measurement epochs; do not compare them.',
    ...(mismatches.length
      ? [`- ENVIRONMENT MISMATCH between conditions (${mismatches.length}): see "Condition environment"`]
      : []),
    ...(runDir
      ? ledgerFailures(conditionGroups(results), runDir, meta).map((f) => `- TOKENS-CHECK: ${f}; see "Where the tokens go"`)
      : []),
    ...(runDir
      ? lateServerRows(conditionGroups(results, () => true), runDir, meta).map(
          (x) => `- LATE-SERVER: ${x}; each row's first request went out before its MCP server connected, so it carried none of the server's tools`
        )
      : []),
    ...(launcherNote(meta) ? ['- LAUNCH PREFS DIFFER between firefox-devtools-mcp and playwright-mcp: see "Condition environment"'] : []),
    ...(meta.rerunEnvDrift?.length
      ? [
          `- ENVIRONMENT DIFFERS from the run this tops up (${meta.rerunEnvDrift.length}): ` +
            'see "Condition environment"',
        ]
      : []),
    // run.mjs rerunBuildDrift: the tools, agent and tasks themselves, not the
    // browser they ran in.
    ...(meta.rerunBuildDrift?.length
      ? [
          `- BUILDS DIFFER from ${meta.rerunFailed}, the run this tops up, so a row here and a row there ` +
            'of one condition ran different code:',
          ...meta.rerunBuildDrift.map((d) => `  - ${d}`),
        ]
      : []),
    `- compare on OUTPUT TOKENS. Turns are model requests: the Agent SDK's ` +
      `turns, and the requests codex's rollout records (tool calls plus one on ` +
      `a codex row without its rollout). They compare only between runs whose ` +
      `backend counts them the same way, and a surface that packs several ` +
      `browser operations into one call does more per turn.`,
    ...(results.some((r) => r.turns_counted != null)
      ? [
          `- codex turns: ${results.filter((r) => r.turns_counted != null).length} row(s) predate row.code_mode, so their ` +
            `turns are read from their rollouts' model requests, ${results.reduce((n, r) => n + (r.turns_counted != null ? r.turns : 0), 0)} ` +
            `against the ${results.reduce((n, r) => n + (r.turns_counted ?? 0), 0)} (tool calls plus one) the rows recorded`,
        ]
      : []),
    ...(assisted.some(Boolean)
      ? [
          `- SHELL-ASSISTED: ${assisted.filter(Boolean).length} row(s) got answers through the agent's shell from a ` +
            'graded fixture route; they stay out of the pass counts compared between conditions (see "Shell-assisted rows")',
        ]
      : []),
    `- input columns are additive and comparable: \`input\` is the UNCACHED ` +
      `remainder for every backend, so total input is input + cache write + ` +
      `cache read. Codex reports an inclusive figure upstream and is normalized.`,
    `- cost below is what THIS run spent, for budgeting. Do not compare it against ` +
      `another run's: cache-creation volume swung 6x between two runs with identical ` +
      `turn counts, moving a cost ratio from 1.50 to 1.03. Cost ratios WITHIN one ` +
      `run are fine, since both conditions met the same cache.`,
    ...(meta.backend.includes('codex')
      ? [
          `- cost: anthropic is SDK-reported; codex is computed from token counts, ` +
            `spread over the requests it priced them as (the rollout's, or tool calls plus one on a row ` +
            `that predates the rollout count), against genai-prices' bundled table, ` +
            `so the two are not measured the same way`,
        ]
      : []),
    ...envLines(meta, results),
    ...buildLines(meta),
    '',
    '## Totals per condition',
    '',
    '`passed` is out of every row charged to the agent: graded attempts, plus',
    'harness stops and backend errors, which count as failures. `infra` counts rows',
    'that never reached a grade because an API or transport error outlived',
    '`--retries` or an interrupt stopped them. The token and cost columns sum graded',
    'attempts; spend on discarded attempts (retries, harness stops, errors) is',
    'totalled under "Discarded attempts" below, because it was really spent. A',
    'wall-limit stop is a failure, not infra: the agent spent every retry on the',
    'clock. `shell-assisted` counts rows whose shell got answers from a graded',
    'route, and `passed via surface` leaves them out of both sides of the pass count.',
    '',
    ...totalsTableLines({ results, totals, assisted }),
  ];
  lines.push(...invalidLines(results, totals));
  lines.push(...shellAssistedLines(results, assisted));
  lines.push(...foreignLines(results, runDir));
  // Extraction spend is reported once for the run, never per condition: the
  // extractor is condition-blind and its usage is excluded from every metric
  // above (docs/grading-design.md). A row whose backend returned its fields
  // (extractor 'backend') made no extraction call.
  const extracted = results.filter((r) => r.extraction && r.extraction.extractor !== 'backend');
  if (extracted.length) {
    const byExtractor = new Map();
    for (const r of extracted) {
      const key = `${r.extraction.extractor}/${r.extraction.model}`;
      byExtractor.set(key, (byExtractor.get(key) ?? 0) + 1);
    }
    const spend = extracted.reduce((n, r) => n + (r.extraction.cost_usd ?? 0), 0);
    const via = [...byExtractor].map(([key, n]) => `${n} rows via ${key}`).join(', ');
    lines.push(
      '',
      `Structured answer extraction: ${via}, ` +
        `$${spend.toFixed(4)} total (excluded from the per-condition metrics above).`
    );
  }
  // A failure caused by the surface hiding the value is a finding about the tool,
  // not about the agent, and the pass count alone conflates them. Truncation is
  // reported because it is provable: the value's opening reached the agent with
  // the truncator's ellipsis where the rest should have been.
  const cutRows = results.filter((r) => surfaceOf(r, runDir)?.truncated?.length);
  if (cutRows.length) {
    const lost = cutRows.filter((r) => !r.success);
    lines.push(
      '',
      `Surface truncation: ${cutRows.length} row(s) had a graded value cut before it ` +
        `reached the agent, ${lost.length} of which failed. Those failures are the ` +
        `tool surface, not the agent; see the per-task notes.`
    );
    for (const r of lost) {
      lines.push(`  - ${r.condition}/${r.rep ? `${r.task} (r${r.rep})` : r.task}: ${JSON.stringify(surfaceOf(r, runDir).truncated)}`);
    }
  }
  // A pass on a value the surface cut is a pass the agent reached by completing
  // the value itself, which says nothing good about the surface.
  const guessedOf = new Map(results.map((r) => [r, guessedValues(r, runDir, tasks)]));
  const guessed = [...guessedOf].filter(([, g]) => g.length);
  if (guessed.length) {
    lines.push(
      '',
      `Guessed passes: ${guessed.length} row(s) passed on a graded value the surface cut before it reached the ` +
        'agent, so the agent completed it without seeing it. They count as passes above; read them as the surface failing:'
    );
    for (const [r, g] of guessed) {
      lines.push(`  - ${r.condition}/${r.rep ? `${r.task} (r${r.rep})` : r.task}: ${JSON.stringify(g)}`);
    }
  }
  // A validator that throws is a harness defect. Its row stays a failure, since
  // excusing it could hide a real one.
  const brokenGrades = results.filter((r) => r.validator_error);
  if (brokenGrades.length) {
    lines.push(
      '',
      `Validator errors: ${brokenGrades.length} row(s) count as failures above, but the ` +
        `validator threw, so the agent's answer was never judged. Fix the validator ` +
        `and rerun them: ` +
        brokenGrades.map((r) => `${r.condition}/${r.task}`).join(', ')
    );
  }
  // Spend the columns above cannot see: attempts discarded by retries, harness
  // stops and errors still hit the API. An attempt the harness killed is priced
  // when its backend reported what it had spent; one it reported nothing for is
  // counted rather than guessed at.
  const discarding = Object.entries(totals).filter(([, t]) => t.discarded_attempts);
  if (discarding.length) {
    lines.push('', 'Discarded attempts (not in the columns above):');
    for (const [condition, t] of discarding) {
      lines.push(
        `  - ${condition}: ${t.discarded_attempts} attempt(s), ${t.discarded_output_tokens} ` +
          `output tokens, $${t.discarded_cost_usd.toFixed(4)}` +
          (t.discarded_unknown
            ? `; ${t.discarded_unknown} of them unpriced, because their backend reported no spend for them`
            : '')
      );
    }
  }
  lines.push(...drawLines(results));
  const partial = !runDir && results.some((r) => !r.success && r.surface_calls == null && r.tools == null);
  lines.push(...triageLines(results, triages, { partial }));
  lines.push(...toolLines(results, runDir));
  lines.push(...toolSearchLines(results, meta, runDir));
  if (runDir) lines.push(...conditionLedgerLines(results, runDir, meta));
  lines.push(...ledgerLines(results));
  lines.push('', '## Per-task results', '',
    '| condition | task | pass | turns | input | cache write | cache read | output | cost | api (s) | wall (s) | notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const [i, r] of results.entries()) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    // Fields-graded rows lead with the extracted claim (the thing that was
    // graded); the validator detail keeps the sub-check breakdown and the
    // route telemetry.
    // The validator detail conventionally ends with its own fields echo;
    // trim it from the last ' fields={' so nested-object fields do not print
    // twice (a brace-blind regex would miss them).
    const trimFieldsEcho = (text) => {
      const i = text.lastIndexOf(' fields={');
      return i === -1 ? text : text.slice(0, i);
    };
    const noteBase =
      r.grading === 'fields'
        ? `fields=${JSON.stringify(r.fields)} — ${trimFieldsEcho(String(r.detail ?? r.error ?? ''))}`
        : (r.detail ?? r.error ?? '');
    // A failure whose value the surface truncated is not the same result as a
    // failure the agent owns, so say which in the row rather than only in JSON.
    const surface = surfaceOf(r, runDir);
    const cut = surface?.truncated?.length
      ? `SURFACE TRUNCATED ${JSON.stringify(surface.truncated)} — `
      : '';
    const saved = r.downloads?.length
      ? ` — downloaded ${r.downloads
          .map((d) => `${d.name} (${d.error ? `unreadable: ${d.error}` : `${d.bytes} B`})`)
          .join(', ')}`
      : '';
    const cls = r.success ? null : classOf(triages[i]);
    const guess = guessedOf.get(r).length ? 'GUESSED (passed on a value the surface cut) — ' : '';
    const shelled = assisted[i]
      ? `SHELL-ASSISTED (${assisted[i].requests} shell request(s) answered on graded routes: ${assisted[i].paths.join(', ')}) — `
      : '';
    const lead = (r.invalid ? `INVALID (${r.invalid}) — ` : '') + shelled + guess + (cls ? `[${cls}] ` : '');
    // What else reached the fixture or the model outside the surface's own
    // replies: shell requests, another browser, a tap that disagrees with the
    // stream, ToolSearch and spilled results.
    const fr = frictionOf(r, runDir);
    // Every codex code-mode row opens with a catalog exec, which is no
    // ToolSearch and would flag every row.
    const searched = (fr.tool_search ?? 0) - (r.code_mode?.discovery_execs ?? 0);
    const foreign = foreignOf(r, runDir);
    const shell = r.ledger?.non_browser
      ? `SHELL ${r.ledger.non_browser} request(s) to the fixtures${shellStatusOf(r, runDir) ? ` (${statusList(shellStatusOf(r, runDir))})` : ''}`
      : '';
    const flags = [
      shell,
      foreign?.sessions ? `FOREIGN BROWSER ${foreign.sessions} session(s), ${foreign.requests} request(s) (${foreign.method})` : '',
      r.tap_mismatch ? `TAP MISMATCH tap ${r.tap_mismatch.tap} / stream ${r.tap_mismatch.stream}` : '',
      r.server_exit ? `SERVER DIED: ${serverExitText(r.server_exit)}` : '',
      fr.unknown_tools ? `${fr.unknown_tools} call(s) to a tool the server lacks` : '',
      searched ? `ToolSearch ${searched} call(s), ${fr.tool_search_turns} ToolSearch-only turn(s)` : '',
      fr.persisted || fr.persisted_other ? `SPILLED ${(fr.persisted ?? 0) + (fr.persisted_other ?? 0)} result(s) to <persisted-output>` : '',
      fr.harness_truncated ? `HARNESS TRUNCATED ${fr.harness_truncated} tool output(s) before the model read them` : '',
      noopsOf(r)?.count ? `NO-OPS OR MISSES ${noopsOf(r).keys.join(', ')}` : '',
      fr.malformed_uid ? `${fr.malformed_uid} malformed uid(s) or ref(s)` : '',
      fr.scripted_writes ? `SCRIPTED WRITES ${fr.scripted_writes} script call(s) wrote the page` : '',
      fr.api_retries ? `API RETRIES ${fr.api_retries} (${fr.api_retry_s} s waited, in wall time)` : '',
    ].filter(Boolean);
    const body =
      (r.extraction_failed ? `${cut}EXTRACTION FAILED (${r.extraction_failed}) — ${noteBase}` : cut + noteBase) + saved;
    const note = lead + [body, flags.join('; ')].filter((x) => x.trim()).join(' — ');
    lines.push(
      `| ${r.condition} | ${task} | ${r.success ? 'PASS' : 'FAIL'} | ${r.turns ?? ''} | ` +
        `${r.input_tokens ?? ''} | ${r.cache_creation ?? ''} | ` +
        `${r.cache_read ?? ''} | ${r.output_tokens ?? ''} | ${r.cost_usd?.toFixed?.(4) ?? ''} | ` +
        `${r.api_s ?? ''} | ${r.wall_s ?? ''} | ${cell(note)} |`
    );
  }
  if (meta.repeat) {
    lines.push(...medianLines(results, runDir));
  }
  lines.push('', '## Answers (truncated)', '');
  for (const r of results) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    lines.push(`- **${r.condition}/${task}**: ${r.answer ?? '(error)'}`);
  }
  return lines.join('\n') + '\n';
}
