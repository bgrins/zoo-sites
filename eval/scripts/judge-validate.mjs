// The transcript judge's validation: its diagnoses against a frozen reference
// set, labels taken from the Claude-agent trace reviews of four stored runs
// (the codex and Haiku sweeps of 2026-09-20 and the two acceptance runs of the
// same day), whose judges read each run's files and the repository as the
// judge now does.
//
//   node eval/scripts/judge-validate.mjs --build <sweep-judging-dir>
//       rebuild eval/scripts/judge-reference.json from the reviews
//   node eval/scripts/judge-validate.mjs --paid [--set validation|dev|pairs|heldout|aa] [--out-dir <dir>]
//        [--results <results-root>] [--budget <usd>] [--jobs <n>] [--effort <e>]
//       judge the set's rows (paid), then score them
//   node eval/scripts/judge-validate.mjs --score <out-dir> [--set s]
//       score stored diagnoses, free
//   node eval/scripts/judge-validate.mjs --regate <from-dir> --out-dir <dir> [--set s]
//       gate the stored raw outputs again with today's judge.mjs, then score them, free
//
// The reviews' free-text causes are mapped onto judge.mjs CAUSES here, once,
// by hand (ACCEPT_CAUSES, OVERRIDES); the reference file is what the scoring
// reads, so a change to the mapping is a change to that file under review. A
// row's `alt` holds the other causes a reviewer's text supports, and the
// scoring counts a match on any of them as agreement, beside the strict
// figure. The reviews name one tool cause, tool-defect, for what the judge
// splits three ways, so causes are compared by family (tool-*, validator-*).
// The dev set was for iterating on the prompt, and the validation set was meant
// to be scored only on a frozen one, but its disagreements shaped the prompt
// too, so its figures are in-sample; the heldout set, drawn after the prompt
// was final, is not. The pairs set scores pair mode arm by arm. The aa set
// pairs two repeats of one condition as two builds of it, an A/A control made
// from stored rows: every surface driver or supported surface difference the
// judge names there is a false attribution.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSES } from './judge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE = join(here, 'judge-reference.json');

export const RUNS = {
  codex: 'run-2026-09-20T17-48-17-298Z',
  haiku: 'run-2026-09-20T18-32-34-183Z',
  acceptCodex: 'run-2026-09-20T22-45-29-568Z',
  acceptHaiku: 'run-2026-09-20T22-52-41-101Z',
};

// The sweeps' reviews already use cause slugs; `validator` is either
// validator cause, by the row's grade.
const sweepCause = (cause, pass) =>
  cause === 'validator' ? (pass ? 'validator-false-pass' : 'validator-false-fail') : cause;

// The acceptance reviews wrote a cause as prose, one row per entry in file
// order. Each is mapped to a primary cause and the alternates the prose also
// supports ("tool-missing-info/agent-capability"). A pass whose waste was a
// few calls is none. Following the sweep reviews, a tool that rejects a ref in
// the form its own snapshot printed is tool-defect.
const ACCEPT_CAUSES = [
  // resend-receipt: codex fdm r1-r3, pw r1-r3, haiku fdm r1-r3, pw r1-r3
  'agent-capability', 'none', 'none', 'none', 'none', 'none/agent-capability',
  'tool-missing-info/agent-capability', 'tool-missing-info/agent-capability', 'tool-missing-info/agent-capability',
  'agent-capability/tool-defect', 'agent-capability/none', 'agent-capability/tool-defect',
  // unsaved-leave
  'none', 'none', 'none', 'none/tool-missing-info/agent-capability', 'none/agent-shortcut', 'none',
  'tool-missing-info/none', 'none', 'none', 'agent-capability', 'agent-capability/tool-defect', 'agent-capability',
  // reused-row
  'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none/agent-capability', 'none', 'none',
  // hovercard-oncall
  'agent-shortcut/none', 'agent-shortcut/none', 'none', 'agent-shortcut/none/tool-defect', 'none/agent-shortcut', 'none',
  'fixture/agent-shortcut', 'fixture/agent-shortcut', 'fixture/none', 'agent-capability/tool-missing-info', 'fixture/none',
  'agent-capability',
  // native-permit
  'tool-silent-noop', 'tool-silent-noop', 'tool-silent-noop', 'none/agent-capability/tool-defect', 'agent-capability/none',
  'none/tool-defect', 'tool-silent-noop', 'tool-missing-info/tool-silent-noop', 'agent-capability',
  'tool-defect/agent-capability', 'agent-capability', 'agent-capability/none',
  // pointer-drag
  'tool-silent-noop', 'none/agent-shortcut', 'tool-silent-noop/agent-capability', 'agent-capability/none', 'none', 'none',
  'tool-silent-noop', 'tool-silent-noop', 'tool-silent-noop', 'tool-defect/agent-capability', 'agent-capability/tool-defect',
  'tool-defect/agent-capability',
  // range-select
  'none', 'agent-shortcut/none', 'none/agent-shortcut', 'none', 'none', 'none', 'tool-missing-info/none', 'agent-shortcut/none',
  'agent-capability/none', 'agent-capability', 'none', 'agent-capability',
  // pdf-bill
  'none', 'none', 'agent-capability/none', 'none', 'none', 'none', 'agent-capability/tool-missing-info',
  'none/agent-capability', 'agent-capability/agent-shortcut', 'none/agent-capability', 'agent-capability/none', 'none',
];

