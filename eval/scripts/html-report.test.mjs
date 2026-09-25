import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { localTraceHref, readRunReview, renderHtmlReport, tracePath } from './html-report.mjs';

const script = fileURLToPath(new URL('./html-report.mjs', import.meta.url));
const run = {
  meta: { date: '2026-09-25T03:31:34Z', suite: 'all', git: { commit: 'abcdef123456' } },
  results: [
    { task: 'normal', family: 'forms', condition: 'one', backend: 'codex', model: 'gpt-6-luna', success: true, input_tokens: 5, cache_creation: 10, cache_read: 185, output_tokens: 200, wall_s: 3, prompt: 'PRIVATE PROMPT', answer: 'SECRET ANSWER' },
    { task: 'normal', family: 'forms', condition: 'two', backend: 'codex', model: 'gpt-6-luna', success: false, input_tokens: 5, cache_creation: 10, cache_read: 85, output_tokens: 100, wall_s: 2, detail: 'PRIVATE GRADING DETAIL' },
    { task: '<script>alert("x")</script>', family: 'unsafe" onmouseover="evil', condition: 'one', backend: 'codex', model: 'gpt-6-luna', success: true, output_tokens: 50, wall_s: 1 },
    { task: '<script>alert("x")</script>', family: 'unsafe" onmouseover="evil', condition: 'two', backend: 'codex', model: 'gpt-6-luna', success: true, output_tokens: 50, wall_s: 1 },
  ],
};

