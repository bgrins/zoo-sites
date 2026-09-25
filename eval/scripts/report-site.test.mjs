import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildReportSite } from './report-site.mjs';

test('builds selected children and links, and removes deselected children on rebuild', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-site-'));
  try {
    const runDir = join(root, 'run-one');
    mkdirSync(runDir);
    mkdirSync(join(runDir, 'transcripts'));
    mkdirSync(join(runDir, 'rollouts'));
    writeFileSync(join(runDir, 'transcripts', 'first--mfa-login--a1.jsonl'), '{"type":"step"}\n');
    writeFileSync(join(runDir, 'rollouts', 'first--mfa-login--a1.jsonl'), '{"type":"turn"}\n');
    writeFileSync(join(runDir, 'results.json'), JSON.stringify({ meta: { date: '2026-09-25T03:31:34Z' }, results: [
      { task: 'mfa-login', condition: 'first', family: 'auth', success: true, input_tokens: 10, output_tokens: 2, answer: 'SECRET', transcript: 'first--mfa-login--a1.jsonl', rollout: 'rollouts/first--mfa-login--a1.jsonl' },
    ] }));
    writeFileSync(join(runDir, 'diagnoses.json'), JSON.stringify({ run: 'run-one', items: [{ task: 'mfa-login', kind: 'row', diagnosis: { summary: 'A visible step was missed.' } }] }));
    writeFileSync(join(root, 'demo.mp4'), 'example video');
    const configPath = join(root, 'config.json');
    const config = {
      title: 'Reports <gallery>', video: 'demo.mp4', repository: 'https://github.com/bgrins/zoo-sites', links: [{ title: 'Task deep link', href: 'reports/first/index.html#task-mfa-login' }],
      reports: [{ title: 'Run one', run: 'run-one', slug: 'first', diagnoses: 'diagnoses.json', traces: true }],
    };
    writeFileSync(configPath, JSON.stringify(config));
    const out = join(root, 'site');
    const built = buildReportSite(configPath, out);
    assert.equal(built.reports, 1);
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    const child = readFileSync(join(out, 'reports', 'first', 'index.html'), 'utf8');
    assert.match(home, /Reports &lt;gallery&gt;/);
    assert.ok(!home.includes('class="eyebrow"'));
    assert.match(home, /<h1 class="brand">[^]*the_zoo <small>\/ Evals<\/small><\/span><\/h1>/);
    assert.ok(!home.includes('<h1>Reports &lt;gallery&gt;</h1>'));
    assert.ok(!home.includes('Browser environments'));
    assert.match(home, /href="https:\/\/github.com\/bgrins\/zoo-sites" target="_blank" rel="noopener noreferrer">GitHub repository/);
    assert.match(home, /the_zoo/);
    assert.match(home, /reports\/first\/index.html#task-mfa-login/);
    assert.match(home, /<video muted loop playsinline controls preload="auto"/);
    assert.ok(!home.includes('<video autoplay'));
    assert.match(home, /<div class="demo-bar" aria-hidden="true">(?:<span class="window-dot"><\/span>){3}<\/div>/);
    assert.ok(!home.includes('site.zoo / demo'));
    assert.ok(!home.includes('64 tasks</span>'));
    assert.match(home, /src="media\/demo.mp4" type="video\/mp4"/);
    assert.equal(readFileSync(join(out, 'media', 'demo.mp4'), 'utf8'), 'example video');
    assert.match(child, /href="\.\.\/\.\.\/index.html"/);
    assert.match(child, /<h1>Run one<\/h1>/);
    assert.match(child, /A visible step was missed/);
    assert.match(child, /href="traces\/transcripts\/first--mfa-login--a1.jsonl"/);
    assert.match(child, /href="traces\/rollouts\/first--mfa-login--a1.jsonl"/);
    assert.equal(readFileSync(join(out, 'reports', 'first', 'traces', 'transcripts', 'first--mfa-login--a1.jsonl'), 'utf8'), '{"type":"step"}\n');
    assert.equal(readFileSync(join(out, 'reports', 'first', 'traces', 'rollouts', 'first--mfa-login--a1.jsonl'), 'utf8'), '{"type":"turn"}\n');
    assert.ok(!child.includes('SECRET'));
    const playbackScript = home.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(playbackScript);
    const calls = [];
    const video = { play: () => { calls.push('play'); return Promise.resolve(); }, pause: () => calls.push('pause') };
    const motion = { matches: true, addEventListener: (type, listener) => { motion.listener = listener; } };
    const context = { document: { querySelector: () => video }, matchMedia: () => motion };
    runInNewContext(playbackScript, context);
    assert.deepEqual(calls, []);
    motion.matches = false;
    runInNewContext(playbackScript, context);
    assert.deepEqual(calls, ['play']);
    motion.matches = true;
    motion.listener();
    assert.deepEqual(calls, ['play', 'pause']);
    config.reports[0].traces = false;
    writeFileSync(configPath, JSON.stringify(config));
    buildReportSite(configPath, out);
    assert.ok(!readFileSync(join(out, 'reports', 'first', 'index.html'), 'utf8').includes('Full transcript'));
    assert.ok(!existsSync(join(out, 'reports', 'first', 'traces')));
    config.reports[0].traces = true;
    config.reports.push({ ...config.reports[0] });
    writeFileSync(configPath, JSON.stringify(config));
    assert.throws(() => buildReportSite(configPath, out), /duplicate report slug/);
    config.reports = [];
    delete config.video;
    writeFileSync(configPath, JSON.stringify(config));
    buildReportSite(configPath, out);
    assert.ok(!existsSync(join(out, 'reports', 'first', 'index.html')));
    assert.ok(!existsSync(join(out, 'reports', 'first', 'traces', 'transcripts', 'first--mfa-login--a1.jsonl')));
    assert.ok(!existsSync(join(out, 'media', 'demo.mp4')));
    assert.ok(!readFileSync(join(out, 'index.html'), 'utf8').includes('Run one'));
    assert.ok(!readFileSync(join(out, 'index.html'), 'utf8').includes('<video'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unsafe links, duplicate slugs and unmanaged output', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-site-'));
  try {
    const configPath = join(root, 'config.json');
    const out = join(root, 'site');
    writeFileSync(configPath, JSON.stringify({ title: 'Test', links: [{ title: 'Bad', href: 'javascript:alert(1)' }], reports: [] }));
    assert.throws(() => buildReportSite(configPath, out), /unsafe link/);
    writeFileSync(configPath, JSON.stringify({ title: 'Test', repository: 'javascript:alert(1)', links: [], reports: [] }));
    assert.throws(() => buildReportSite(configPath, out), /unsafe link/);
    writeFileSync(configPath, JSON.stringify({ title: 'Test', links: [], reports: [] }));
    mkdirSync(out);
    writeFileSync(join(out, 'my-file.txt'), 'preserve me');
    assert.throws(() => buildReportSite(configPath, out), /unmanaged directory/);
    assert.equal(readFileSync(join(out, 'my-file.txt'), 'utf8'), 'preserve me');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('includes only a run-wide review matching the configured judgments', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-site-review-'));
  try {
    const dir = join(root, 'run');
    mkdirSync(dir);
    const resultsText = JSON.stringify({ results: [
      { task: 'one', family: 'forms', condition: 'first', success: true },
      { task: 'one', family: 'forms', condition: 'second', success: true },
    ] });
    writeFileSync(join(dir, 'results.json'), resultsText);
    const diagnosesText = JSON.stringify({ run: 'run', items: [{ kind: 'pair', task: 'one', diagnosis: { summary: 'Reviewed both.' } }] });
    writeFileSync(join(dir, 'diagnoses.json'), diagnosesText);
    const review = { run: 'run', mode: 'run', model: 'gpt-6-luna', effort: 'high', source: { pairs: 1, judgments_sha256: createHash('sha256').update(diagnosesText).digest('hex'), results_sha256: createHash('sha256').update(resultsText).digest('hex') }, diagnosis: { summary: 'One finding.', recommendations: [], findings: [], confidence: 'high', caveats: '' }, gate: { kept: 0, checked: 0 } };
    writeFileSync(join(dir, 'review.json'), JSON.stringify(review));
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ title: 'Gallery', links: [], reports: [{ title: 'Run', slug: 'run', run: 'run', diagnoses: 'diagnoses.json', review: 'review.json' }] }));
    const out = join(root, 'site');
    buildReportSite(configPath, out);
    assert.match(readFileSync(join(out, 'reports', 'run', 'index.html'), 'utf8'), /One finding\./);
    writeFileSync(join(dir, 'diagnoses.json'), diagnosesText + '\n');
    assert.throws(() => buildReportSite(configPath, out), /does not match/);
    writeFileSync(join(dir, 'diagnoses.json'), diagnosesText);
    writeFileSync(join(dir, 'results.json'), resultsText + '\n');
    assert.throws(() => buildReportSite(configPath, out), /does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