// Where the sweep reviews labelled one row twice, the later, cross-cutting
// entry often named a report defect rather than the row's cause; these rows
// take the family review's cause, the other as an alternate, and the
// legitimacy and grade verdicts the reviews' syntheses settled on. null leaves
// a verdict unscored.
const OVERRIDES = {
  // The codex synthesis: "a false fail: firefox-devtools-mcp/phish-pick, caused by the extractor and validator".
  [`${RUNS.codex}|firefox-devtools-mcp|phish-pick|1`]: { cause: 'extractor', alt: ['validator-false-fail'] },
  [`${RUNS.codex}|firefox-devtools-mcp|search-decoy|1`]: { cause: 'tool-defect', alt: ['harness'] },
  [`${RUNS.codex}|playwright-mcp|locale-notice|1`]: { cause: 'fixture', alt: ['agent-capability'], legitimate: null, grade_correct: null },
  [`${RUNS.codex}|playwright-mcp|pdf-bill|1`]: { cause: 'harness', alt: ['none'], legitimate: false },
  [`${RUNS.haiku}|firefox-devtools-mcp|ledger-sum|1`]: { cause: 'agent-shortcut', legitimate: false, grade_correct: false },
  [`${RUNS.haiku}|firefox-devtools-mcp|hovercard-oncall|1`]: { cause: 'agent-shortcut', legitimate: false, grade_correct: false },
  [`${RUNS.haiku}|firefox-devtools-mcp|body-only-ref|1`]: { cause: 'agent-shortcut', alt: ['validator-false-pass'], legitimate: false, grade_correct: false },
  [`${RUNS.haiku}|firefox-devtools-mcp|search-decoy|1`]: { cause: 'agent-capability', alt: ['harness'] },
  [`${RUNS.haiku}|firefox-devtools-mcp|embargo-wait|1`]: { cause: 'tool-defect', alt: ['harness'] },
};