test('renders a paired standalone report without exporting raw evidence', () => {
  const html = renderHtmlReport(run, 'run-name');
  assert.match(html, /<!doctype html>/);
  assert.match(html, /2\.00×/);
  assert.match(html, /Input ratio/);
  assert.match(html, /Cache-read share/);
  assert.match(html, /<article class="card"><h2>one<\/h2><dl><dt>Pass<\/dt><dd>2 \/ 2<\/dd><dt>Input tokens/);
  assert.ok(!html.includes('<strong>2 <small>'));
  assert.ok(!html.includes('Input includes cache writes and reads'));
  assert.match(html, /92\.5%/);
  assert.match(html, /85\.0%/);
  assert.match(html, /<th scope="colgroup" colspan="2" class="ratio-col ratio-group">Ratios<\/th><th scope="colgroup" colspan="4" class="surface-a group-start">one<\/th><th scope="colgroup" colspan="4" class="surface-b group-start">two<\/th>/);
  assert.match(html, /\.card \{[^}]*border-top: 5px solid #78a98b;/);
  assert.match(html, /thead th\.surface-a \{ background: #dce9df; color: #305844; \}/);
  assert.match(html, /\.card:nth-child\(2\) \{ border-top-color: #c7a364; \}/);
  assert.match(html, /thead th\.surface-b \{ background: #f2e7ce; color: #5d492b; \}/);
  assert.match(html, /<th scope="col" class="number ratio-col" aria-label="Wall-clock ratio">Wall<\/th><th scope="col" class="surface-a group-start">Pass<\/th><th scope="col" class="surface-a number">Input<\/th>/);
  assert.match(html, /<td class="surface-a number">200<\/td><td class="surface-a number">92\.5%<\/td><td class="surface-a number">200<\/td>/);
  assert.match(html, /<th scope="col" class="number ratio-col" aria-label="Input ratio">Input<\/th><th scope="col" class="number ratio-col" aria-label="Wall-clock ratio">Wall<\/th>/);
  assert.match(html, /<td class="number ratio-col"><span>2\.00×<\/span><\/td>/);
  assert.match(html, /<td class="number ratio-col"><span>2\.00×<\/span><\/td><td class="number ratio-col"><span>1\.50×<\/span><\/td>/);
  assert.match(html, /<td>forms<\/td><td class="number">1<\/td><td class="number ratio-col"><span>2\.00×<\/span><\/td><td class="number ratio-col"><span>1\.50×<\/span><\/td><td class="surface-a group-start">/);
  assert.match(html, /<table id="tasks"><thead><tr><th scope="col" rowspan="2">Task<\/th><th scope="colgroup" colspan="2" class="ratio-col ratio-group">Ratios<\/th><th scope="colgroup" colspan="5" class="surface-a group-start">one<\/th><th scope="colgroup" colspan="5" class="surface-b group-start">two<\/th>/);
  assert.match(html, /<th scope="col" class="surface-a number" aria-label="Wall time">Wall<\/th>/);
  assert.match(html, /<td class="surface-a number">200<\/td><td class="surface-a number">3s<\/td>/);
  assert.match(html, /<td class="surface-b number">100<\/td><td class="surface-b number">2s<\/td>/);
  assert.ok(!html.includes('Wall time (s)</th>'));
  assert.ok(!html.includes('<td class="muted">forms</td>'));
  assert.match(html, /<p class="detail-family">Family: forms<\/p>/);
  assert.match(html, /<div class="figure">1\.22×<\/div><div class="figure-label">Wall-clock ratio<\/div>/);
  assert.match(html, /<section class="panel comparison" aria-label="Comparison"><h2>Comparison<\/h2><div class="overview">/);
  assert.match(html, /<\/div><p class="method">1 paired tasks · ratios above 1 mean one used more<\/p><div class="summary"><article class="card">/);
  assert.ok(!html.includes('<section aria-label="Results by condition">'));
  assert.match(html, /\.comparison \.summary \{ margin-top: 20px; \}/);
  assert.match(html, /colspan="13"><div class="detail-grid paired"><p class="detail-family">Family: forms<\/p><article class="detail-arm surface-a">/);
  assert.match(html, /<article class="detail-arm surface-b"><h3>two<\/h3>/);
  assert.match(html, /\.detail-grid\.paired \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(html, /\.table-wrap \{ container-type: inline-size;/);
  assert.match(html, /\.detail-grid \{[^}]*max-width: calc\(100cqw - 32px\);[^}]*position: sticky;[^}]*left: 0;/);
  assert.ok(!html.includes('Token ratios are not cost ratios'));
  assert.ok(!html.includes('One run is directional'));
  assert.match(html, /<div class="meta"><span>Sep 25, 2026, 3:31 AM UTC<\/span>/);
  assert.match(html, /<span class="compact-title">Browser-agent evaluation<\/span>/);
  assert.match(html, /<header><div class="hero-inner"><div class="report-nav">/);
  assert.match(html, /<h1>Browser-agent evaluation<\/h1><div class="meta">/);
  assert.match(html, /<nav class="report-compact" aria-label="Report navigation">/);
  assert.match(html, /\.report-compact \{ position: fixed; top: 0; left: 50%; z-index: 5;/);
  assert.ok(!html.match(/\.report-compact \{[^}]*border-radius:/));
  assert.ok(!html.match(/\.floating-head \{[^}]*border-radius:/));
  assert.match(html, /main \{ max-width: 1180px; margin: 0 auto; padding: 0 28px 80px; \}/);
  assert.match(html, /border-radius: 0 0 19px 19px/);
  assert.match(html, /@media \(max-width: 680px\) \{ main \{ padding: 0 14px 55px; \}/);
  assert.match(html, /reportHeader\.getBoundingClientRect\(\)\.top < 0/);
  assert.match(html, /header\.has-compact-nav \{ grid-template-rows: 0fr; padding: 28px 0; border-radius: 0; \}/);
  assert.match(html, /header\.has-compact-nav \.hero-inner \{ pointer-events: none; \}/);
  assert.match(html, /\.report-compact\.is-visible \{ visibility: visible; \}/);
  assert.ok(!html.match(/\.report-compact \{[^}]*opacity:/));
  assert.match(html, /floating\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(html, /head\.top <= top && bounds\.bottom > top/);
  assert.match(html, /Math\.min\(top, bounds\.bottom - head\.height\)/);
  assert.ok(!html.includes('floating.offsetHeight'));
  assert.match(html, /\.task-row \{ scroll-margin-top: 150px; \}/);
  assert.match(html, /Different outcomes/);
  assert.ok(!html.includes('Cost is unavailable'));
  assert.ok(!html.includes('Estimated cost'));
  assert.match(html, /data-different="true"/);
  assert.match(html, /id="task-normal"/);
  assert.match(html, /href="#task-normal"/);
  assert.match(html, /aria-controls="task-normal-detail"/);
  assert.match(html, /task-toggle\[aria-expanded="true"\]::before/);
  assert.match(html, /hashchange/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /unsafe&quot; onmouseover=&quot;evil/);
  for (const privateText of ['PRIVATE PROMPT', 'SECRET ANSWER', 'PRIVATE GRADING DETAIL', 'alert("x")']) {
    assert.ok(!html.includes(privateText));
  }
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('file://'));
  assert.match(renderHtmlReport(run, 'run-name', { title: 'Run <two>' }), /<h1>Run &lt;two&gt;<\/h1>/);
});

test('includes judge verdicts, attribution, feedback and escaped evidence', () => {
  const diagnoses = { run: 'run-name', items: [
    { kind: 'pair', task: 'normal', model: 'judge-model', effort: 'medium', cost_usd: 0.04, gate: { kept: 3, checked: 4 }, diagnosis: {
      summary: 'Compared the <tools> directly.', difference_driver: 'surface', driver_unsupported: true, better_arm: 'one', confidence: 'high',
      arms: [{ arm: 'one', primary_cause: 'tool-missing-info', grade_correct: false, grade_note: 'Incorrect grade.', legitimate: false, legitimacy_note: 'Missed requirement.', summary: 'Missing value.', cost_driver: 'Extra read.', trigger: { step: 4, tool: 'snapshot', reply_quote: '<truncated>' }, wasted_steps: [{ from: 2, to: 3, cause: 'tool-missing-info', why: 'Had to retry.' }] }],
      surface_differences: [{ what: 'Reply was shorter.', favours: 'one', turns_delta: 2, tokens_delta: 50, evidence: [{ file: 'steps/one.txt', locator: 'step 4', quote: '<private> & text' }] }],
      tool_behaviours: [{ arm: 'one', tool: 'snapshot', behaviour: 'cut-text', effect: 'Repeated the read.', turns: 1, tokens: 30 }],
      tool_feedback: 'Keep the full text.', evidence: [{ file: 'run/results.json', locator: 'results[0]', quote: 'Checked outcome.' }],
    } },
  ] };
  const html = renderHtmlReport(run, 'run-name', { diagnoses, homeHref: '../../index.html' });
  assert.match(html, /Compared the &lt;tools&gt; directly/);
  for (const text of ['surface', 'evidence limited', 'Grade disputed', 'Outcome not earned', 'tool-missing-info', 'Incorrect grade.', 'Extra read.', 'Wasted steps', 'Reply was shorter.', 'Repeated the read.', 'Keep the full text.', 'judge-model', 'quotes kept: 3/4', 'judge cost: $0.0400']) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;private&gt; &amp; text/);
  assert.match(html, /&lt;truncated&gt;/);
  assert.match(html, /href="\.\.\/\.\.\/index.html"/);
  assert.ok(!html.includes('<private>'));
  assert.ok(!html.includes('<truncated>'));
  assert.throws(() => renderHtmlReport(run, 'other-run', { diagnoses }), /diagnoses belong/);
});

test('shows gated run-wide recommendations and rejects a stale or mismatched review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-report-review-'));
  try {
    const diagnoses = { run: 'run-name', items: [{ kind: 'pair', task: 'normal', diagnosis: { summary: 'One pair.' } }] };
    const text = JSON.stringify(diagnoses);
    const resultsText = JSON.stringify(run);
    const review = { run: 'run-name', mode: 'run', model: 'gpt-6-luna', effort: 'high', source: { pairs: 1, judgments_sha256: createHash('sha256').update(text).digest('hex'), results_sha256: createHash('sha256').update(resultsText).digest('hex') }, gate: { kept: 2, checked: 2 }, diagnosis: {
      summary: 'Fewer <retries> would help.', confidence: 'medium', caveats: 'Only one task.', findings: [], recommendations: [{ title: '<script>bad</script>', target: 'firefox-devtools-mcp', priority: 'medium', change: 'Include page text.', rationale: 'Avoid an extra read.', affected_tasks: ['normal'], evidence: [{ file: 'run/judgments.md', locator: 'pair|normal|1', quote: 'An extra read.' }] }],
    } };
    const path = join(dir, 'review.json');
    writeFileSync(path, JSON.stringify(review));
    const html = renderHtmlReport(run, 'run-name', { diagnoses, runReview: readRunReview(path, 'run-name', text, resultsText) });
    assert.match(html, /aria-label="Run-wide review"/);
    assert.match(html, /Fewer &lt;retries&gt; would help/);
    assert.match(html, /href="#task-normal">normal<\/a>/);
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    assert.ok(!html.includes('<script>bad</script>'));
    assert.throws(() => readRunReview(path, 'run-name', text + ' ', resultsText), /does not match/);
    assert.throws(() => readRunReview(path, 'run-name', text, resultsText + ' '), /does not match/);
    assert.throws(() => renderHtmlReport(run, 'run-name', { diagnoses: null, runReview: review }), /matching complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('links only existing graded traces with safe local paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-report-traces-'));
  try {
    mkdirSync(join(dir, 'transcripts'));
    mkdirSync(join(dir, 'rollouts'));
    writeFileSync(join(dir, 'transcripts', 'one--normal--a1.jsonl'), '{}\n');
    writeFileSync(join(dir, 'rollouts', 'one--normal--a1.jsonl'), '{}\n');
    const runWithTraces = { ...run, results: run.results.map((row) => row.condition === 'one' && row.task === 'normal'
      ? { ...row, transcript: 'one--normal--a1.jsonl', rollout: 'rollouts/one--normal--a1.jsonl' } : row) };
    const html = renderHtmlReport(runWithTraces, 'run-name', { traceHref: localTraceHref(dir, join(dir, 'report.html')) });
    assert.match(html, /href="transcripts\/one--normal--a1.jsonl" target="_blank" rel="noopener noreferrer">Full transcript/);
    assert.match(html, /href="rollouts\/one--normal--a1.jsonl" target="_blank" rel="noopener noreferrer">Full rollout/);
    assert.equal((html.match(/Full transcript/g) ?? []).length, 1);
    assert.equal(tracePath(dir, { transcript: '../private.jsonl' }, 'transcript'), null);
    assert.equal(tracePath(dir, { rollout: 'rollouts/../private.jsonl' }, 'rollout'), null);
    assert.equal(tracePath(dir, { task: 'normal' }, 'transcript'), null);
    assert.match(localTraceHref(dir, join(dir, 'elsewhere', 'report.html'))({ transcript: 'one--normal--a1.jsonl' }, 'transcript'), /^\.\.\/transcripts\/one--normal--a1\.jsonl$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renders standalone row diagnoses without invented pair data', () => {
  const html = renderHtmlReport(run, 'run-name', { diagnoses: { run: 'run-name', items: [{ kind: 'row', task: 'normal', diagnosis: {
    summary: 'Reviewed the attempt.', primary_cause: 'tool-defect', grade_correct: true, legitimate: false,
    contributing: ['agent-capability'], confidence: 'medium', tool_feedback: 'Keep the click result.',
    tool_behaviours: [{ tool: 'click', behaviour: 'silent-noop', effect: 'Nothing changed.', evidence: [] }],
  } }] } });
  assert.match(html, /tool-defect/);
  assert.match(html, /Also: agent-capability/);
  assert.match(html, /Keep the click result/);
  assert.ok(!html.includes('Surface differences'));
});

test('supports one surface and repeats without inventing a comparison', () => {
  const html = renderHtmlReport({
    meta: {},
    results: [
      { task: 'repeat', family: 'basic', condition: 'one', success: true, input_tokens: 10, output_tokens: 10, wall_s: 1 },
      { task: 'repeat', family: 'basic', condition: 'one', success: false, input_tokens: 20, output_tokens: 20, wall_s: 3 },
    ],
  });
  assert.match(html, /1\/2/);
  assert.match(html, />15</);
  assert.ok(!html.includes('Different outcomes'));
  assert.match(html, /<section aria-label="Results by condition"><div class="summary"><article class="card">/);
  assert.ok(!html.includes('aria-label="Comparison"'));
  assert.match(html, /<div class="detail-grid"><p class="detail-family">Family: basic<\/p><article class="detail-arm surface-a">/);
  assert.ok(!html.includes('<th scope="colgroup" colspan="2" class="ratio-col ratio-group">'));
  assert.throws(() => renderHtmlReport({ results: [] }), /no result rows/);
});

test('separates backends that used the same browser surface', () => {
  const html = renderHtmlReport({ meta: {}, results: [
    { task: 'shared', condition: 'firefox', backend: 'codex', success: true, input_tokens: 100, output_tokens: 20 },
    { task: 'shared', condition: 'firefox', backend: 'anthropic', success: false, input_tokens: 50, output_tokens: 10 },
  ] });
  assert.match(html, /codex\/firefox/);
  assert.match(html, /anthropic\/firefox/);
  assert.match(html, /2\.00×/);
  assert.match(html, /Different pass outcomes/);
});

test('CLI writes HTML beside an existing run, or to --out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-html-report-'));
  try {
    writeFileSync(join(dir, 'results.json'), JSON.stringify(run));
    const first = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(join(dir, 'report.html'), 'utf8'), /Browser-agent evaluation/);
    const out = join(dir, 'share.html');
    const second = spawnSync(process.execPath, [script, '--out', out, dir], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.match(readFileSync(out, 'utf8'), /Browser-agent evaluation/);
    const diagnosesPath = join(dir, 'diagnoses.json');
    writeFileSync(diagnosesPath, JSON.stringify({ run: dir.split('/').at(-1), items: [{ task: 'normal', kind: 'pair', diagnosis: { summary: 'Reviewed the steps.' } }] }));
    const third = spawnSync(process.execPath, [script, dir, '--diagnoses', diagnosesPath], { encoding: 'utf8' });
    assert.equal(third.status, 0, third.stderr);
    assert.match(readFileSync(join(dir, 'report.html'), 'utf8'), /Reviewed the steps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
