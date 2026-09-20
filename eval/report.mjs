// Pure reporting over a run's result rows: per-condition totals, per-task
// medians across repeats, and the shareable report.md. run.mjs writes both at
// the end of a run (and on an interrupt), and --report-from re-renders them
// from a finished run's results.json. Every field a newer runner writes is
// optional here, so a results.json from any earlier run still renders.

import { buildName, countOf, drawKey, runFlags } from './scripts/identity.mjs';
import { runToolStats, sumToolStats } from './scripts/tool-stats.mjs';
import { classOf, triageLines, triageRun } from './scripts/triage.mjs';

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

function medianLines(results) {
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
    'a single sample of that task is not trustworthy.',
    '',
    '| condition | task | pass | turns | output | cost (USD) | wall (s) | api (s) | spread |',
    '|---|---|---|---|---|---|---|---|---|',
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
    lines.push(
      `| ${condition} | ${task} | ${passed}/${graded.length}` +
        `${infra ? ` (+${infra} infra)` : ''}${invalid ? ` (+${invalid} invalid)` : ''} | ` +
        `${spanOf(valid.map((r) => r.turns))} | ${spanOf(outs)} | ` +
        `${spanOf(valid.map((r) => r.cost_usd), 4)} | ${spanOf(valid.map((r) => r.wall_s), 1)} | ` +
        `${spanOf(valid.map((r) => r.api_s), 1)} | ${spread} |`
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
      '| condition | version | dist sha256 | walker sha256 | tools | schema chars | tools/list hash | root |',
      '|---|---|---|---|---|---|---|---|'
    );
    for (const b of builds) {
      const twin = builds.find((o) => o !== b && o.sha256 && o.sha256 === b.sha256 && o.walkerSha256 === b.walkerSha256);
      lines.push(
        `| ${buildName(b)}${twin ? ` (same build as ${buildName(twin)})` : ''} | ${na(b.version)} | ` +
          `${short(b.sha256)} | ${short(b.walkerSha256)} | ${na(b.tools?.count)} | ${na(b.tools?.schemaChars)} | ` +
          `${short(b.tools?.hash)} | ${na(b.root)} |`
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
    lines.push('', '| condition | source | version | commit | command |', '|---|---|---|---|---|');
    for (const [c, s] of surfaces) {
      lines.push(
        `| ${c} | ${na(s.source)} | ${na(s.version)} | ` +
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
    `Invalid rows: ${invalid.length} row(s) never called their own browser server, so they are left out ` +
      'of every column above (their spend below). A pass there came through another route and says nothing about the surface:',
  ];
  for (const r of invalid) {
    const foreign = r.foreign_tools ? `; ${countOf(r.foreign_tools)} call(s) to other MCP servers` : '';
    lines.push(`  - ${r.condition}/${r.rep ? `${r.task} (r${r.rep})` : r.task}: ${r.invalid}, ${r.success ? 'passed' : 'failed'}${foreign}`);
  }
  for (const [condition, t] of Object.entries(totals).filter(([, t]) => t.invalid)) {
    lines.push(`  - ${condition} spend on invalid rows: ${t.invalid_output_tokens} output tokens, $${t.invalid_cost_usd.toFixed(4)}`);
  }
  return lines;
}

function sumRowTools(rows) {
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
  const sum = (group, key) =>
    rows.some((r) => r[group]?.[key] != null) ? rows.reduce((n, r) => n + (r[group]?.[key] ?? 0), 0) : null;
  return {
    rows: rows.length,
    tools,
    snapshot: { calls: sum('snapshot', 'calls'), chars: sum('snapshot', 'chars'), truncated: sum('snapshot', 'truncated') },
    friction: Object.fromEntries(
      ['act_then_snap', 'actions', 'eval_calls', 'stale_uid', 'restarts', 'sleeps'].map((k) => [k, sum('friction', k)])
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
      ? sumRowTools(rows.filter((r) => r.tools))
      : sumToolStats(derived.filter((d) => d.row.condition === condition).map((d) => d.stats));
    const names = Object.entries(t.tools).sort((a, b) => b[1].calls - a[1].calls);
    if (!names.length) continue;
    lines.push('', `**${condition}** (${t.rows} rows)`, '', '| tool | calls | rows | errors | chars/call | p50 ms |', '|---|---|---|---|---|---|');
    for (const [name, s] of names.slice(0, 15)) {
      lines.push(`| ${name} | ${s.calls} | ${s.rows} | ${s.errors} | ${Math.round(s.chars / (s.calls || 1))} | ${na(s.p50_ms)} |`);
    }
    if (names.length > 15) lines.push(`| ${names.length - 15} more | ${names.slice(15).reduce((n, [, s]) => n + s.calls, 0)} | | | | |`);
    const sn = t.snapshot ?? {};
    const fr = t.friction ?? {};
    const bits = [
      sn.calls != null && `snapshots ${sn.calls} (${na(sn.chars)} chars, ${na(sn.truncated)} with a cut)`,
      fr.eval_calls != null && `script calls ${fr.eval_calls}`,
      fr.act_then_snap != null && `action then snapshot ${fr.act_then_snap}${fr.actions ? `/${fr.actions}` : ''}`,
      fr.stale_uid != null && `stale uid ${fr.stale_uid}`,
      fr.restarts != null && `restarts ${fr.restarts}`,
      fr.sleeps != null && `waits ${fr.sleeps}`,
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
  const lines = ['', '## Server ledger', '', '| condition | rows | requests | documents | scripted | by status |', '|---|---|---|---|---|---|'];
  for (const condition of [...new Set(rows.map((r) => r.condition))]) {
    const rs = rows.filter((r) => r.condition === condition);
    const sum = (k) => rs.reduce((n, r) => n + (r.ledger[k] ?? 0), 0);
    const status = {};
    for (const r of rs) for (const [s, n] of Object.entries(r.ledger.byStatus ?? {})) status[s] = (status[s] ?? 0) + n;
    lines.push(
      `| ${condition} | ${rs.length} | ${sum('requests')} | ${sum('documents')} | ${sum('scripted')} | ` +
        `${Object.entries(status).map(([s, n]) => `${s}: ${n}`).join(', ')} |`
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
const ENV_COMPARED = [
  ...ENV_COLUMNS,
  ['navigator.languages', (e) => (e.languages ?? []).join(',')],
  ['device pixel ratio', (e) => e.devicePixelRatio],
  ['user agent', (e) => String(e.userAgent ?? '').replace(/\d+(\.\d+)*/g, 'N')],
];
// The pins a measured value is held to, by column label.
const PINNED = { locale: 'locale', 'time zone': 'timeZone', viewport: 'viewport', 'colour scheme': 'colorScheme' };

// Every way the conditions' browsers differed from each other or from their
// pins. A run's numbers compare surfaces only as far as these allow.
export function envMismatches(meta) {
  const measured = Object.entries(meta.env ?? {}).filter(([, e]) => !e.unmeasured);
  const out = Object.entries(meta.env ?? {})
    .filter(([, e]) => e.unmeasured)
    .map(([c, e]) => `${c} unmeasured (${e.unmeasured})`);
  for (const [label, read] of ENV_COMPARED) {
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
      for (const [label, read] of ENV_COMPARED) {
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

function envLines(meta) {
  if (!meta.env) return [];
  const pins = meta.envPins ?? {};
  const lines = [
    '',
    '## Condition environment',
    '',
    `What each condition's browser reported in the preflight. Pinned for every ` +
      `condition: locale ${pins.locale}, time zone ${pins.timeZone}, viewport ` +
      `${pins.viewport}, colour scheme ${pins.colorScheme}.`,
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
  const mismatches = envMismatches(meta);
  lines.push('');
  if (mismatches.length) {
    lines.push('ENVIRONMENT MISMATCH, so a difference between these conditions may come from these rather than the surface:');
    for (const m of mismatches) lines.push(`  - ${m}`);
  } else {
    lines.push('The conditions ran in the same browser environment.');
  }
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

// `runDir`, when given, lets the report read the run's transcripts for what
// older rows do not carry: per-tool telemetry and the evidence triage needs.
export function markdownReport({ meta, results, totals, runDir = null }) {
  const models = Object.entries(meta.models ?? {})
    .map(([b, m]) => `${b}: ${m}`)
    .join(', ');
  const mismatches = envMismatches(meta);
  const flags = runFlags(meta, results);
  const arms = new Set(results.map((r) => r.condition)).size;
  // Triaged here even when a row carries its own class: only the whole run
  // shows whether every other arm failed the same task alike.
  const triages = triageRun(results, { runDir });
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
    // Unseeded, each arm draws its own difficulty variants (seat-picker's plan,
    // pr-review's defect), so a paired difference carries draw noise too.
    ...(!meta.seed && arms > 1
      ? [
          `- UNSEEDED multi-arm run: each of the ${arms} arms drew its own difficulty variants, so a ratio ` +
            'between them includes draw-to-draw differences. Seed paired runs (--seed).',
        ]
      : []),
    ...flags
      .filter((f) => ['contaminated', 'pre-isolation', 'pricing_v1', 'foreign-calls', 'eval-dirty'].includes(f.flag))
      .map((f) => `- ${f.flag.toUpperCase()}: ${f.why}`),
    // Serving is a measurement epoch: single-origin URLs name the pages/
    // directory, which can describe the test (/flaky/slow.html, /maze/).
    `- serving: ${SERVING_NOTE[meta.serving ?? 'single-origin']}.` +
      (meta.serving ? '' : ' Not recorded: the run predates per-origin serving.') +
      ' Runs served differently are separate measurement epochs; do not compare them.',
    ...(mismatches.length
      ? [`- ENVIRONMENT MISMATCH between conditions (${mismatches.length}): see "Condition environment"`]
      : []),
    ...(meta.rerunEnvDrift?.length
      ? [
          `- ENVIRONMENT DIFFERS from the run this tops up (${meta.rerunEnvDrift.length}): ` +
            'see "Condition environment"',
        ]
      : []),
    `- compare on OUTPUT TOKENS. Turns compare only between runs whose backend ` +
      `counts a turn the same way (codex only approximates one), and a surface ` +
      `that packs several browser operations into one call does more per turn.`,
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
            `spread over its estimated requests, against genai-prices' bundled table, ` +
            `so the two are not measured the same way`,
        ]
      : []),
    ...envLines(meta),
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
    'clock.',
    '',
    '| condition | passed | infra | invalid | turns | input | cache write | cache read | output | cost (USD) | api (s) | wall (s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [condition, t] of Object.entries(totals)) {
    lines.push(
      `| ${condition} | ${t.passed}/${t.tasks} | ${t.infra} | ${t.invalid ?? 0} | ${na(t.turns)} | ${na(t.input_tokens)} | ` +
        `${na(t.cache_creation)} | ${na(t.cache_read)} | ${na(t.output_tokens)} | ${na(t.cost_usd)} | ${na(t.api_s)} | ${na(t.wall_s)} |`
    );
  }
  lines.push(...invalidLines(results, totals));
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
  const cutRows = results.filter((r) => r.surface?.truncated?.length);
  if (cutRows.length) {
    const lost = cutRows.filter((r) => !r.success);
    lines.push(
      '',
      `Surface truncation: ${cutRows.length} row(s) had a graded value cut before it ` +
        `reached the agent, ${lost.length} of which failed. Those failures are the ` +
        `tool surface, not the agent; see the per-task notes.`
    );
    for (const r of lost) {
      lines.push(`  - ${r.condition}/${r.rep ? `${r.task} (r${r.rep})` : r.task}: ${JSON.stringify(r.surface.truncated)}`);
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
  // stops and errors still hit the API. An anthropic attempt the harness killed
  // is priced from the tokens it had streamed. A backend that reports usage only
  // when a run completes (codex) cannot price one at all, so those are counted
  // rather than guessed at.
  const discarding = Object.entries(totals).filter(([, t]) => t.discarded_attempts);
  if (discarding.length) {
    lines.push('', 'Discarded attempts (not in the columns above):');
    for (const [condition, t] of discarding) {
      lines.push(
        `  - ${condition}: ${t.discarded_attempts} attempt(s), ${t.discarded_output_tokens} ` +
          `output tokens, $${t.discarded_cost_usd.toFixed(4)}` +
          (t.discarded_unknown
            ? `; ${t.discarded_unknown} of them unpriced, because the backend never reported their spend`
            : '')
      );
    }
  }
  lines.push(...drawLines(results));
  const partial = !runDir && results.some((r) => !r.success && r.surface_calls == null && r.tools == null);
  lines.push(...triageLines(results, triages, { partial }));
  lines.push(...toolLines(results, runDir));
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
    const cut = r.surface?.truncated?.length
      ? `SURFACE TRUNCATED ${JSON.stringify(r.surface.truncated)} — `
      : '';
    const saved = r.downloads?.length
      ? ` — downloaded ${r.downloads
          .map((d) => `${d.name} (${d.error ? `unreadable: ${d.error}` : `${d.bytes} B`})`)
          .join(', ')}`
      : '';
    const cls = r.success ? null : classOf(triages[i]);
    const lead = (r.invalid ? `INVALID (${r.invalid}) — ` : '') + (cls ? `[${cls}] ` : '');
    const note =
      lead +
      (r.extraction_failed
        ? `${cut}EXTRACTION FAILED (${r.extraction_failed}) — ${noteBase}`
        : cut + noteBase) +
      saved;
    lines.push(
      `| ${r.condition} | ${task} | ${r.success ? 'PASS' : 'FAIL'} | ${r.turns ?? ''} | ` +
        `${r.input_tokens ?? ''} | ${r.cache_creation ?? ''} | ` +
        `${r.cache_read ?? ''} | ${r.output_tokens ?? ''} | ${r.cost_usd?.toFixed?.(4) ?? ''} | ` +
        `${r.api_s ?? ''} | ${r.wall_s ?? ''} | ${cell(note)} |`
    );
  }
  if (meta.repeat) {
    lines.push(...medianLines(results));
  }
  lines.push('', '## Answers (truncated)', '');
  for (const r of results) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    lines.push(`- **${r.condition}/${task}**: ${r.answer ?? '(error)'}`);
  }
  return lines.join('\n') + '\n';
}