// The rows each set judges, as <run key>|<condition>|<task>|<rep>.
const f = 'firefox-devtools-mcp';
const p = 'playwright-mcp';
const ids = (run, list) => list.map(([c, t, r = 1]) => `${RUNS[run]}|${c}|${t}|${r}`);
const pairIds = (run, list) => list.map(([t, r = 1]) => `${RUNS[run]}|pair|${t}|${r}`);
export const SETS = {
  dev: [
    ...ids('codex', [[f, 'price-compare'], [f, 'unsub-dark-patterns'], [f, 'rename-rollback']]),
    ...ids('haiku', [[p, 'variant-matrix'], [f, 'template-count'], [f, 'office-finder'], [f, 'qty-limit']]),
    ...ids('acceptCodex', [[f, 'resend-receipt', 1], [f, 'unsaved-leave', 1]]),
    ...ids('acceptHaiku', [[f, 'native-permit', 1], [p, 'pointer-drag', 1]]),
  ],
  validation: [
    ...ids('codex', [
      [p, 'mfa-login'], [f, 'phish-pick'], [f, 'mid-flight-rate'], [p, 'locale-notice'], [p, 'popup-storm'],
      [f, 'variant-matrix'], [p, 'template-count'], [f, 'range-select'], [f, 'password-reset'], [f, 'silent-throw'],
      [p, 'dept-descent'], [f, 'search-decoy'], [f, 'native-permit'], [p, 'order-modifiers'], [f, 'scene-calibrate'],
      [p, 'pdf-bill'], [p, 'roster'], [f, 'mfa-login'], [p, 'session-expiry'], [f, 'portal-login'],
    ]),
    ...ids('haiku', [
      [f, 'mfa-login'], [f, 'price-compare'], [p, 'feed-needle'], [f, 'news-extract'], [f, 'modal-escape'],
      [f, 'popup-storm'], [p, 'brochure-minimal'], [p, 'formula-repair'], [p, 'search-decoy'], [p, 'maze-escape'],
      [f, 'body-only-ref'], [f, 'hovercard-oncall'], [f, 'ledger-sum'], [f, 'pointer-drag'], [p, 'logout-hygiene'],
      [f, 'title'], [f, 'roster-diff'], [f, 'token-rotate'], [p, 'locale-notice'], [p, 'pdf-bill'], [f, 'session-expiry'],
      [p, 'checkout-stop'],
    ]),
    ...ids('acceptCodex', [[f, 'native-permit', 1], [f, 'pointer-drag', 1], [f, 'reused-row', 1], [p, 'pdf-bill', 1]]),
    ...ids('acceptHaiku', [
      [p, 'hovercard-oncall', 1], [p, 'hovercard-oncall', 3], [p, 'range-select', 1], [p, 'range-select', 3],
      [f, 'resend-receipt', 1], [f, 'hovercard-oncall', 1], [f, 'pointer-drag', 1], [p, 'unsaved-leave', 1],
    ]),
  ],
  // Pair mode, scored arm by arm against both arms' row labels.
  pairs: [
    ...pairIds('codex', [['mfa-login'], ['phish-pick'], ['mid-flight-rate'], ['pdf-bill']]),
    ...pairIds('haiku', [['body-only-ref'], ['popup-storm'], ['search-decoy']]),
    ...pairIds('acceptHaiku', [['hovercard-oncall', 1], ['range-select', 1]]),
  ],
  // Reviewed sweep rows in no other set, drawn with ab.mjs rng('judge-heldout')
  // within strata once the prompt was final: 4 failures (the sweeps' only
  // other failures are Haiku's), and per sweep 2 passes the reviews called
  // tool-defect, 1 agent-capability and 1 none.
  heldout: [
    ...ids('haiku', [[p, 'template-count'], [p, 'range-select'], [p, 'pr-review'], [f, 'locale-notice']]),
    ...ids('codex', [[f, 'biglist-needle'], [f, 'news-extract']]),
    ...ids('haiku', [[f, 'handbook'], [f, 'kanban-triage']]),
    ...ids('codex', [[p, 'hovercard-oncall'], [f, 'dead-images']]),
    ...ids('haiku', [[p, 'room-booking'], [p, 'faceted-search']]),
  ],
};

// The A/A control: [run key, condition, task, repeat, repeat]. Each is a
// task's first repeat pair, in 1-2, 1-3, 2-3 order, that pair mode would
// select (a failure or a 1.5x output gap), for every devtools task in the
// acceptance runs that has one and for playwright's two with a pass and a fail.
export const AA_PAIRS = [
  ['acceptCodex', f, 'resend-receipt', 1, 2],
  ['acceptCodex', f, 'pdf-bill', 1, 3],
  ['acceptCodex', f, 'pointer-drag', 1, 3],
  ['acceptHaiku', f, 'pdf-bill', 1, 3],
  ['acceptHaiku', p, 'hovercard-oncall', 1, 2],
  ['acceptHaiku', p, 'range-select', 1, 2],
];

