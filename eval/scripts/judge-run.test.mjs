import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathSpellings } from '../agent-env.mjs';
import { isolationProblems } from '../backends/codex.mjs';
import { gateRunReview, prepareRunReview, renderJudgmentBrief, runReviewPrompt } from './judge-run.mjs';

const run = { results: [
  { task: 'one', rep: 1, family: 'forms', condition: 'firefox-devtools-mcp', success: true, input_tokens: 10, cache_read: 30, output_tokens: 40, wall_s: 5 },
  { task: 'one', rep: 1, family: 'forms', condition: 'playwright-mcp', success: true, input_tokens: 7, output_tokens: 20, wall_s: 3 },
  { task: 'two', rep: 1, family: 'auth', condition: 'firefox-devtools-mcp', success: false, output_tokens: 70, wall_s: 9 },
  { task: 'two', rep: 1, family: 'auth', condition: 'playwright-mcp', success: true, output_tokens: 35, wall_s: 4 },
] };
const judgments = { run: 'run-one', mode: 'pairs', model: 'gpt-6-luna', effort: 'high', items: [
  { id: 'pair|one|1', task: 'one', kind: 'pair', model: 'gpt-6-luna', effort: 'high', gate: { kept: 2, checked: 3 }, diagnosis: { summary: 'Firefox repeated a snapshot.', difference_driver: 'surface', tool_feedback: 'Include the full text.' } },
  { id: 'pair|two|1', task: 'two', kind: 'pair', model: 'gpt-6-luna', effort: 'high', gate: { kept: 3, checked: 3 }, diagnosis: { summary: 'Firefox missed the final state.', difference_driver: 'agent-variance' } },
] };

test('requires every paired task to have one completed judgment from the same settings', () => {
  const prepared = prepareRunReview(run, 'run-one', judgments);
  assert.equal(prepared.count, 2);
  const brief = renderJudgmentBrief(prepared);
  assert.match(brief, /pair\|one\|1/);
  assert.match(brief, /input 40, output 40/);
  assert.match(brief, /Firefox repeated a snapshot/);
  assert.match(runReviewPrompt(prepared), /Read all of run\/judgments\.md/);
  assert.match(runReviewPrompt(prepared), /Monetary cost is unknown when cost_usd is null/);
  assert.throws(() => prepareRunReview(run, 'other', judgments), /do not belong/);
  assert.throws(() => prepareRunReview(run, 'run-one', { ...judgments, items: judgments.items.slice(0, 1) }), /all 2 pairs/);
  assert.throws(() => prepareRunReview(run, 'run-one', { ...judgments, items: [judgments.items[0], judgments.items[0]] }), /duplicate/);
  assert.throws(() => prepareRunReview(run, 'run-one', { ...judgments, items: [judgments.items[0], { ...judgments.items[1], diagnosis: null }] }), /failed pair/);
  assert.throws(() => prepareRunReview(run, 'run-one', { ...judgments, items: [judgments.items[0], { ...judgments.items[1], task: 'one' }] }), /failed pair/);
  assert.throws(() => prepareRunReview({ results: run.results.slice(0, 3) }, 'run-one', judgments), /unpaired/);
});

test('gates evidence and task names in run-wide recommendations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-run-test-'));
  try {
    const prepared = prepareRunReview(run, 'run-one', judgments);
    const brief = join(dir, 'judgments.md');
    writeFileSync(brief, renderJudgmentBrief(prepared));
    const raw = { summary: 'A summary.', findings: [], recommendations: [
      { title: 'Longer snapshots', affected_tasks: ['one'], evidence: [{ file: 'run/judgments.md', locator: 'pair|one|1', quote: 'Firefox repeated a snapshot.' }] },
      { title: 'Wrong task', affected_tasks: ['missing'], evidence: [{ file: 'run/judgments.md', locator: 'pair|one|1', quote: 'Firefox repeated a snapshot.' }] },
      { title: 'Uncited', affected_tasks: ['two'], evidence: [{ file: 'run/judgments.md', locator: 'pair|two|1', quote: 'made up evidence' }] },
      { title: 'Wrong pair', affected_tasks: ['two'], evidence: [{ file: 'run/judgments.md', locator: 'pair|one|1', quote: 'Firefox repeated a snapshot.' }] },
    ] };
    const gated = gateRunReview(raw, prepared, { 'run/judgments.md': brief });
    assert.equal(gated.output.recommendations[0].unsupported, undefined);
    assert.equal(gated.output.recommendations[1].unsupported, true);
    assert.equal(gated.output.recommendations[2].unsupported, true);
    assert.equal(gated.output.recommendations[3].unsupported, true);
    assert.equal(gated.gate.kept, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts the sandbox spelling of a macOS writable directory', () => {
  const path = '/private/var/folders/example/scratch';
  const turnContext = { multi_agent_version: 'disabled', permission_profile: { network: 'restricted', file_system: { entries: [
    { access: 'write', path: { type: 'path', path: '/var/folders/example/scratch' } },
  ] } } };
  assert.deepEqual(isolationProblems({ turnContext }, { writable: pathSpellings(path), deny: [] }), []);
});
