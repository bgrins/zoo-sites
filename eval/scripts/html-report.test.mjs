import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderHtmlReport } from './html-report.mjs';

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
  assert.match(html, /cache is reads \/ input/);
  assert.match(html, /92\.5%/);
  assert.match(html, /85\.0%/);
  assert.match(html, /<th scope="col">Pass<\/th><th scope="col" class="number">Input<\/th><th scope="col" class="number">Cache<\/th><th scope="col" class="number">Output<\/th>/);
  assert.match(html, /<td class="number">200<\/td><td class="number">92\.5%<\/td><td class="number">200<\/td>/);
  assert.match(html, /Different outcomes/);
  assert.ok(!html.includes('Cost is unavailable'));
  assert.ok(!html.includes('Estimated cost'));
  assert.match(html, /data-different="true"/);
  assert.match(html, /id="task-normal"/);
  assert.match(html, /href="#task-normal"/);
  assert.match(html, /aria-controls="task-normal-detail"/);
  assert.match(html, /hashchange/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /unsafe&quot; onmouseover=&quot;evil/);
  for (const privateText of ['PRIVATE PROMPT', 'SECRET ANSWER', 'PRIVATE GRADING DETAIL', 'alert("x")']) {
    assert.ok(!html.includes(privateText));
  }
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('file://'));
});

test('includes an opt-in judge summary without raw judge evidence', () => {
  const diagnoses = { run: 'run-name', items: [
    { kind: 'pair', task: 'normal', diagnosis: { summary: 'Compared the <tools> directly.', difference_driver: 'surface', evidence: [{ quote: 'PRIVATE EVIDENCE' }] } },
  ] };
  const html = renderHtmlReport(run, 'run-name', { diagnoses, homeHref: '../../index.html' });
  assert.match(html, /Compared the &lt;tools&gt; directly/);
  assert.match(html, /href="\.\.\/\.\.\/index.html"/);
  assert.ok(!html.includes('PRIVATE EVIDENCE'));
  assert.throws(() => renderHtmlReport(run, 'other-run', { diagnoses }), /diagnoses belong/);
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