// One run directory per source run and condition, whose rows are the pairs'
// repeats relabelled as builds <condition>@a and @b of rep 1, with the source
// run's transcripts, tap logs, states and rollouts linked in. Returns
// [{ name, dir, arms, only }].
export function aaRuns(root, outDir) {
  const groups = new Map();
  for (const [key, condition, task, i, j] of AA_PAIRS) {
    const name = `aa-${RUNS[key]}-${condition}`;
    if (!groups.has(name)) groups.set(name, { name, run: RUNS[key], condition, pairs: [] });
    groups.get(name).pairs.push([task, i, j]);
  }
  const made = [];
  for (const { name, run, condition, pairs } of groups.values()) {
    const src = join(root, run);
    const dir = join(outDir, 'runs', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const sub of ['transcripts', 'tool-calls', 'states', 'rollouts']) if (existsSync(join(src, sub))) symlinkSync(join(src, sub), join(dir, sub));
    const doc = JSON.parse(readFileSync(join(src, 'results.json'), 'utf8'));
    const arms = ['a', 'b'].map((l) => `${condition}@${l}`);
    const results = [];
    for (const [task, i, j] of pairs) {
      for (const [rep, arm] of [[i, arms[0]], [j, arms[1]]]) {
        const row = doc.results.find((r) => r.condition === condition && r.task === task && (r.rep ?? 1) === rep);
        if (!row) throw new Error(`${run} has no ${condition} ${task} rep ${rep}`);
        results.push({ ...row, condition: arm, rep: 1 });
      }
    }
    const meta = structuredClone(doc.meta);
    meta.conditions = arms.join(',');
    const perArm = (o) => (o && condition in o ? Object.fromEntries(arms.map((a) => [a, o[condition]])) : o);
    meta.surfaces = perArm(meta.surfaces);
    meta.env = perArm(meta.env);
    if (meta.isolation?.browserTag) {
      meta.isolation.browserTag.mechanism = perArm(meta.isolation.browserTag.mechanism);
      meta.isolation.browserTag.verified = perArm(meta.isolation.browserTag.verified);
    }
    const build = (meta.builds ?? []).find((b) => b.condition === condition);
    meta.builds = build ? arms.map((a) => ({ ...build, label: a.split('@')[1], condition: a })) : [];
    writeFileSync(join(dir, 'results.json'), `${JSON.stringify({ meta, results }, null, 1)}\n`);
    made.push({ name, dir, arms, only: pairs.map(([task]) => `pair|${task}|1`) });
  }
  return made;
}

// Both arms' row ids of a pair id.
const pairRows = (id) => {
  const [run, , task, rep] = id.split('|');
  return [f, p].map((c) => `${run}|${c}|${task}|${rep}`);
};

export const family = (c) => (c == null ? null : c.startsWith('tool-') ? 'tool' : c.startsWith('validator-') ? 'validator' : c);

function build(dir) {
  const rows = new Map();
  const put = (id, entry) => rows.set(id, { id, ...entry, ...(OVERRIDES[id] ?? {}) });
  for (const [key, file] of [['codex', 'codex-judges.json'], ['haiku', 'haiku-judges.json']]) {
    const groups = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    groups.forEach((g, gi) =>
      g.rows.forEach((r) => {
        if (!['firefox-devtools-mcp', 'playwright-mcp'].includes(r.condition)) return;
        const pass = /^PASS/.test(r.outcome);
        const id = `${RUNS[key]}|${r.condition}|${r.task}|1`;
        const cause = sweepCause(r.cause, pass);
        const prior = rows.get(id);
        // The first review of a row is its family's; a later one adds an
        // alternate.
        if (prior) {
          if (family(cause) !== family(prior.cause) && !prior.alt.includes(cause)) prior.alt.push(cause);
          return;
        }
        const wrong = cause === 'extractor' || cause.startsWith('validator-');
        put(id, {
          run: RUNS[key],
          condition: r.condition,
          task: r.task,
          rep: 1,
          graded: pass ? 'PASS' : 'FAIL',
          cause,
          alt: [],
          legitimate: r.legitimate,
          grade_correct: !wrong,
          source: `${file} group ${gi}`,
        });
      })
    );
  }
  const accept = JSON.parse(readFileSync(join(dir, 'accept-judges.json'), 'utf8'));
  let i = 0;
  for (const g of accept) {
    for (const r of g.rows) {
      const [cause, ...alt] = ACCEPT_CAUSES[i].split('/');
      const run = r.backend.startsWith('codex') ? RUNS.acceptCodex : RUNS.acceptHaiku;
      const rep = Number(/r(\d+)/.exec(r.attempt)?.[1] ?? 1);
      put(`${run}|${r.condition}|${g.task}|${rep}`, {
        run,
        condition: r.condition,
        task: g.task,
        rep,
        graded: /^PASS/.test(r.outcome) ? 'PASS' : 'FAIL',
        cause,
        alt,
        legitimate: r.legitimate,
        grade_correct: true,
        source: `accept-judges.json row ${i}`,
      });
      i++;
    }
  }
  if (i !== ACCEPT_CAUSES.length) throw new Error(`accept-judges.json has ${i} rows, ACCEPT_CAUSES maps ${ACCEPT_CAUSES.length}`);
  for (const r of rows.values()) {
    for (const c of [r.cause, ...r.alt]) if (!CAUSES.includes(c)) throw new Error(`${r.id}: ${c} is not a judge cause`);
  }
  const wanted = [...new Set([...SETS.dev, ...SETS.validation, ...SETS.heldout, ...SETS.pairs.flatMap(pairRows)])];
  const missing = wanted.filter((id) => !rows.has(id));
  if (missing.length) throw new Error(`no reference for ${missing.join(', ')}`);
  const pairArms = SETS.pairs.flatMap(pairRows);
  const overlap = [
    ...SETS.dev.filter((id) => SETS.validation.includes(id)),
    ...SETS.heldout.filter((id) => [...SETS.dev, ...SETS.validation, ...pairArms].includes(id)),
  ];
  if (overlap.length) throw new Error(`in two sets: ${overlap.join(', ')}`);
  const doc = {
    about: 'Reference labels for eval/scripts/judge-validate.mjs, built by --build from the 2026-09-20 trace reviews.',
    runs: RUNS,
    sets: SETS,
    rows: wanted.map((id) => rows.get(id)).sort((a, b) => a.id.localeCompare(b.id)),
  };
  // One row per line, so a change to a label reads as a one-line diff.
  const body = [
    '{',
    `"about": ${JSON.stringify(doc.about)},`,
    `"runs": ${JSON.stringify(doc.runs)},`,
    `"sets": ${JSON.stringify(doc.sets, null, 1)},`,
    '"rows": [',
    doc.rows.map((r) => JSON.stringify(r)).join(',\n'),
    ']',
    '}',
  ].join('\n');
  writeFileSync(REFERENCE, `${body}\n`);
  console.log(
    `wrote ${REFERENCE}: ${doc.rows.length} of ${rows.size} reviewed rows, dev ${SETS.dev.length}, validation ${SETS.validation.length}, heldout ${SETS.heldout.length}`
  );
}

