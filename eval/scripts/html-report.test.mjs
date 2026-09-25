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
  assert.match(html, /Geometric-mean input ratio/);
  assert.match(html, /Cache-read share/);
  assert.match(html, /cache reads \/ total input/);
  assert.match(html, /92\.5%/);
  assert.match(html, /85\.0%/);
  assert.match(html, /<th scope="col">Pass<\/th><th scope="col" class="number">Input<\/th><th scope="col" class="number">Cache<\/th><th scope="col" class="number">Output<\/th>/);
  assert.match(html, /<td class="number">200<\/td><td class="number">92\.5%<\/td><td class="number">200<\/td>/);
  assert.match(html, /Different outcomes/);
  assert.match(html, /Cost is unavailable/);
  assert.match(html, /data-different="true"/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /unsafe&quot; onmouseover=&quot;evil/);
  for (const privateText of ['PRIVATE PROMPT', 'SECRET ANSWER', 'PRIVATE GRADING DETAIL', 'alert("x")']) {
    assert.ok(!html.includes(privateText));
  }
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('file://'));
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
