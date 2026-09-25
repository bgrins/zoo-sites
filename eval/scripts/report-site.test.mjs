import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReportSite } from './report-site.mjs';

test('builds selected children and links, and removes deselected children on rebuild', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-site-'));
  try {
    const runDir = join(root, 'run-one');
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'results.json'), JSON.stringify({ meta: { date: '2026-09-25T03:31:34Z' }, results: [
      { task: 'mfa-login', condition: 'first', family: 'auth', success: true, input_tokens: 10, output_tokens: 2, answer: 'SECRET' },
    ] }));
    writeFileSync(join(runDir, 'diagnoses.json'), JSON.stringify({ run: 'run-one', items: [{ task: 'mfa-login', kind: 'row', diagnosis: { summary: 'A visible step was missed.' } }] }));
    const configPath = join(root, 'config.json');
    const config = {
      title: 'Reports <intranet>', links: [{ title: 'Task deep link', href: 'reports/first/index.html#task-mfa-login' }],
      reports: [{ title: 'Run one', run: 'run-one', slug: 'first', diagnoses: 'diagnoses.json' }],
    };
    writeFileSync(configPath, JSON.stringify(config));
    const out = join(root, 'site');
    const built = buildReportSite(configPath, out);
    assert.equal(built.reports, 1);
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    const child = readFileSync(join(out, 'reports', 'first', 'index.html'), 'utf8');
    assert.match(home, /Reports &lt;intranet&gt;/);
    assert.match(home, /reports\/first\/index.html#task-mfa-login/);
    assert.match(child, /href="\.\.\/\.\.\/index.html"/);
    assert.match(child, /A visible step was missed/);
    assert.ok(!child.includes('SECRET'));
    config.reports.push({ ...config.reports[0] });
    writeFileSync(configPath, JSON.stringify(config));
    assert.throws(() => buildReportSite(configPath, out), /duplicate report slug/);
    config.reports = [];
    writeFileSync(configPath, JSON.stringify(config));
    buildReportSite(configPath, out);
    assert.ok(!existsSync(join(out, 'reports', 'first', 'index.html')));
    assert.ok(!readFileSync(join(out, 'index.html'), 'utf8').includes('Run one'));
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
    writeFileSync(configPath, JSON.stringify({ title: 'Test', links: [], reports: [] }));
    mkdirSync(out);
    writeFileSync(join(out, 'my-file.txt'), 'preserve me');
    assert.throws(() => buildReportSite(configPath, out), /unmanaged directory/);
    assert.equal(readFileSync(join(out, 'my-file.txt'), 'utf8'), 'preserve me');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