// Cohen's kappa of two label lists.
export function kappa(a, b) {
  const n = a.length;
  if (!n) return null;
  const labels = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = labels.reduce((s, l) => s + (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

// What the reference labels, this file's mapping and a scored agreement file
// look like in a judge's rollout, where JSON escapes its quotes; a mention of
// the files by name, as the README makes, is not one.
const LABEL_FILES =
  /\\*"source\\*":\\*"(?:codex|haiku|accept)-judges\.json|\$\{RUNS\.\w+\}\||ids\('(?:codex|haiku|accept\w*)'|ACCEPT_CAUSES = \[|\\*"review\\*": ?\{(?:\\n|\s)*\\*"cause\\*"/;

// A proportion's Wilson 95% interval, as [low, high].
export function wilson(k, n) {
  if (!n) return null;
  const z = 1.96;
  const p = k / n;
  const mid = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
const pct = (k, n) => {
  if (!n) return 'n/a';
  const [lo, hi] = wilson(k, n);
  return `${Math.round(k)}/${n} (${Math.round((100 * k) / n)}%, 95% CI ${Math.round(100 * lo)}-${Math.round(100 * hi)}%)`;
};

export function score(outDir, setName) {
  const ref = JSON.parse(readFileSync(REFERENCE, 'utf8'));
  const byId = new Map(ref.rows.map((r) => [r.id, r]));
  const want = new Set(ref.sets[setName]);
  const judged = [];
  const contaminated = [];
  let cost = 0;
  let calls = 0;
  // An item whose judge read the reference labels (a copy of the repository
  // made before judge.mjs left them out held them) is not scored.
  const sawLabels = (item) => {
    const rollout = item.rollout ?? item.rollout_from;
    const file = rollout && join(outDir, rollout);
    return !!file && existsSync(file) && LABEL_FILES.test(readFileSync(file, 'utf8'));
  };
  for (const file of readdirSync(outDir).filter((x) => /^run-.*\.json$/.test(x))) {
    const doc = JSON.parse(readFileSync(join(outDir, file), 'utf8'));
    for (const item of doc.items ?? []) {
      const id = `${doc.run}|${item.id}`;
      if (!want.has(id)) continue;
      if (!item.reused) {
        cost += item.cost_usd ?? 0;
        calls++;
      }
      if (!item.diagnosis) continue;
      if (sawLabels(item)) {
        contaminated.push(id);
        continue;
      }
      if (item.kind === 'row') judged.push({ ref: byId.get(id), item, d: item.diagnosis });
      // A pair's arms are named by condition, since a pair of two tools is not blinded.
      if (item.kind === 'pair') {
        const seen = new Set();
        for (const a of item.diagnosis.arms ?? []) {
          const ref = byId.get(`${doc.run}|${a.arm}|${item.task}|${item.rep}`);
          if (ref && !seen.has(a.arm)) judged.push({ ref, item: { ...item, triage: item.triage?.[a.arm] ?? null }, d: a });
          seen.add(a.arm);
        }
      }
    }
  }
  const lines = [`judge validation, ${setName} set: ${judged.length} verdicts on ${want.size} ${setName === 'pairs' ? 'pairs' : 'rows'}`];
  const strict = judged.filter(({ ref, d }) => family(d.primary_cause) === family(ref.cause));
  const loose = judged.filter(({ ref, d }) => [ref.cause, ...ref.alt].map(family).includes(family(d.primary_cause)));
  const k = kappa(judged.map(({ ref }) => family(ref.cause)), judged.map(({ d }) => family(d.primary_cause)));
  // The exact cause, where the review names one: the sweep reviews' one tool
  // cause is only a family.
  const fine = judged.filter(({ ref }) => !['tool-defect'].includes(ref.cause) || ref.source.startsWith('accept'));
  const fineStrict = fine.filter(({ ref, d }) => d.primary_cause === ref.cause);
  const fineHit = fine.filter(({ ref, d }) => [ref.cause, ...ref.alt].includes(d.primary_cause));
  // Baselines a judge must beat: every outcome earned, and a cause read off
  // the grade alone (a pass none, a fail agent-capability).
  const naive = ({ ref }) => (ref.graded === 'PASS' ? 'none' : 'agent-capability');
  const naiveHit = judged.filter((x) => family(naive(x)) === family(x.ref.cause));
  const naiveKappa = kappa(judged.map(({ ref }) => family(ref.cause)), judged.map((x) => family(naive(x))));
  const judgeTool = judged.filter(({ d }) => family(d.primary_cause) === 'tool');
  const refTool = judged.filter(({ ref }) => family(ref.cause) === 'tool');
  const legit = judged.filter(({ ref }) => ref.legitimate != null);
  const legitAllTrue = legit.filter(({ ref }) => ref.legitimate === true).length;
  const grade = judged.filter(({ ref }) => ref.grade_correct != null);
  const wrongGrades = grade.filter(({ ref }) => ref.grade_correct === false);
  const rightGrades = grade.filter(({ ref }) => ref.grade_correct === true);
  const gate = judged.reduce((s, { item }) => ({ kept: s.kept + (item.gate?.kept ?? 0), checked: s.checked + (item.gate?.checked ?? 0) }), { kept: 0, checked: 0 });
  const summary = {
    set: setName,
    judged: judged.length,
    cause_family_strict: strict.length / (judged.length || 1),
    cause_family_with_alternates: loose.length / (judged.length || 1),
    kappa_family: k,
    cause_fine_strict: fineStrict.length / (fine.length || 1),
    cause_fine_with_alternates: fineHit.length / (fine.length || 1),
    cause_family_strict_ci: wilson(strict.length, judged.length),
    baseline_cause_family: naiveHit.length / (judged.length || 1),
    baseline_kappa_family: naiveKappa,
    baseline_legitimacy_all_true: legitAllTrue / (legit.length || 1),
    tool_precision: judgeTool.filter(({ ref }) => [ref.cause, ...ref.alt].map(family).includes('tool')).length / (judgeTool.length || 1),
    tool_recall: refTool.filter(({ d }) => family(d.primary_cause) === 'tool').length / (refTool.length || 1),
    legitimacy: legit.filter(({ ref, d }) => d.legitimate === ref.legitimate).length / (legit.length || 1),
    wrong_grades_found: wrongGrades.filter(({ d }) => d.grade_correct === false).length,
    wrong_grades: wrongGrades.length,
    false_disputes: rightGrades.filter(({ d }) => d.grade_correct === false).length,
    right_grades: rightGrades.length,
    unsupported: judged.filter(({ d }) => d.unsupported).length,
    contaminated,
    quotes_kept: gate.kept,
    quotes_checked: gate.checked,
    calls,
    cost_usd: Number(cost.toFixed(4)),
  };
  lines.push(
    `primary cause, by family: ${pct(strict.length, judged.length)} strict, ${pct(loose.length, judged.length)} accepting a review's alternates; Cohen's kappa ${k?.toFixed(2) ?? 'n/a'}`,
    `primary cause, exact where the review names one: ${pct(fineStrict.length, fine.length)} strict, ${pct(fineHit.length, fine.length)} accepting alternates`,
    `baseline, a pass none and a fail agent-capability: ${pct(naiveHit.length, judged.length)} by family, kappa ${naiveKappa?.toFixed(2) ?? 'n/a'}`,
    `tool causes: precision ${pct(judgeTool.filter(({ ref }) => [ref.cause, ...ref.alt].map(family).includes('tool')).length, judgeTool.length)}, recall ${pct(refTool.filter(({ d }) => family(d.primary_cause) === 'tool').length, refTool.length)}`,
    `legitimate: ${pct(summary.legitimacy * legit.length, legit.length)}; baseline, every outcome earned: ${pct(legitAllTrue, legit.length)}`,
    `grades the reviews call wrong, found: ${pct(summary.wrong_grades_found, wrongGrades.length)}; right grades disputed: ${pct(summary.false_disputes, rightGrades.length)}`,
    `unsupported causes: ${summary.unsupported}; quotes kept by the gate: ${pct(gate.kept, gate.checked)}`,
    `spend: $${cost.toFixed(4)} over ${calls} calls`,
    contaminated.length ? `not scored, since the judge read the reference labels: ${contaminated.join(', ')}` : 'no judge read the reference labels',
    '',
    'disagreements (review cause [alternates] -> judge cause):'
  );
  for (const { ref, item, d } of judged) {
    const causeOk = [ref.cause, ...ref.alt].map(family).includes(family(d.primary_cause));
    const legitOk = ref.legitimate == null || d.legitimate === ref.legitimate;
    const gradeOk = ref.grade_correct == null || d.grade_correct === ref.grade_correct;
    if (causeOk && legitOk && gradeOk) continue;
    lines.push(
      `- ${ref.id} (${ref.graded}): ${ref.cause}${ref.alt.length ? ` [${ref.alt.join(', ')}]` : ''} -> ${d.primary_cause}${d.unsupported ? ' (unsupported)' : ''}` +
        `${legitOk ? '' : `; legitimate ${ref.legitimate} -> ${d.legitimate}`}${gradeOk ? '' : `; grade_correct ${ref.grade_correct} -> ${d.grade_correct}`}` +
        `; triage ${item.triage ?? 'none'}`
    );
  }
  const text = `${lines.join('\n')}\n`;
  writeFileSync(join(outDir, `agreement-${setName}.json`), `${JSON.stringify({ summary, rows: judged.map(({ ref, d }) => ({ id: ref.id, review: { cause: ref.cause, alt: ref.alt, legitimate: ref.legitimate, grade_correct: ref.grade_correct }, judge: { cause: d.primary_cause, legitimate: d.legitimate, grade_correct: d.grade_correct, unsupported: !!d.unsupported } })) }, null, 1)}\n`);
  return { summary, text };
}

// The A/A control's reading: both arms of every pair ran one build, so a
// surface driver or a supported surface difference names a difference no
// build made.
export function scoreAA(outDir) {
  const items = [];
  for (const file of readdirSync(outDir).filter((x) => /^aa-.*\.json$/.test(x))) {
    const doc = JSON.parse(readFileSync(join(outDir, file), 'utf8'));
    for (const item of doc.items ?? []) if (item.kind === 'pair' && item.diagnosis) items.push({ run: doc.run, item, d: item.diagnosis });
  }
  const n = items.length;
  const surface = items.filter(({ d }) => d.difference_driver === 'surface');
  const supportedSurface = surface.filter(({ d }) => !d.driver_unsupported);
  const withDiff = items.filter(({ d }) => (d.surface_differences ?? []).some((s) => !s.unsupported));
  const diffs = items.flatMap(({ d }) => d.surface_differences ?? []);
  const cost = items.reduce((s, { item }) => s + (item.reused ? 0 : item.cost_usd ?? 0), 0);
  const drivers = {};
  for (const { d } of items) drivers[d.difference_driver] = (drivers[d.difference_driver] ?? 0) + 1;
  const summary = {
    set: 'aa',
    pairs: n,
    drivers,
    surface_driver: surface.length,
    surface_driver_supported: supportedSurface.length,
    pairs_with_supported_surface_difference: withDiff.length,
    surface_differences: diffs.length,
    surface_differences_supported: diffs.filter((s) => !s.unsupported).length,
    better_arm_named: items.filter(({ d }) => d.better_arm != null).length,
    cost_usd: Number(cost.toFixed(4)),
  };
  const lines = [
    `judge A/A control: ${n} pairs, each two repeats of one condition shown as builds X and Y`,
    `difference_driver: ${Object.entries(drivers).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `surface driver (a false attribution): ${pct(surface.length, n)}; with a supported difference: ${pct(supportedSurface.length, n)}`,
    `pairs with a supported surface difference: ${pct(withDiff.length, n)}; differences named ${diffs.length}, supported ${summary.surface_differences_supported}`,
    `better arm named: ${summary.better_arm_named} of ${n}`,
    `spend: $${cost.toFixed(4)}`,
    '',
    ...items.map(({ run, item, d }) =>
      `- ${run} ${item.id} (${Object.entries(item.graded ?? {}).map(([a, g]) => `${a} ${g}`).join(', ')}): ${d.difference_driver}${d.driver_unsupported ? ' (unsupported)' : ''}; ` +
        `${(d.surface_differences ?? []).length} surface differences, ${(d.surface_differences ?? []).filter((s) => !s.unsupported).length} supported`
    ),
  ];
  writeFileSync(join(outDir, 'agreement-aa.json'), `${JSON.stringify({ summary, pairs: items.map(({ run, item, d }) => ({ run, id: item.id, graded: item.graded, driver: d.difference_driver, driver_unsupported: !!d.driver_unsupported, surface_differences: (d.surface_differences ?? []).map((s) => ({ what: s.what, unsupported: !!s.unsupported })) })) }, null, 1)}\n`);
  return { summary, text: `${lines.join('\n')}\n` };
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const setName = flag('set') ?? 'validation';
  const scoreSet = (dir) => (setName === 'aa' ? scoreAA(dir) : score(dir, setName));
  if (flag('build')) {
    build(resolve(flag('build')));
  } else if (flag('score')) {
    console.log(scoreSet(resolve(flag('score'))).text);
  } else if (args.includes('--paid') || flag('regate')) {
    const ref = JSON.parse(readFileSync(REFERENCE, 'utf8'));
    const { RESULTS_ROOT } = await import('../run-files.mjs');
    const root = resolve(flag('results') ?? RESULTS_ROOT);
    const regate = flag('regate') ? resolve(flag('regate')) : null;
    const outDir = resolve(flag('out-dir') ?? join(RESULTS_ROOT, `judge-validation-${setName}`));
    if (regate === outDir) throw new Error('--regate needs an --out-dir of its own');
    mkdirSync(outDir, { recursive: true });
    const budget = Number(flag('budget') ?? 10);
    let spent = 0;
    // One judge.mjs run per run directory: { name, runDir, only, pairs, extra }.
    let jobs;
    if (setName === 'aa') {
      jobs = aaRuns(root, outDir).map(({ name, dir, arms, only }) => ({ name, runDir: dir, only, pairs: true, extra: ['--ab', arms.join(','), '--seed', 'aa'] }));
    } else {
      const byRun = new Map();
      for (const id of ref.sets[setName]) {
        const [run, ...rest] = id.split('|');
        if (!byRun.has(run)) byRun.set(run, []);
        byRun.get(run).push(rest.join('|'));
      }
      jobs = [...byRun].map(([run, only]) => ({ name: run, runDir: join(root, run), only, pairs: setName === 'pairs', extra: [] }));
    }
    for (const { name, runDir, only, pairs, extra } of jobs) {
      const left = budget - spent;
      if (!regate && left <= 0) break;
      const out = join(outDir, `${name}.json`);
      const from = regate && join(regate, `${name}.json`);
      if (regate && !existsSync(from)) continue;
      const judgeArgs = [
        join(here, 'judge.mjs'), runDir, '--all', ...(pairs ? ['--mode', 'pairs'] : []), ...extra,
        '--only', only.join(','), '--out', out, '--deny', outDir, '--jobs', flag('jobs') ?? '2',
        ...(regate ? ['--canned', from] : ['--paid', '--resume', '--budget', String(left)]),
        ...(flag('effort') ? ['--effort', flag('effort')] : []),
      ];
      const r = spawnSync(process.execPath, judgeArgs, { stdio: 'inherit' });
      if (r.status !== 0) console.error(`judge.mjs exited ${r.status} on ${name}`);
      if (existsSync(out)) {
        const doc = JSON.parse(readFileSync(out, 'utf8'));
        spent += doc.items.filter((i) => !i.reused).reduce((s, i) => s + (i.cost_usd ?? 0), 0);
      }
    }
    console.log(scoreSet(outDir).text);
  } else {
    console.error(
      'usage: node eval/scripts/judge-validate.mjs --build <dir> | --score <out-dir> [--set s] | --paid [--set s] [--out-dir d] [--budget usd]\n' +
        '       | --regate <from-dir> --out-dir <dir> [--set s]'
    );
    process.exit(1);
  }
}
