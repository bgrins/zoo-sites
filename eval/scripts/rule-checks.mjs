// The reporting rules that decide a row's reading without a browser, each
// checked on the case that made it and on the case it must not catch: reach's
// folded and joined matching, the copied-cut rule, the code echo and the
// image-only gate, the malformed-uid and scripted-write counters, script
// recovery, shell assistance, whole-path labels and transcription, and the
// firefox-devtools-mcp 0.10 reply formats and tools (its uids, its snapshot
// line cut, get_page_text's cut and reads, and a closed browser launched
// again), the transcript judge's evidence gate, blinding, staging and format
// normalisation, source and output denies, and standing questions, the
// bookkeeping of verify.mjs --extract, run against a stub extractor,
// run-health.mjs on a consistent run and on each setup defect seeded into one,
// the token ledger's reading of a codex rollout and an Agent SDK transcript,
// whose parts have to add up to the row's recorded usage, the checks that catch
// replies it did not measure, and its A/B section's split, intervals and
// shares, and the browser a condition ran on (a Firefox build difference, the
// launchers' prefs, the policy a pinned Playwright build needs, a condition's
// browser key, an A/A control on another build, the telemetry diff's browser
// line and a blinded judge's view of two builds), and the UTC date helpers
// sites mint dates with and drivers guard them with. It runs no browser and no
// model, so it costs the gate nothing (ruleCheckFailures); on its own:
//
//   node eval/scripts/rule-checks.mjs

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { priceTokens } from '../backends/pricing.mjs';
import { devtoolsFirefox, devtoolsFirefoxLaunch, devtoolsFirefoxPolicy, firefoxBuild } from '../mcp-stdio.mjs';
import { createCallRecorder, malformedUid, serverExit, toolsListInfo } from '../mcp-tap.mjs';
import { envMismatches, headline, launcherNote, totalsByCondition, totalsTableLines } from '../report.mjs';
import { createReachRecorder, reachOf } from '../surface-reach.mjs';
import { abReport, bandIndex, MIN_TASKS, rng } from '../ab.mjs';
import { browserKey, describeBrowserKey, telemetryBrowserNote } from './identity.mjs';
import { shellAssisted } from './row-evidence.mjs';
import { dirtyIn, evidenceLines, HEALTH_CHECKS, PRICE_TABLE, PRICE_TABLE_VERSION, runHealth } from './run-health.mjs';
import { writeStateFile } from './state-file.mjs';
import { failureClass, labelledValues, labelNames } from './triage.mjs';
import { normalize } from './events.mjs';
import {
  armFacts, armLedger, blindBrowsers, blindingInputs, blindingPlanFrom, blindLabels, citedFile, formsOf, gateOutput, judgeCommands, judgeDenies,
  ledgerTable, makeScrub, renderMarkdown, renderSteps, replyWording, rowNormaliser, rowPrompt, sourceShutFor, stageItem, stagedMeta, uidLifetime,
} from './judge.mjs';
import { enforceQuotes, normalise } from '../extract.mjs';
import { extractCase, extractCounts, leafDiff, openExtractLog, readExtractLog } from '../verify-extract.mjs';
import { abLedgerLines, conditionLedgerLines, lateServerRows, ledgerChecks, rowLedger, sumLedgers } from './token-ledger.mjs';
import { DAY_MS, isoDay, isoWeek, nextWeekday, shiftWeeks, utcDay, WEEK_MS } from '../../sites/lib.mjs';
import { notAfterToday, notBeforeToday, pageDay } from '../verify-drivers/lib.mjs';

// An Agent SDK exchange: each [tool, input, reply, isError, at] a call to the
// firefox server and its tool_result, whose reply is text or a list of
// content blocks, sent at `at` (ms) when given.
function sdkMessages(calls) {
  return calls.flatMap(([tool, input, reply, isError = false, at = null], i) => [
    { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: `mcp__firefox__${tool}`, input }] } },
    {
      type: 'user',
      ...(at == null ? {} : { timestamp: new Date(at).toISOString() }),
      message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: isError, content: Array.isArray(reply) ? reply : [{ type: 'text', text: reply }] }] },
    },
  ]);
}
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
const summaryOf = (calls) => {
  const rec = createCallRecorder('firefox');
  for (const m of sdkMessages(calls)) rec.observe(m);
  return rec.summary();
};
const frictionOf = (calls) => summaryOf(calls).friction;
const recovered = (calls) => {
  const rec = createCallRecorder('firefox');
  for (const m of sdkMessages(calls)) rec.observe(m);
  return rec.summary().tool_errors.map((e) => e.recovered);
};
const reachRecorder = (reply) => {
  const rec = createReachRecorder();
  for (const m of sdkMessages([['take_snapshot', {}, reply]])) rec.observe(m);
  return rec;
};
const labelled = (answer, path) => labelledValues(answer).some((l) => labelNames(path, l));

// The judge's evidence gate over a diagnosis of arm X, or of the pair X and
// Y: X's steps file has a snapshot and a script's reply, Y's one error, beside
// a validator, a README line and a pretty-printed results.json. `extra` adds
// to the gate's context.
function judgeGate(diagnosis, kind = 'row', extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rule-'));
  try {
    const steps = {
      X: [
        { kind: 'tool', n: 1, tool: 'take_snapshot', label: 'mcp:firefox/take_snapshot', detail: '{}' },
        { kind: 'tool_result', n: 1, text: 'uid=1_3 status text="Welcome back, Ops. Security..."' },
        { kind: 'tool', n: 2, tool: 'evaluate_script', label: 'mcp:firefox/evaluate_script', detail: '{}' },
        { kind: 'tool_result', n: 2, text: '"Welcome back, Ops.\\nSecurity phrase: saffron"' },
      ],
      Y: [
        { kind: 'tool', n: 1, tool: 'drag_by_uid_to_uid', label: 'mcp:firefox/drag_by_uid_to_uid', detail: '{"fromUid":"1_80"}' },
        { kind: 'tool_result', n: 1, isError: true, text: 'Element 1_80 is stale; take a new snapshot' },
      ],
    };
    const files = {
      'steps/X.txt': ['X', 'steps', renderSteps(steps.X, { answer: 'Welcome back, Ops.' })],
      'steps/Y.txt': ['Y', 'steps', renderSteps(steps.Y)],
      'eval/README.md': [null, 'other', '## The transcript judge\n'],
      'eval/tasks/web/auth.mjs': [null, 'validator', 'const phraseOk = fields.phrase === truth.phrase;\n'],
      'run/results.json': [null, 'results', `${JSON.stringify({ results: [{ code_mode: { requests: 9, truncated_outputs: 1 } }] }, null, 1)}\n`],
    };
    const at = (f) => join(dir, f.replaceAll('/', '_'));
    for (const [f, [, , text]] of Object.entries(files)) writeFileSync(at(f), text);
    const resolveFile = (f) => (files[f] ? at(f) : null);
    const roleOf = (p) => {
      const [arm, role] = files[Object.keys(files).find((f) => at(f) === p)];
      return { arm, kind: role };
    };
    return gateOutput(kind, diagnosis, { resolveFile, roleOf, steps, arm: 'X', ...extra });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A codex rollout of three requests: a catalog print codex cut from 5,000 of
// its tokens (UTF-8 bytes over 4) to 1,000, which the model reads as 1,030,
// a snapshot read through a script, and the answer. `snapshotGrowth` is the
// second step's input growth beyond the agent's own 40 output tokens.
function codexRollout(snapshotGrowth = 210) {
  const usage = (input, read, write, output, reasoning) => ({
    input_tokens: input, cached_input_tokens: read, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: reasoning,
  });
  const inputs = [1000, 2080, 2080 + 40 + snapshotGrowth];
  const lasts = [usage(inputs[0], 0, 1000, 50, 10), usage(inputs[1], 1000, 1080, 40, 0), usage(inputs[2], 2080, inputs[2] - 2080, 5, 0)];
  let total = usage(0, 0, 0, 0, 0);
  const count = (i) => {
    total = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v + lasts[i][k]]));
    return { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: lasts[i] } } };
  };
  const item = (payload) => ({ type: 'response_item', payload });
  const head = 'Script completed\nOutput:\n';
  const warning = 'Warning: truncated output (original token count: 5000)\n';
  const marker = '…4000 tokens truncated…';
  const fill = 4000 - Buffer.byteLength(head + warning + marker);
  const lines = [
    { type: 'session_meta', payload: {} },
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task: open the page.' }] }),
    item({ type: 'reasoning', summary: [] }),
    item({ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(ALL_TOOLS.filter((t) => /firefox/.test(t.name)));' }),
    item({
      type: 'custom_tool_call_output', call_id: 'c1',
      output: [{ type: 'input_text', text: head }, { type: 'input_text', text: `${warning}${'x'.repeat(Math.floor(fill / 2))}${marker}${'x'.repeat(Math.ceil(fill / 2))}` }],
    }),
    count(0),
    item({ type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'text(await tools.mcp__firefox__take_snapshot({}));' }),
    { type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: 'firefox', tool: 'take_snapshot' }, result: { Ok: { content: [{ type: 'text', text: 'y'.repeat(700) }] } } } },
    item({ type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'y'.repeat(700) }] }),
    count(1),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }),
    count(2),
  ];
  const row = {
    backend: 'codex', condition: 'firefox-devtools-mcp', task: 't', model: 'gpt-5.6-luna', transcript: 'x.jsonl', turns: 3,
    input_tokens: 0, cache_creation: 1000 + 1080 + inputs[2] - 2080, cache_read: 3080, output_tokens: 95,
  };
  row.cost_usd = priceTokens(row.model, row, 'rule', 3);
  return { text: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', row };
}

// An Agent SDK transcript of two requests, whose first thinks for 80 of its
// 120 output tokens and calls take_snapshot while the server is still
// connecting, beside a side request of the CLI's own. `orphan` puts between
// them a request that writes nothing visible, whose message_delta follows the
// first's with no assistant message between, as the CLI then asks again;
// `noDelta` drops every message_delta, as 2026-08 transcripts did.
function claudeTranscript({ orphan = false, noDelta = false } = {}) {
  const u = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
  const extra = orphan ? { input_tokens: 7, cache_creation: 60, cache_read: 1000, output_tokens: 2 } : { input_tokens: 0, cache_creation: 0, cache_read: 0, output_tokens: 0 };
  const row = {
    backend: 'anthropic', condition: 'firefox-devtools-mcp', task: 't', model: 'claude-haiku-4-5', transcript: 'y.jsonl', turns: orphan ? 3 : 2,
    input_tokens: 8 + extra.input_tokens, cache_creation: 1140 + extra.cache_creation, cache_read: 1000 + extra.cache_read, output_tokens: 130 + extra.output_tokens,
  };
  const agentCost = priceTokens(row.model, row, 'rule', 2);
  row.cost_usd = agentCost + 0.00068;
  const events = [
    { type: 'system', subtype: 'init', mcp_servers: [{ name: 'firefox', status: 'pending' }] },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'thinking', thinking: 'plan' }], usage: u(5, 1000, 0, 1) } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__firefox__take_snapshot', input: {} }], usage: u(5, 1000, 0, 1) } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { ...u(5, 1000, 0, 120), output_tokens_details: { thinking_tokens: 80 } } } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'z'.repeat(270) }] }] } },
    ...(orphan
      ? [
          { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: u(7, 60, 1000, 2) } },
          { type: 'user', parent_tool_use_id: null, isSynthetic: true, message: { content: [{ type: 'text', text: '[Your previous response had no visible output.]' }] } },
        ]
      : []),
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'done' }], usage: u(3, 140, 1000, 1) } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: u(3, 140, 1000, 10) } },
    {
      type: 'result', usage: u(row.input_tokens, row.cache_creation, row.cache_read, row.output_tokens), total_cost_usd: row.cost_usd,
      modelUsage: {
        'claude-haiku-4-5': {
          inputTokens: row.input_tokens, cacheCreationInputTokens: row.cache_creation, cacheReadInputTokens: row.cache_read, outputTokens: row.output_tokens,
          costUSD: agentCost,
        },
        'claude-haiku-4-5-20251001': { inputTokens: 600, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 16, costUSD: 0.00068 },
      },
    },
  ].filter((e) => !(noDelta && e.type === 'stream_event'));
  return { text: events.map((e) => JSON.stringify(e)).join('\n') + '\n', row };
}

// A codex rollout whose requests read `inputs` and write `output` tokens
// each, with a take_snapshot reply of `replyChars` characters after every
// request but the last, and its row, whose usage is the records' sum.
function plainRollout(inputs, { output = 100, replyChars = 1400, condition = 'A', task = 't', rep = 1 } = {}) {
  const transcript = `${condition}--${task}--${rep}.jsonl`;
  const lines = [{ type: 'session_meta', payload: {} }];
  const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const [k, input] of inputs.entries()) {
    const last = { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: input, output_tokens: output, reasoning_output_tokens: 0 };
    for (const key of Object.keys(total)) total[key] += last[key];
    const call = `c${k}`;
    if (k < inputs.length - 1) {
      lines.push(
        { type: 'response_item', payload: { type: 'custom_tool_call', call_id: call, name: 'exec', input: 'text(await tools.mcp__firefox__take_snapshot({}));' } },
        { type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: 'firefox', tool: 'take_snapshot' }, result: { Ok: { content: [{ type: 'text', text: 'y'.repeat(replyChars) }] } } } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: call, output: [{ type: 'input_text', text: 'y'.repeat(replyChars) }] } },
      );
    } else {
      lines.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } });
    }
    lines.push({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: last } } });
  }
  const row = {
    backend: 'codex', condition, task, rep, model: 'gpt-5.6-luna', transcript, turns: inputs.length,
    input_tokens: 0, cache_creation: total.input_tokens, cache_read: 0, output_tokens: total.output_tokens,
  };
  row.cost_usd = priceTokens(row.model, row, 'rule', inputs.length);
  return { file: `rollouts/${transcript}`, text: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', row };
}

// `fn(dir)` over a run directory that holds `files`, removed after.
function withRunDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name.split('/')[0]), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The ledger of each row read from a run directory that holds `files`, with
// the checks on their sum that failed.
const ledgerOf = (rows, files) =>
  withRunDir(files, (dir) => ({
    ledgers: rows.map((r) => rowLedger(r, dir, {})),
    failed: ledgerChecks('arm', sumLedgers(rows, dir, {})).filter((c) => !c.ok).map((c) => c.name.replace('arm: ', '')),
  }));

// The cells of the rendered table line whose label is `label`.
const cellsOf = (lines, label) => lines.find((l) => l.startsWith(`| ${label} |`))?.split('|').slice(2, -1).map((c) => c.trim()) ?? null;

// The A/B section over `tasks` tasks whose A rows read [1000, 1500, 2000] and
// B rows [800, 1300], each step a measured 400-token reply; with `copyOf` the
// A/A copy's rows read what A's (`'A'`) or B's (`'B'`) do.
const LEDGER_STATS = { rng, bandIndex, MIN_TASKS };
function abSection(copyOf = null, tasks = MIN_TASKS) {
  const ids = Array.from({ length: tasks }, (_, i) => `t${i + 1}`);
  const made = [];
  for (const task of ids) {
    made.push(plainRollout([1000, 1500, 2000], { condition: 'A', task }), plainRollout([800, 1300], { condition: 'B', task }));
    if (copyOf) made.push(plainRollout(copyOf === 'A' ? [1000, 1500, 2000] : [800, 1300], { condition: 'A2', task }));
  }
  const rows = made.map((m) => m.row);
  const pairsOf = (a) => ids.map((t) => [rows.find((r) => r.condition === a && r.task === t), rows.find((r) => r.condition === 'B' && r.task === t)]);
  return withRunDir(Object.fromEntries(made.map((m) => [m.file, m.text])), (dir) =>
    abLedgerLines(pairsOf('A'), dir, {}, { control: copyOf ? pairsOf('A2') : null, stats: LEDGER_STATS, seed: 'rule', resamples: 200 })
  );
}

const judgeRow = (over) => ({
  primary_cause: 'tool-missing-info', grade_correct: true, legitimate: true, confidence: 'high',
  trigger: { step: null, tool: null, reply_quote: null }, wasted_steps: [], tool_behaviours: [], evidence: [], ...over,
});

// verify.mjs --extract against a stub extractor: a task graded on a code and a
// count, and an extractor that answers with the driver's own fields as
// { value, quote } pairs through the real quote gate, each quote the whole
// answer, after throwing the errors `script` lists, one per attempt.
const EXTRACT_ANSWER = 'Reference AR-4149B7, found on 3 pages.';
const extractTask = (validate) => ({
  id: 'stub-task',
  ask: 'Report the reference code and the number of pages it appears on.',
  answerSchema: { type: 'object', properties: { code: { type: ['string', 'null'] }, pages: { type: ['number', 'null'] } } },
  validate: validate ?? ((text, ctx, f) => ({ pass: f?.code === 'AR-4149B7' && f?.pages === 3 })),
});
function stubExtractor(fields, script = []) {
  let attempt = 0;
  const pairsOf = (v, answer) =>
    v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pairsOf(x, answer)]))
      : { value: v, quote: answer };
  return async ({ ask, answer }) => {
    const error = script[attempt++];
    if (error) throw error;
    const raw = pairsOf(fields, answer);
    return { raw, fields: enforceQuotes(raw, normalise(answer), normalise(ask)), extraction: { cost_usd: 0.005 } };
  };
}
const driverCase = { name: 'driver', text: EXTRACT_ANSWER, expect: true, driverFields: { code: 'AR-4149B7', pages: 3 } };
// A two-arm seeded run of one task, written in full the way run.mjs writes
// one: meta, results.json and rows.jsonl, each row's transcript, tap log and
// state file, a codex row's rollout, and report.md's totals table. The codex
// run repeats its task twice; the Agent SDK run's rows carry the SDK's
// per-model usage. Its commit is none a checkout has, so a verdict today's
// rule does not reproduce is a FAIL rather than a changed rule's WARN.
const ARMS = ['firefox-devtools-mcp@a', 'firefox-devtools-mcp@b'];
const HEALTH_TOOLS = [
  { name: 'navigate_page', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'take_snapshot', inputSchema: { type: 'object', properties: {} } },
];
const SDK_MODEL = 'claude-haiku-4-5';
function writeHealthRun(dir, backend) {
  const sdk = backend === 'anthropic';
  const repeat = sdk ? 1 : 2;
  const tools = { ...toolsListInfo(HEALTH_TOOLS), instructions: null };
  const build = { binary: '/opt/firefox/firefox', version: '156.0', buildID: '20260909172920', pdfjs: 'enabled' };
  const env = {
    firefox: '156.0', acceptLanguage: 'en-US,en;q=0.9', userAgent: 'Mozilla/5.0 (X11; rv:156.0) Gecko/20100101 Firefox/156.0',
    languages: ['en-US', 'en'], locale: 'en-US', timeZone: 'UTC', viewport: '1366x683', devicePixelRatio: 1, colorScheme: 'light',
    pdfViewerEnabled: true, build,
  };
  const surface = { source: 'dependency', version: '0.10.3', sha256: 'a1'.repeat(32), walkerSha256: 'b2'.repeat(32), tools };
  const model = sdk ? SDK_MODEL : 'gpt-5.6-luna';
  const meta = {
    date: '2026-09-21T00:00:00.000Z', backend, models: { [backend]: model }, effort: 'medium', suite: 'web', serving: 'origins',
    env: Object.fromEntries(ARMS.map((c) => [c, env])),
    envPins: { locale: 'en-US', acceptLanguage: 'en-US, en', timeZone: 'UTC', viewport: '1366x683', colorScheme: 'light', devtoolsWindow: '1366x768', pdfViewerEnabled: true },
    tasks: ['cart-math'], taskHashes: { 'cart-math': '0123456789abcdef' }, conditions: ARMS.join(','), interleave: true, seed: 'rule-1',
    ...(repeat > 1 ? { repeat } : {}),
    extractor: { extractor: 'anthropic', model: SDK_MODEL }, git: { commit: '0'.repeat(40), dirty: false },
    surfaces: Object.fromEntries(ARMS.map((c) => [c, surface])),
    builds: ARMS.map((c) => ({ label: c.split('@')[1], condition: c, root: '/nm/fdm', ...surface })),
    tap: true, sdks: { [backend]: sdk ? '0.3.1' : '0.145.0' }, priceTable: { package: PRICE_TABLE, version: PRICE_TABLE_VERSION },
    isolation: { toolPolicy: sdk ? { anthropic: { toolMode: 'direct' } } : { codex: { codexHome: 'fresh per attempt', toolMode: 'code_mode_only' } } },
  };
  const answer = 'The cart total is **$42.00**.';
  const counts = { input_tokens: 12, cache_creation: sdk ? 900 : 0, cache_read: 2048, output_tokens: 180 };
  const sdkCost = priceTokens(SDK_MODEL, counts, 'rule-checks', 1);
  const rows = ARMS.flatMap((condition) =>
    Array.from({ length: repeat }, (_, i) => {
      const rep = repeat > 1 ? i + 1 : null;
      const transcript = `${condition}--cart-math${rep ? `--r${rep}` : ''}--a1.jsonl`;
      return {
        backend, condition, task: 'cart-math', ...(rep ? { rep } : {}), family: 'commerce', areas: [], model, success: true,
        detail: 'totalOk=true', surface_calls: 2, foreign_tools: 0,
        tools: { navigate_page: { calls: 1, errors: 0, chars: 2, p50_ms: 50 }, take_snapshot: { calls: 1, errors: 0, chars: 40, p50_ms: 9 } },
        foreign_browser: { method: 'user agent', sessions: 0, requests: 0 },
        prompt: 'You control a web browser.\n\nTask: Report the cart total.\nAnswer concisely with the requested information.',
        browser: { ...build, tag: 'feedc0de' }, started_at: meta.date, answer,
        turns: 3, ...counts, duration_s: 9, api_s: null, wall_s: 9,
        ...(sdk
          ? {
              cost_usd: sdkCost, tool_mode: 'direct',
              model_usage: { [SDK_MODEL]: { ...counts, cost_usd: sdkCost } },
            }
          : {
              cost_usd: priceTokens(model, counts, 'rule-checks', 3), rollout: `rollouts/${transcript}`, tool_mode: 'code_mode_only',
              code_mode: { requests: 3, execs: 2, discovery_execs: 1, exec_sleeps: 0, truncated_outputs: 0 },
            }),
        grading: 'fields', fields: { total: 42 },
        extraction: { extractor: 'anthropic', model: SDK_MODEL, output_tokens: 20, cost_usd: 0.001 },
        extraction_raw: { total: { value: 42, quote: 'cart total is **$42.00**' } }, answer_full: answer, transcript,
        ledger: { requests: 1, documents: 1, scripted: 0, non_browser: 0, sessions: 1, byStatus: { 200: 1 } },
        shell_assisted: null, draws: [{ scope: 'shop.layout', pick: rep === 2 ? 'list' : 'grid', index: rep === 2 ? 0 : 1 }],
        state_file: `states/${transcript.replace(/\.jsonl$/, '')}.json.gz`,
      };
    })
  );
  const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  for (const sub of ['transcripts', 'tool-calls', 'states', ...(sdk ? [] : ['rollouts'])]) mkdirSync(join(dir, sub), { recursive: true });
  const replies = [['navigate_page', 'ok'], ['take_snapshot', 'uid=e1 heading "Cart total $42.00"']];
  for (const r of rows) {
    const stream = sdk
      ? [
          { type: 'system', subtype: 'init' },
          ...sdkMessages(replies.map(([tool, text]) => [tool, {}, text])),
          { type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: answer }] } },
          {
            type: 'result', subtype: 'success', result: answer, num_turns: 3, total_cost_usd: sdkCost,
            modelUsage: {
              [SDK_MODEL]: { inputTokens: 12, outputTokens: 180, cacheReadInputTokens: 2048, cacheCreationInputTokens: 900, costUSD: sdkCost },
            },
          },
        ]
      : [
          ...replies.map(([tool, text], i) => ({
            type: 'item.completed',
            item: { id: `c${i}`, type: 'mcp_tool_call', server: 'firefox', tool, arguments: {}, status: 'completed', result: { content: [{ type: 'text', text }] } },
          })),
          { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: answer } },
        ];
    writeFileSync(join(dir, 'transcripts', r.transcript), lines(stream));
    writeFileSync(join(dir, 'tool-calls', r.transcript), lines([
      { type: 'start', at: 1000, pid: 1 },
      { type: 'initialize', at: 1001, ms: 5, serverInfo: { name: '@mozilla/firefox-devtools-mcp', version: '0.10.3' }, instructions: null },
      { type: 'tools/list', at: 1010, ms: 1, tools: HEALTH_TOOLS },
      { type: 'call', seq: 1, tool: 'navigate_page', at: 1100, ms: 50, resultChars: 2, isError: false },
      { type: 'call', seq: 2, tool: 'take_snapshot', at: 1200, ms: 9, resultChars: 40, isError: false },
      { type: 'signal', at: 1290, signal: 'SIGTERM' },
      { type: 'exit', at: 1300, code: 0, signal: null },
    ]));
    if (r.rollout) writeFileSync(join(dir, r.rollout), '{}\n');
    writeStateFile(join(dir, r.state_file), {
      sessions: new Map(), beacons: [], draws: r.draws,
      ledger: [{ client: 'browser', dest: 'document', route: 'document', sid: 's1', ua: `${env.userAgent} feedc0de`, path: '/cart', status: 200, at: 1150 }],
    });
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'rows.jsonl'), lines(rows));
  writeResults(dir, { meta, results: rows });
}
// results.json with its totals, and report.md's totals table, from `run`.
function writeResults(dir, { meta, results }) {
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ meta, results, totals: totalsByCondition(results) }));
  writeFileSync(join(dir, 'report.md'), ['# zoo-sites eval report', '', '## Totals per condition', '', ...totalsTableLines(headline({ results })), ''].join('\n'));
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const editTotals = (dir, fn) => {
  const run = readJson(join(dir, 'results.json'));
  fn(run.totals[ARMS[0]]);
  writeFileSync(join(dir, 'results.json'), JSON.stringify(run));
};
const rewrite = (path, fn) => writeFileSync(path, fn(readFileSync(path, 'utf8')));
const dropLines = (path, test) => rewrite(path, (text) => text.split('\n').filter((l) => !test(l)).join('\n'));
// The run above in `backend`'s shape with `mutate(dir, edit)` applied to its
// files, then its health: { checks, status: { [check]: status }, evidence:
// every line }.
// `edit(fn)` rewrites results.json through fn(run), and its totals and
// report.md with it, so an edit to a row fails no check but its own.
function healthOf(backend, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rule-health-'));
  try {
    writeHealthRun(dir, backend);
    const edit = (fn) => {
      const run = readJson(join(dir, 'results.json'));
      fn(run);
      writeResults(dir, run);
    };
    mutate(dir, edit);
    const { checks } = runHealth(dir);
    return {
      checks,
      status: Object.fromEntries(checks.map((c) => [c.id, c.status])),
      evidence: checks.flatMap((c) => c.evidence.flatMap((e) => evidenceLines(e, true))).join('\n'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// What each check gives on the runs above as written: every one PASS but the
// codex check of the Agent SDK run, which has no codex rows.
const CLEAN = {
  codex: Object.fromEntries(HEALTH_CHECKS.map((id) => [id, 'PASS'])),
  anthropic: Object.fromEntries(HEALTH_CHECKS.map((id) => [id, id === 'codex' ? 'N/A' : 'PASS'])),
};
const tapOf = (dir, condition, rep = 1) => join(dir, 'tool-calls', `${condition}--cart-math--r${rep}--a1.jsonl`);
const filesOf = (dir, r) => [join(dir, 'transcripts', r.transcript), join(dir, 'tool-calls', r.transcript), join(dir, r.state_file), ...(r.rollout ? [join(dir, r.rollout)] : [])];
// The setup defects a hand review of a run's files found, each seeded once:
// [backend, the statuses it moves off CLEAN, the edit, and optionally a
// pattern its evidence must show]. Every other check must keep its CLEAN status.
const HEALTH_DEFECTS = {
  'a row missing, with its files': [
    'codex',
    { rows: 'FAIL', draws: 'WARN' },
    (dir, edit) => {
      let gone;
      edit((run) => (gone = run.results.pop()));
      dropLines(join(dir, 'rows.jsonl'), (l) => l.includes(gone.transcript));
      for (const f of filesOf(dir, gone)) rmSync(f);
    },
    /1 missing row\(s\)/,
  ],
  'a row rows.jsonl wrote twice and results.json holds once': [
    'codex',
    { rows: 'FAIL' },
    (dir) => rewrite(join(dir, 'rows.jsonl'), (t) => t + t.split('\n')[0] + '\n'),
    /rows\.jsonl holds 1 row\(s\) results\.json lacks/,
  ],
  'a transcript no row records': [
    'codex',
    { rows: 'FAIL' },
    (dir) => writeFileSync(join(dir, 'transcripts', 'firefox-devtools-mcp@c--cart-math--r1--a1.jsonl'), '{}\n'),
    /of attempts no row records/,
  ],
  'a transcript of an attempt after the graded one': [
    'codex',
    { rows: 'FAIL' },
    (dir) => writeFileSync(join(dir, 'transcripts', `${ARMS[0]}--cart-math--r1--a2.jsonl`), '{}\n'),
    /after the one their row records/,
  ],
  'a killed run': [
    'codex',
    { rows: 'FAIL', totals: 'N/A', report: 'WARN', draws: 'WARN' },
    (dir) => {
      const { results } = readJson(join(dir, 'results.json'));
      for (const f of ['results.json', 'report.md']) rmSync(join(dir, f));
      dropLines(join(dir, 'rows.jsonl'), (l) => l.includes(results.at(-1).transcript));
    },
    /1 missing row\(s\)/,
  ],
  'a missing rollout': ['codex', { files: 'FAIL' }, (dir) => rmSync(join(dir, 'rollouts', `${ARMS[1]}--cart-math--r2--a1.jsonl`)), /whose rollout is missing/],
  'totals that are not the rows\' sum': ['codex', { totals: 'FAIL' }, (dir) => editTotals(dir, (t) => (t.passed = 3))],
  'totals without a figure today\'s totals sum': ['codex', { totals: 'WARN' }, (dir) => editTotals(dir, (t) => delete t.turns), /not recorded in results\.json totals/],
  'a report.md that disagrees with results.json': [
    'codex',
    { report: 'FAIL' },
    (dir) => rewrite(join(dir, 'report.md'), (t) => t.replace('| 2/2 |', '| 1/2 |')),
  ],
  'a codex cost that does not recompute': ['codex', { costs: 'FAIL' }, (dir, edit) => edit((run) => (run.results[0].cost_usd *= 1.5))],
  'a codex cost priced as one request, before per-request pricing': [
    'codex',
    { costs: 'WARN' },
    (dir, edit) =>
      edit((run) => {
        const r = run.results[0];
        run.meta.date = '2026-09-01T00:00:00.000Z';
        r.cache_read = 600000;
        r.cost_usd = priceTokens(r.model, { ...r, cache_read: 600000 }, 'rule-checks', 1);
      }),
    /priced before per-request pricing/,
  ],
  'a codex cost from before per-request pricing that neither rule gives': [
    'codex',
    { costs: 'FAIL' },
    (dir, edit) =>
      edit((run) => {
        run.meta.date = '2026-09-01T00:00:00.000Z';
        run.results[0].cost_usd *= 1.5;
      }),
  ],
  'a codex cost priced with another price table': [
    'codex',
    { costs: 'WARN' },
    (dir, edit) =>
      edit((run) => {
        run.meta.priceTable = { package: PRICE_TABLE, version: '0.0.1' };
        run.results[0].cost_usd *= 1.5;
      }),
    /priced them with @pydantic\/genai-prices 0\.0\.1/,
  ],
  'an SDK cost that is not its per-model sum': ['anthropic', { costs: 'FAIL' }, (dir, edit) => edit((run) => (run.results[0].cost_usd += 0.01)), /not the SDK's per-model sum/],
  'SDK token columns off the agent model\'s usage': [
    'anthropic',
    { costs: 'FAIL' },
    (dir, edit) => edit((run) => (run.results[0].cache_read += 3)),
    /cache_read 2051 on the row, 2048 in the SDK's claude-haiku-4-5 usage/,
  ],
  'the CLI\'s own call to another model': [
    'anthropic',
    { costs: 'WARN' },
    (dir, edit) =>
      edit((run) => {
        const r = run.results[0];
        r.model_usage['claude-haiku-4-5-20251001'] = { input_tokens: 600, cache_creation: 0, cache_read: 0, output_tokens: 20, cost_usd: 0.0007 };
        r.cost_usd += 0.0007;
      }),
    /cost_usd includes \$0\.0007 .*\(claude-haiku-4-5-20251001 1 row/,
  ],
  'a tap log short of the transcript': ['codex', { tap: 'FAIL' }, (dir) => dropLines(tapOf(dir, ARMS[1]), (l) => l.includes('"seq":2'))],
  'a server that died mid-attempt': [
    'codex',
    { tap: 'WARN' },
    (dir, edit) => {
      dropLines(tapOf(dir, ARMS[1]), (l) => l.includes('"seq":2') || l.includes('"type":"signal"'));
      rewrite(tapOf(dir, ARMS[1]), (t) => t.replace('"code":0', '"code":1'));
      edit((run) => (run.results.find((r) => r.condition === ARMS[1] && r.rep === 1).surface_calls = 1));
    },
    /the server exited on its own \(code 1\) 0\.3s after it started/,
  ],
  'arms that drew apart': ['codex', { draws: 'FAIL' }, (dir, edit) => edit((run) => (run.results[2].draws = [{ scope: 'shop.layout', pick: 'list', index: 0 }]))],
  'a measured env off its pin': ['codex', { env: 'FAIL' }, (dir, edit) => edit((run) => (run.meta.env[ARMS[1]] = { ...run.meta.env[ARMS[1]], timeZone: 'America/New_York' }))],
  'one tool on two Firefox releases': [
    'codex',
    { env: 'FAIL' },
    (dir, edit) => edit((run) => (run.meta.env[ARMS[1]] = { ...run.meta.env[ARMS[1]], firefox: '152.0' })),
    /Firefox differs: .* "152\.0", between conditions of one tool$/m,
  ],
  'a label a --devtools-firefox pin put on another Firefox': [
    'codex',
    { env: 'WARN' },
    (dir, edit) =>
      edit((run) => {
        run.meta.env[ARMS[1]] = { ...run.meta.env[ARMS[1]], firefox: '152.0' };
        run.meta.devtoolsFirefox = { [ARMS[0]]: null, [ARMS[1]]: { spec: 'playwright', binary: '/pw/firefox', source: '--devtools-firefox' } };
      }),
    /between conditions of one tool, as --devtools-firefox pinned firefox-devtools-mcp@b to playwright/,
  ],
  'a tool build other than the one meta records': [
    'codex',
    { builds: 'FAIL' },
    (dir, edit) => edit((run) => (run.meta.surfaces[ARMS[0]] = { ...run.meta.surfaces[ARMS[0]], version: '0.10.4' })),
    /rows saw server version 0\.10\.3, meta records 0\.10\.4/,
  ],
  'a tool build that changed mid-run': [
    'codex',
    { builds: 'FAIL' },
    (dir) => rewrite(tapOf(dir, ARMS[0], 2), (t) => t.replace('"version":"0.10.3"', '"version":"0.10.4"')),
    /rows saw 2 server versions: 0\.10\.3 1, 0\.10\.4 1/,
  ],
  'a selected task without its hash': ['codex', { identity: 'FAIL' }, (dir, edit) => edit((run) => (run.meta.taskHashes = {}))],
  'an invalid row without its reason': ['codex', { validity: 'FAIL' }, (dir, edit) => edit((run) => (run.results[0].invalid = 'no-surface-calls'))],
  'a shell verdict its state file does not give': [
    'codex',
    { validity: 'FAIL' },
    (dir, edit) => edit((run) => (run.results[0].shell_assisted = { requests: 1, paths: ['GET /cart 200'] })),
    /shell_assisted records 1 request\(s\), its state file's ledger 0/,
  ],
  'a codex row in another tool mode': ['codex', { codex: 'FAIL' }, (dir, edit) => edit((run) => (run.results[0].tool_mode = 'direct'))],
  'a codex isolation problem on a counted row': [
    'codex',
    { codex: 'FAIL', validity: 'FAIL' },
    (dir, edit) => edit((run) => (run.results[0].codex_isolation = ['network: enabled'])),
  ],
  'a codex isolation problem on a row left out as invalid': [
    'codex',
    { codex: 'WARN' },
    (dir, edit) => edit((run) => Object.assign(run.results[0], { codex_isolation: ['network: enabled'], invalid: 'codex-isolation' })),
  ],
  'fields the quote gate does not give': ['codex', { 'quote-gate': 'FAIL' }, (dir, edit) => edit((run) => (run.results[0].fields = { total: 24 }))],
};

const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// The message fn throws, or null when it returns.
const thrown = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

// Each date helper's reading of every half hour of seven days, among them the
// clock changes of the zones the time zone check runs this in and a new year,
// with the zone's UTC offsets in January and July. The check runs it in a
// child that imports the same names, so it may use nothing else here.
function zoneDays() {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const caught = (fn) => {
    try {
      return fn();
    } catch (error) {
      return error.message;
    }
  };
  const from = [[2026, 2, 7], [2026, 2, 28], [2026, 3, 4], [2026, 9, 3], [2026, 9, 24], [2026, 9, 31], [2026, 11, 31]];
  return {
    offsets: [0, 6].map((m) => new Date(Date.UTC(2026, m, 1)).getTimezoneOffset()),
    days: from.flatMap(([y, m, d]) => Array.from({ length: 96 }, (_, i) => {
      const at = Date.UTC(y, m, d) + i * 1800000;
      return [
        shiftWeeks('2026-07-26', at).iso,
        shiftWeeks('2026-07-31', new Date(at), { past: true }).weeks,
        nextWeekday(at, 1),
        isoWeek(at),
        pageDay('Fri 31 Jul', at),
        pageDay('1 Apr', new Date(at)),
        caught(() => notBeforeToday('p', iso(at), { today: at })),
        caught(() => notBeforeToday('p', iso(at - 86400000), { today: new Date(at) })),
        caught(() => notAfterToday('p', iso(at + 86400000), { today: at })),
      ];
    })),
  };
}

const CHECKS = {
  // search-decoy: the answer joins two lines a script returned under keys of
  // their own; the same parts out of order were not shown.
  'reach joins lines': () => {
    const reply = '{"text31": "Bureau of Civic Revenue, Declarations Unit", "text32": "PO Box 4410, Statehouse Plaza Station"}';
    const value = 'Bureau of Civic Revenue, Declarations Unit, PO Box 4410';
    const reversed = 'PO Box 4410, Declarations Unit, Bureau of Civic Revenue';
    return reachOf([value, reversed], reply)[value] === 'seen' && reachOf([reversed], reply)[reversed] !== 'seen';
  },
  'reach undoes YAML doubled quotes': () =>
    reachOf(["Don't miss the harvest sale"], "- paragraph [ref=e5]: 'Don''t miss the harvest sale'")["Don't miss the harvest sale"] === 'seen',
  'reach decodes HTML entities': () =>
    reachOf(['Fish & Chips Friday'], '<p class="menu">Fish &amp; Chips Friday</p>')['Fish & Chips Friday'] === 'seen',
  // news-extract copied firefox-devtools-mcp's 27-character cut; an agent
  // that shortened a title it saw whole wrote a cut no reply holds.
  'copied cut needs a reply that shows it': () =>
    reachRecorder('uid=4_7 link text="I built a spreadsheet that ..."').showsCut('I built a spreadsheet that ...') &&
    !reachRecorder('uid=4_7 link text="I built a spreadsheet that runs my whole week"').showsCut('I built a spreadsheet that ...'),
  'malformed uid read from the argument': () =>
    malformedUid({ uid: 'uid=1_59' }) && malformedUid({ elements: [{ uid: 'e12', value: 'x' }] }, 'legacy') &&
    !malformedUid({ uid: '1_59' }) && !malformedUid({ fromUid: '3_4', toUid: '3_9' }),
  // 0.10 prints e<n> uids, so there e12 is a uid, the 0.9.15 shape is not,
  // and a stale reply to a uid a snapshot printed stays stale.
  'a uid is read against the shape the row\'s snapshots print': () => {
    const stale = ['click_by_uid', { uid: 'e12' }, 'e12 stale/invalid. Call take_snapshot first.', true];
    const legacy = frictionOf([['take_snapshot', {}, 'Snapshot (id=1)\n\nuid=1_0 button "Go"'], stale]);
    const e = frictionOf([['take_snapshot', {}, 'Snapshot\n\nuid=e12 button "Go"'], stale]);
    // An error reply echoes the uid the agent sent, which says nothing of the
    // shape the surface prints: after it a 0.9.15 uid is still a uid.
    const echoed = frictionOf([
      ['take_snapshot', {}, 'Snapshot (id=1)\n\nuid=1_0 button "Go"'],
      ['click_by_uid', { uid: 'uid=e12' }, 'uid=e12 stale/invalid. Call take_snapshot first.', true],
      ['click_by_uid', { uid: '1_0' }, '1_0 stale/invalid. Call take_snapshot first.', true],
    ]);
    return (
      !malformedUid({ uid: 'e12' }, 'e') && malformedUid({ uid: '1_59' }, 'e') && malformedUid({ uid: 'uid=e12' }, 'e') &&
      legacy.malformed_uid === 1 && legacy.stale_uid === 0 && e.malformed_uid === 0 && e.stale_uid === 1 &&
      echoed.malformed_uid === 1 && echoed.stale_uid === 1
    );
  },
  'a 0.10 snapshot line cut counts as a cut': () => {
    const cut = (footer) => summaryOf([['take_snapshot', {}, `Snapshot\n\nuid=e0 button "Go"\n\n${footer}`]]).snapshot.line_cut;
    return cut('[+412 lines hidden; maxLines to show more, selector to scope, saveTo to save the full tree]') === 1 &&
      cut('[+412 lines, use maxLines to see more]') === 1 && cut('[full content, 12 chars]') === 0;
  },
  // A value get_page_text cut at maxLength is shown cut; one it footered as
  // whole is seen.
  'get_page_text cut reads as truncated': () => {
    const value = 'Harbourmaster notice 7731: berths closed';
    return (
      reachOf([value], 'Notices\nHarbourmaster notice 7731: ber\n\n[+4096 chars hidden; maxLength to show more, saveTo to save the full content to a file]')[value] === 'truncated' &&
      reachOf([value], `Notices\n${value}\n\n[full content, 52 chars]`)[value] === 'seen'
    );
  },
  // close_firefox_session ends the browser, and the next call launches
  // another; a run of closes launches one, a close the attempt ends on
  // restarts nothing, and playwright-mcp's browser_close keeps its browser
  // context. Every close is counted, and whether the row ended on one.
  'a close followed by a call is a restart': () => {
    const nav = ['navigate_page', { url: 'http://127.0.0.1:1/a' }, '[0] → http://127.0.0.1:1/a'];
    const close = ['close_firefox_session', {}, 'Closed the Firefox instance started by this server'];
    const f = frictionOf([nav, close, close, nav, close]);
    const pw = frictionOf([['browser_close', {}, 'No open tabs.'], ['browser_navigate', { url: 'http://127.0.0.1:1/a' }, 'ok']]);
    return f.restarts === 1 && f.closes === 3 && f.closed_at_end === 1 && pw.restarts === 0 && pw.closes === 1 && pw.closed_at_end === 0;
  },
  // act_then_snap stays the snapshot-only rate; act_then_read also counts a
  // page text read and a script that reads, never one that writes.
  'a read after an action': () => {
    const click = ['click_by_uid', { uid: 'e1' }, 'click e1'];
    const f = frictionOf([
      click,
      ['get_page_text', {}, 'Welcome\n\n[full content, 7 chars]'],
      click,
      ['evaluate_script', { function: '() => document.body.innerText' }, 'Welcome'],
      click,
      ['evaluate_script', { function: "() => { document.querySelector('#a').click(); }" }, 'undefined'],
      click,
      ['take_snapshot', {}, 'Snapshot\n\nuid=e1 button "Go"'],
    ]);
    return f.actions === 4 && f.act_then_snap === 1 && f.act_then_read === 3 && f.page_text_reads === 1 && f.page_text_chars > 0;
  },
  // playwright-mcp reads a target that is no ref as a selector, so roster's
  // "ref=e29" and cabin-dates' pasted snapshot line failed with selector
  // errors, not the stale text; a selector or a frame ref is well formed.
  'malformed playwright ref read from the argument': () =>
    malformedUid({ target: '[ref=e27]' }) && malformedUid({ fields: [{ target: 'ref=e29', value: 'x' }] }) &&
    malformedUid({ target: 'button "Fri Sep 25 - open" [ref=e90]' }) && malformedUid({ startTarget: 'e3', endTarget: '#e9' }) &&
    !malformedUid({ target: 'e27' }) && !malformedUid({ target: 'f2e41' }) && !malformedUid({ target: '#checkin' }) &&
    !malformedUid({ startTarget: 'e3', endTarget: 'e9' }) && !malformedUid({ url: 'http://127.0.0.1:1/e27' }) &&
    frictionOf([['browser_click', { target: '[ref=e27]' }, '### Error\nError: "[ref=e27]" does not match any elements.', true]]).malformed_uid === 1,
  // native-permit's devtools rows set the closure datetimes and the street
  // multi-select by script; a script that reads, and a Playwright script
  // that clicks and fills through locators, write nothing by script.
  'scripted writes read from the script': () =>
    frictionOf([
      ['evaluate_script', { function: "() => { const s = document.querySelector('#streets'); [...s.options].forEach((o) => (o.selected = true)); s.dispatchEvent(new Event('change')); }" }, 'undefined'],
      ['evaluate_script', { function: "() => { document.querySelector('#start').value = '2026-12-19T06:45'; }" }, 'undefined'],
      ['browser_evaluate', { function: "() => document.querySelector('form').requestSubmit()" }, 'undefined'],
      ['browser_run_code_unsafe', { code: "async (page) => { await page.evaluate(() => document.querySelector('#go').click()); }" }, 'ok'],
    ]).scripted_writes === 4 &&
    frictionOf([
      ['evaluate_script', { function: '() => [...document.querySelectorAll("input")].map((e) => e.value)' }, '[]'],
      ['evaluate_script', { function: '() => document.querySelector("#a").value === "x"' }, 'false'],
      ['browser_run_code_unsafe', { code: "async (page) => { await page.getByRole('button', { name: 'Save' }).click(); return page.evaluate(() => document.title); }" }, 'ok'],
      ['click_by_uid', { uid: '1_4' }, 'click 1_4'],
    ]).scripted_writes === 0,
  // pdf-bill: playwright-mcp's reply to a fill echoes the code it ran, the
  // agent's own value included, which is no evidence the page showed it.
  'the code playwright ran is no reply': () => {
    const reply =
      "### Ran Playwright code\n```js\nawait page.getByRole('textbox', { name: 'Bill number' }).fill('GW-B-A034C4');\n```\n" +
      '### Page\n- Page URL: http://127.0.0.1:1/account/reading.html\n### Result\nRe-bill reference RB-EFC9CE';
    const reach = reachRecorder(reply).reach(['GW-B-A034C4', 'RB-EFC9CE']);
    return reach['GW-B-A034C4'] === 'absent' && reach['RB-EFC9CE'] === 'seen';
  },
  // pdf-bill: with the attempt's state, a bill whose page (its token's URL)
  // was never loaded, or loaded only after the last image, is absent, not
  // image-only; without state, any image reply marks it.
  'image-only needs an image after its page loaded': () => {
    const state = {
      sessions: new Map([['s1', { bills: [{ number: 'GW-B-111111', token: 'Tok3nAbC12' }, { number: 'GW-B-222222', token: 'Zz9Yy8Xx7W' }] }]]),
      ledger: [{ path: '/api/utility/bill.pdf?b=Tok3nAbC12', at: 2000 }],
    };
    const values = ['GW-B-111111', 'GW-B-222222'];
    const reachAt = (at, withState = true) => {
      const rec = createReachRecorder();
      for (const m of sdkMessages([['screenshot_page', {}, [IMAGE], false, at]])) rec.observe(m);
      return rec.reach(values, { truth: values, ...(withState ? { state } : {}) });
    };
    const after = reachAt(3000);
    const before = reachAt(1000);
    const stateless = reachAt(1000, false);
    return (
      after['GW-B-111111'] === 'image-only' && after['GW-B-222222'] === 'absent' &&
      before['GW-B-111111'] === 'absent' && stateless['GW-B-222222'] === 'image-only'
    );
  },
  // resend-receipt's answer dropped the last character of the CR-2026-26B0E
  // its listing showed; hovercard-oncall's read PG-8B1956 off a screenshot
  // as PG-881956. A different code of the same shape is no slip.
  'a claim one character off a delivered truth is a transcription': () => {
    const task = { truth: { values: () => ['CR-2026-26B0E', 'PG-8B1956'] } };
    const state = { sessions: new Map() };
    const events = sdkMessages([['take_snapshot', {}, 'uid=3_1 text="Receipt CR-2026-26B0E"'], ['screenshot_page', {}, [IMAGE]]]);
    const cls = (fields, detail) =>
      failureClass({ task: 't', condition: 'firefox-devtools-mcp', success: false, surface_calls: 1, fields, detail }, events, { state, task })?.class;
    return (
      cls({ receipt: 'CR-2026-26B0' }, 'receiptOk=false') === 'transcription' &&
      cls({ receipt: 'CR-2026-26B0E', page: 'PG-881956' }, 'pageOk=false') === 'transcription' &&
      cls({ receipt: 'CR-2026-9F41A' }, 'receiptOk=false') !== 'transcription'
    );
  },
  // brochure-minimal filled through a script the fields a fill tool could
  // not address; a script that only reads recovers no fill.
  'a script recovers only the job its code does': () => {
    const fill = ['fill_by_uid', { uid: '2_3', value: 'Ada' }, 'Element 2_3 is stale/invalid', true];
    const [byWrite] = recovered([fill, ['evaluate_script', { function: '() => { document.querySelector("#name").value = "Ada"; }' }, 'undefined']]);
    const [byRead] = recovered([fill, ['evaluate_script', { function: '() => document.title' }, '"Brochure"']]);
    return byWrite === true && byRead === false;
  },
  // body-only-ref's ref came in a 507 body a shell read with the browser's
  // cookie; a refusal, a cookieless page, a static page and a scripted row's
  // own driver fetches are not assistance.
  'shell assistance needs a graded answer': () => {
    const shell = (path, status, extra = {}) => ({ client: 'shell', method: 'GET', path, status, sid: 's1', ...extra });
    const hit = (ledger, backend) => shellAssisted(ledger, { backend });
    return (
      hit([shell('/api/depot/manifests', 507)])?.requests === 1 &&
      hit([shell('/gov/rv7.html', 200)])?.requests === 1 &&
      !hit([shell('/api/depot/manifests', 403)]) &&
      !hit([shell('/gov/rv7.html', 200, { sid: 'new', minted: true })]) &&
      !hit([shell('/ledger/page-2.html', 200)]) &&
      !hit([{ client: 'browser', dest: 'empty', path: '/api/depot/manifests', status: 507 }]) &&
      !hit([shell('/api/utility/bill.pdf', 200)], 'scripted')
    );
  },
  // A fabricated quote, one cited at the wrong step, a trigger naming another
  // step's tool, and an escaped newline in a script's reply.
  'judge gate keeps only quotes the file holds': () => {
    const { output, gate } = judgeGate(
      judgeRow({
        trigger: { step: 1, tool: 'evaluate_script', reply_quote: 'Security...' },
        evidence: [
          { file: 'steps/X.txt', locator: 'step 1', quote: 'status text="Welcome back, Ops. Security..."' },
          { file: 'steps/X.txt', locator: 'step 1', quote: 'Security phrase: saffron' },
          { file: 'steps/X.txt', locator: 'step 2', quote: 'Security phrase for this sign-in: saffron' },
          { file: '/etc/passwd', locator: 'line 1', quote: 'root:' },
        ],
      })
    );
    const [kept, moved, made, outside] = output.evidence;
    return (
      kept.quote && kept.locator === 'step 1' && moved.quote && moved.locator === 'step 2' && !made.quote && !outside.quote &&
      output.trigger.tool === null && output.trigger.reply_quote === 'Security...' && gate.moved.length === 1 && !output.unsupported
    );
  },
  // A claim needs a quote of the right thing: a tool cause one of the arm's
  // own replies, not a header, the other arm's error or a README line; a
  // validator cause or a disputed grade one of the validator.
  'judge claims need the right quote': () => {
    const q = (file, locator, quote) => ({ file, locator, quote });
    const made = judgeGate(judgeRow({ evidence: [q('steps/X.txt', 'step 2', 'the tool cut the phrase')] })).output;
    const agent = judgeGate(judgeRow({ primary_cause: 'agent-capability' })).output;
    const grade = judgeGate(judgeRow({ primary_cause: 'extractor', grade_correct: false })).output;
    const header = judgeGate(judgeRow({ evidence: [q('steps/X.txt', 'step 1', '===== step 1 · REPLY')] })).output;
    const headed = judgeGate(judgeRow({ evidence: [q('steps/X.txt', 'step 2', '===== step 2 · REPLY\n"Welcome back, Ops.')] })).output;
    const peer = judgeGate(judgeRow({ primary_cause: 'tool-defect', evidence: [q('steps/Y.txt', 'step 1', 'Element 1_80 is stale')] })).output;
    const readme = judgeGate(
      judgeRow({ primary_cause: 'validator-false-fail', grade_correct: false, evidence: [q('eval/README.md', 'line 1', 'The transcript judge')] })
    ).output;
    const validator = judgeGate(
      judgeRow({ primary_cause: 'validator-false-fail', grade_correct: false, evidence: [q('eval/tasks/web/auth.mjs', 'line 1', 'fields.phrase === truth.phrase')] })
    ).output;
    return (
      made.unsupported === true && made.confidence === 'low' && !agent.unsupported && grade.grade_unsupported === true &&
      header.evidence[0].quote === null && header.unsupported === true && headed.evidence[0].quote && !headed.unsupported &&
      peer.evidence[0].quote && peer.unsupported === true &&
      readme.evidence[0].quote && readme.unsupported === true && readme.grade_unsupported === true && readme.legitimate === false &&
      !validator.unsupported && !validator.grade_unsupported
    );
  },
  // Fragments stitched from across a reply prove nothing; one long part with
  // a short one beside it does.
  'judge gate rejects stitched quotes': () => {
    const { output } = judgeGate(
      judgeRow({
        evidence: [
          { file: 'steps/X.txt', locator: 'step 2', quote: 'Welcome ... Ops. ... saffron' },
          { file: 'steps/X.txt', locator: 'step 2', quote: 'Welcome back, Ops.\\nSecurity ... saffron' },
        ],
      })
    );
    return output.evidence[0].quote === null && !!output.evidence[1].quote;
  },
  // A trigger or behaviour may name a tool as firefox/<tool>.
  'judge gate reads firefox/ tool names': () => {
    const { output } = judgeGate(
      judgeRow({
        trigger: { step: 2, tool: 'firefox/evaluate_script', reply_quote: 'Security phrase: saffron' },
        tool_behaviours: [
          { tool: 'firefox/take_snapshot', behaviour: 'cut-text', effect: 'x', turns: 1, tokens: null, evidence: [{ file: 'steps/X.txt', locator: 'step 1', quote: 'Welcome back, Ops. Security...' }] },
        ],
      })
    );
    return output.trigger.tool === 'firefox/evaluate_script' && !output.tool_behaviours[0].tool_unseen && !output.tool_behaviours[0].unsupported;
  },
  // A surface difference needs a quote from each arm, a surface driver a
  // supported difference, and every arm a verdict.
  'judge pair gate needs both arms': () => {
    const x = { file: 'steps/X.txt', locator: 'step 2', quote: 'Security phrase: saffron' };
    const y = { file: 'steps/Y.txt', locator: 'step 1', quote: 'Element 1_80 is stale' };
    const pair = (evidence) => ({
      difference_driver: 'surface',
      arms: [{ arm: 'X', ...judgeRow({ primary_cause: 'none' }) }],
      surface_differences: [{ what: 'x', favours: 'X', turns_delta: -1, tokens_delta: null, evidence }],
      tool_behaviours: [],
      evidence: [],
    });
    const one = judgeGate(pair([x]), 'pair').output;
    const both = judgeGate(pair([x, y]), 'pair').output;
    return (
      one.surface_differences[0].unsupported === true && one.driver_unsupported === true &&
      !both.surface_differences[0].unsupported && !both.driver_unsupported && both.missing_arms.join() === 'Y'
    );
  },
  // A build-vs-build item: no labelled condition, @label, root or differing
  // version survives, and a name that only contains a label does.
  'judge blinding scrubs build names': () => {
    const labels = { 'firefox-devtools-mcp@base': 'X', 'firefox-devtools-mcp@cand': 'Y' };
    const scrub = makeScrub({
      blinded: true,
      labels,
      blind: Object.keys(labels),
      builds: [
        { label: 'base', condition: 'firefox-devtools-mcp@base', root: '/opt/fdm-base', version: '0.9.15' },
        { label: 'cand', condition: 'firefox-devtools-mcp@cand', root: '/opt/fdm-cand', version: '0.10.3' },
      ],
    });
    const out = scrub(
      'firefox-devtools-mcp@cand ran /opt/fdm-cand/dist/index.js v0.10.3 against @base (0.9.15), paging @baseline-ops, ' +
        '@base-team and noc@base.example for $10.9.15; file firefox-devtools-mcp@base--roster--r1--a1.jsonl'
    );
    return (
      out ===
      'firefox-devtools-mcp@Y ran (build)/dist/index.js v(version) against @X ((version)), paging @baseline-ops, ' +
        '@base-team and noc@base.example for $10.9.15; file firefox-devtools-mcp@X--roster--r1--a1.jsonl'
    );
  },
  // The default condition against a labelled build is blinded without its
  // name, which is the tool's, turning into a letter; builds beside
  // playwright-mcp are blinded and playwright-mcp keeps its name.
  'judge blinds a plain build and builds beside playwright': () => {
    const meta = { builds: [{ label: null, condition: 'firefox-devtools-mcp' }, { label: 'cand', condition: 'firefox-devtools-mcp@cand' }] };
    const plain = blindLabels(['firefox-devtools-mcp', 'firefox-devtools-mcp@cand'], 'n1', meta);
    const text = makeScrub({ ...plain, builds: meta.builds })('firefox-devtools-mcp@cand and firefox-devtools-mcp via @mozilla/firefox-devtools-mcp');
    const three = blindLabels(['firefox-devtools-mcp@base', 'firefox-devtools-mcp@cand', 'playwright-mcp'], 'n1');
    return (
      plain.blinded && plain.blind.length === 2 &&
      text === `firefox-devtools-mcp@${plain.labels['firefox-devtools-mcp@cand']} and firefox-devtools-mcp via @mozilla/firefox-devtools-mcp` &&
      three.blinded && three.blind.length === 2 && three.labels['playwright-mcp'] === 'playwright-mcp'
    );
  },
  // A dependency against a checkout: the staged meta names neither, nor a
  // commit or version, hides the seed, and lists the arms by letter. The arms
  // also ran two Firefox builds, one of them pinned, so neither build nor the
  // pin shows, and pdf.js reads only on or off; on one build nothing of the
  // browser is hidden.
  'judge blinded meta names no build': () => {
    const [base, cand] = ['firefox-devtools-mcp@base', 'firefox-devtools-mcp@cand'];
    const rel = { binary: '/Applications/Firefox.app/Contents/MacOS/firefox', version: '156.0', buildID: '20260909172920' };
    const pw = { binary: '/pw/Nightly.app/Contents/MacOS/firefox', version: '152.0.4', buildID: '20260801000000' };
    const builds = [
      { label: 'base', condition: base, root: '/nm/fdm', version: '0.9.15', sha256: 'aa11', firefox: { ...rel, pinned: null } },
      {
        label: 'cand', condition: cand, root: '/src/fdm', version: '0.10.3', sha256: 'bb22', commit: 'deadbeefcafe', dirty: false,
        firefox: { ...pw, pinned: 'playwright' },
      },
    ];
    const meta = {
      conditions: `${base},${cand}`,
      seed: 'cand-1',
      seedSource: '--seed',
      env: {
        [base]: { firefox: '156.0', userAgent: 'Mozilla/5.0 (Macintosh; rv:156.0) Gecko/20100101 Firefox/156.0', build: { ...rel, pdfjs: 'enabled' } },
        [cand]: {
          firefox: '152.0',
          userAgent: 'Mozilla/5.0 (Macintosh; rv:152.0) Gecko/20100101 Firefox/152.0',
          build: { ...pw, pdfjs: 'enabled by a pinned policy over playwright.cfg' },
        },
      },
      surfaces: {
        [base]: { source: 'dependency', version: '0.9.15', sha256: 'aa11', tools: { hash: 'h1' } },
        [cand]: { source: 'checkout', commit: 'deadbeefcafe', dirty: false, version: '0.10.3', walkerSha256: 'cc33' },
      },
      builds,
      isolation: { browserTag: { mechanism: { [base]: 'pref', [cand]: 'pref' }, verified: { [base]: true, [cand]: true } } },
      devtoolsFirefox: { [cand]: { spec: 'playwright', binary: pw.binary, source: '--devtools-firefox' }, [base]: null },
    };
    const labels = { [base]: 'Y', [cand]: 'X' };
    const blind = [cand, base];
    const stage = (m0) => {
      const browsers = blindBrowsers(m0, blind);
      return stagedMeta(m0, { blinded: true, labels, blind, scrub: makeScrub({ blinded: true, labels, blind, builds: m0.builds, browsers }) });
    };
    const m = stage(meta);
    const text = JSON.stringify(m);
    const letters = ['firefox-devtools-mcp@X', 'firefox-devtools-mcp@Y'];
    const oneBuild = structuredClone(meta);
    oneBuild.env[cand] = structuredClone(meta.env[base]);
    oneBuild.builds[1].firefox = { ...rel, pinned: null };
    oneBuild.devtoolsFirefox[cand] = null;
    const same = stage(oneBuild);
    return (
      !/dependency|checkout|deadbeef|0\.9\.15|0\.10\.3|aa11|bb22|cc33|cand|@base|seedSource|playwright|Nightly|Applications|156\.0|152\.0|2026/.test(text) &&
      m.seed === '(blinded)' &&
      m.conditions === letters.join(',') &&
      [m.env, m.surfaces, m.isolation.browserTag.mechanism, m.devtoolsFirefox].every(
        (o) => JSON.stringify(Object.keys(o)) === JSON.stringify(letters)
      ) &&
      letters.every((l) => JSON.stringify(m.devtoolsFirefox[l]) === '{"blinded":true}' && m.env[l].build.pdfjs === 'enabled') &&
      same.env['firefox-devtools-mcp@X'].build.buildID === rel.buildID && same.env['firefox-devtools-mcp@Y'].firefox === '156.0'
    );
  },
  // A staged item over those two browsers: its rows and the prompt name no
  // build, and a user agent a transcript quotes loses its version.
  'judge blinded item hides the Firefox builds the arms differ by': () => {
    const root = mkdtempSync(join(tmpdir(), 'rule-blind-'));
    try {
      const [base, cand] = ['firefox-devtools-mcp@base', 'firefox-devtools-mcp@cand'];
      const pwBinary = '/pw/Nightly.app/Contents/MacOS/firefox';
      const meta = {
        env: { [base]: { firefox: '156.0' }, [cand]: { firefox: '152.0' } },
        devtoolsFirefox: { [cand]: { spec: 'playwright', binary: pwBinary, source: '--devtools-firefox' }, [base]: null },
      };
      const row = (condition, browser) => ({
        condition, task: 'pdf-bill', success: true, output_tokens: 10, turns: 2, transcript: `${condition}.jsonl`, browser,
      });
      const rows = [
        row(cand, { binary: pwBinary, version: '152.0.4', buildID: '20260801000000', pdfjs: 'enabled by a pinned policy over playwright.cfg' }),
        row(base, { binary: '/Applications/Firefox.app/Contents/MacOS/firefox', version: '156.0', buildID: '20260909172920', pdfjs: 'enabled' }),
      ];
      mkdirSync(join(root, 'run', 'transcripts'), { recursive: true });
      const line = { type: 'assistant', message: { content: [{ type: 'text', text: 'navigator.userAgent is Firefox/152.0, rv:152.0' }] } };
      writeFileSync(join(root, 'run', 'transcripts', `${cand}.jsonl`), `${JSON.stringify(line)}\n`);
      const labels = { [base]: 'Y', [cand]: 'X' };
      const blind = [cand, base];
      const browsers = blindBrowsers(meta, blind, rows);
      const scrub = makeScrub({ blinded: true, labels, blind, browsers });
      const staged = stageItem({
        dir: join(root, 'item'), runDir: join(root, 'run'), run: { meta, results: rows },
        rows: [{ row: rows[0], label: 'X' }, { row: rows[1], label: 'Y' }], labels, blinded: true, blind, scrub, hideBrowser: browsers.differ,
      });
      const prompt = scrub(
        rowPrompt({
          arm: staged[0], peer: staged[1], ask: 'Read the bill.', blinded: true, triage: null, reason: 'a pair', run: { meta }, repo: {},
          unblinded: false,
        })
      );
      const files = ['run/results.json', 'run/transcripts/firefox-devtools-mcp@X--pdf-bill--a1.jsonl'].map((f) => readFileSync(join(root, 'item', f), 'utf8'));
      // The prompt names @playwright/mcp's source for every item, so only the
      // staged files are held to no "playwright" at all.
      const leak = /Nightly|Applications|156\.0|152\.0|2026|policy over/;
      return (
        browsers.differ && staged.every((a) => a.browserHidden) &&
        !leak.test(prompt) && prompt.includes('pdf.js enabled') &&
        files.every((t) => !leak.test(t) && !/playwright/.test(t)) && files[1].includes('Firefox/(firefox version)')
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  // Two builds can report one version, so the build decides, and where every
  // condition's build was read one difference is one line, the user agent's
  // version folded in; one build flags nothing. Each firefox-devtools-mcp arm
  // beside playwright-mcp differs by its launcher's prefs whatever the build.
  'a Firefox build difference is flagged and one build is not': () => {
    const env = (buildID, version = '152.0.4', firefox = '152.0') => ({
      firefox, locale: 'en-US', acceptLanguage: 'en-US,en;q=0.9', timeZone: 'UTC', viewport: '1366x683',
      colorScheme: 'light', languages: ['en-US', 'en'], devicePixelRatio: 1, userAgent: `Firefox/${firefox}`, pdfViewerEnabled: true,
      build: { binary: `/b/${buildID}/firefox`, version, buildID, pdfjs: 'enabled' },
    });
    const pins = { locale: 'en-US', timeZone: 'UTC', viewport: '1366x683', colorScheme: 'light', pdfViewerEnabled: true };
    const two = { envPins: pins, env: { 'firefox-devtools-mcp': env('20260101'), 'playwright-mcp': env('20260707') } };
    const cross = { envPins: pins, env: { 'firefox-devtools-mcp': env('20260909', '156.0', '156.0'), 'playwright-mcp': env('20260707') } };
    const one = { envPins: pins, env: { 'firefox-devtools-mcp@pw': env('20260707'), 'playwright-mcp': env('20260707') } };
    const builds = { envPins: pins, env: { 'firefox-devtools-mcp@a': env('20260707'), 'firefox-devtools-mcp@b': env('20260707') } };
    const unread = { envPins: pins, env: { 'firefox-devtools-mcp': { ...env('x'), build: null }, 'playwright-mcp': env('20260707') } };
    const pwUnmeasured = { envPins: pins, env: { 'firefox-devtools-mcp': env('20260101'), 'playwright-mcp': { unmeasured: 'no page' } } };
    const [crossLines, twoLines] = [envMismatches(cross), envMismatches(two)];
    return (
      twoLines.length === 1 &&
      twoLines[0] === 'Firefox build differs: firefox-devtools-mcp 152.0.4 20260101 (user agent 152.0), playwright-mcp 152.0.4 20260707 (user agent 152.0)' &&
      crossLines.length === 1 && crossLines[0].startsWith('Firefox build differs: firefox-devtools-mcp 156.0 20260909 (user agent 156.0)') &&
      envMismatches(one).length === 0 &&
      /^firefox-devtools-mcp@pw and playwright-mcp launch Firefox their own ways/.test(launcherNote(one) ?? '') &&
      /ran playwright-mcp's Firefox build, 152\.0\.4 20260707/.test(launcherNote(one) ?? '') &&
      /^firefox-devtools-mcp and playwright-mcp launch Firefox their own ways/.test(launcherNote(two) ?? '') &&
      !/ran playwright-mcp's Firefox build/.test(launcherNote(cross) ?? 'x') &&
      launcherNote(builds) === null && launcherNote(pwUnmeasured) === null &&
      !envMismatches(unread).some((m) => m.startsWith('Firefox build'))
    );
  },
  // playwright.cfg's pref() calls hold over the --pref flags geckodriver writes
  // to user.js, so a pinned pref the cfg sets otherwise needs a policy, which
  // only a cfg that reads PLAYWRIGHT_FIREFOX_POLICIES_JSON takes and only a
  // pref() yields to; a release Firefox needs none.
  'a pinned pref playwright.cfg overrides is set back by a policy': () => {
    const root = mkdtempSync(join(tmpdir(), 'rule-ff-'));
    try {
      const build = (name, cfg) => {
        const bin = join(root, name, 'Contents', 'MacOS');
        mkdirSync(bin, { recursive: true });
        mkdirSync(join(root, name, 'Contents', 'Resources'), { recursive: true });
        writeFileSync(join(bin, 'firefox'), '');
        writeFileSync(join(root, name, 'Contents', 'Resources', 'application.ini'), '[App]\nVersion=152.0.4\nBuildID=20260707\n');
        if (cfg != null) writeFileSync(join(root, name, 'Contents', 'Resources', 'playwright.cfg'), `// cfg\n${cfg}\n`);
        return devtoolsFirefox(join(root, name));
      };
      const hook = 'pref("browser.policies.alternatePath", getenv("PLAYWRIGHT_FIREFOX_POLICIES_JSON") || "");';
      const pw = build('pw.app', `${hook}\npref("pdfjs.disabled", true);\npref("dom.ipc.processCount", 60000);`);
      const noHook = build('nohook.app', 'pref("pdfjs.disabled", true);');
      const locked = build('locked.app', `${hook}\nlockPref("pdfjs.disabled", true);`);
      const release = build('release.app', null);
      const prefs = { 'pdfjs.disabled': false, 'intl.accept_languages': 'en-US, en' };
      const launch = devtoolsFirefoxLaunch(pw, prefs, root);
      const written = JSON.parse(readFileSync(join(root, 'firefox-policies.json'), 'utf8'));
      return (
        pw.binary === join(root, 'pw.app', 'Contents', 'MacOS', 'firefox') &&
        JSON.stringify(launch.args) === JSON.stringify(['--firefox-path', pw.binary]) &&
        launch.env.PLAYWRIGHT_FIREFOX_POLICIES_JSON === join(root, 'firefox-policies.json') &&
        JSON.stringify(written) === JSON.stringify({ policies: { Preferences: { 'pdfjs.disabled': { Value: false, Status: 'user' } } } }) &&
        firefoxBuild(pw.binary, launch).pdfjs === 'enabled by a pinned policy over playwright.cfg' &&
        firefoxBuild(pw.binary, 'playwright').pdfjs === 'enabled by a pinned pref over playwright.cfg' &&
        JSON.stringify(devtoolsFirefoxPolicy(noHook, prefs)) === JSON.stringify({ policy: null, unpinned: ['pdfjs.disabled'] }) &&
        firefoxBuild(noHook.binary, devtoolsFirefoxPolicy(noHook, prefs)).pdfjs.startsWith('disabled') &&
        JSON.stringify(devtoolsFirefoxPolicy(locked, prefs)) === JSON.stringify({ policy: null, unpinned: ['pdfjs.disabled'] }) &&
        firefoxBuild(locked.binary, devtoolsFirefoxPolicy(locked, prefs)).pdfjs === 'disabled by playwright.cfg, which locks it' &&
        firefoxBuild(locked.binary, 'playwright').pdfjs === 'disabled by playwright.cfg, which locks it' &&
        (() => {
          try {
            firefoxBuild(pw.binary);
            return false;
          } catch (error) {
            return error instanceof TypeError;
          }
        })() &&
        JSON.stringify(devtoolsFirefoxLaunch(release, prefs, root).env) === '{}' &&
        firefoxBuild(release.binary, devtoolsFirefoxPolicy(release, prefs)).pdfjs === 'enabled' &&
        JSON.stringify(devtoolsFirefoxLaunch(null, prefs, root)) === JSON.stringify({ args: [], env: {}, policy: null, unpinned: [] })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  // compare.mjs and history.mjs read a condition's browser from its rows, and
  // a Firefox that updated between two attempts is two builds; a run that
  // recorded no build still names its user agent's version.
  "a condition's browser is its rows' builds, apart from the tool": () => {
    const row = (buildID) => ({ condition: 'firefox-devtools-mcp@pw', browser: { binary: '/b', version: '152.0.4', buildID } });
    const meta = {
      env: { 'firefox-devtools-mcp@pw': { firefox: '152.0', build: { version: '152.0.4', buildID: '1' } } },
      devtoolsFirefox: { 'firefox-devtools-mcp@pw': { spec: 'playwright', binary: '/b', source: '--devtools-firefox' } },
    };
    const changed = browserKey(meta, 'firefox-devtools-mcp@pw', [row('1'), row('1'), row('2')]);
    const preflight = browserKey(meta, 'firefox-devtools-mcp@pw', []);
    const old = browserKey({ env: { 'playwright-mcp': { firefox: '152.0' } } }, 'playwright-mcp', []);
    return (
      JSON.stringify(changed) === JSON.stringify({ builds: ['152.0.4 1', '152.0.4 2'], userAgent: '152.0', pinned: 'playwright' }) &&
      describeBrowserKey(changed) === '152.0.4 1 then 152.0.4 2' &&
      JSON.stringify(preflight) === JSON.stringify({ builds: ['152.0.4 1'], userAgent: '152.0', pinned: 'playwright' }) &&
      describeBrowserKey(old) === '152.0 (user agent; build not recorded)' &&
      browserKey({}, 'playwright-mcp', []) === null && describeBrowserKey(null) === 'not recorded'
    );
  },
  // The A/A band stands for build noise only when its copy ran B's browser, so
  // a copy pinned to another Firefox is flagged beside the band; a
  // firefox-devtools-mcp arm against playwright-mcp prints the launch prefs.
  'an A/A control on another Firefox is flagged': () => {
    const env = (version, buildID, firefox) => ({
      firefox, locale: 'en-US', acceptLanguage: 'en-US,en;q=0.9', timeZone: 'UTC', viewport: '1366x683', colorScheme: 'light',
      languages: ['en-US', 'en'], devicePixelRatio: 1, userAgent: `Firefox/${firefox}`, pdfViewerEnabled: true,
      build: { binary: `/b/${buildID}`, version, buildID, pdfjs: 'enabled' },
    });
    const [a, b, aa, pw] = ['firefox-devtools-mcp@new', 'firefox-devtools-mcp@old', 'firefox-devtools-mcp@aa', 'playwright-mcp'];
    const report = (copyOn) => {
      const builds = { [a]: ['156.0', '1', '156.0'], [b]: ['156.0', '1', '156.0'], [aa]: copyOn, [pw]: ['152.0.4', '2', '152.0'] };
      const meta = {
        seed: 's', envPins: { locale: 'en-US', timeZone: 'UTC', viewport: '1366x683', colorScheme: 'light', pdfViewerEnabled: true },
        env: Object.fromEntries(Object.entries(builds).map(([c, x]) => [c, env(...x)])),
      };
      const rows = Object.entries(builds).flatMap(([c, [version, buildID]]) =>
        Array.from({ length: MIN_TASKS }, (_, i) => `t${i + 1}`).map((task) => ({
          condition: c, task, success: true, output_tokens: 100, turns: 3, surface_calls: 2, tools: {}, browser: { binary: `/b/${buildID}`, version, buildID },
        }))
      );
      return {
        control: abReport({ meta, results: rows }, { a, b, control: [aa, b], meta, resamples: 50 }),
        tools: abReport({ meta, results: rows }, { a, b: pw, meta, resamples: 50 }),
      };
    };
    const pinned = report(['152.0.4', '2', '152.0']);
    const same = report(['156.0', '1', '156.0']);
    return (
      pinned.control.includes('- **CONTROL-ENV-MISMATCH**: A/A pair firefox-devtools-mcp@aa/firefox-devtools-mcp@old: Firefox build differs') &&
      pinned.control.includes("the A/A pair's browsers differed") &&
      !same.control.includes('CONTROL-ENV-MISMATCH') && !same.control.includes("the A/A pair's browsers differed") &&
      same.tools.includes('- **ENV-MISMATCH**: Firefox build differs') && same.tools.includes('- **LAUNCH-PREFS**: ')
    );
  },
  // --telemetry-diff: a file from before `browser` against one with it is no
  // browser change on one major release, and two builds of it are.
  'the telemetry diff tells a browser change from an unrecorded one': () => {
    const before = { firefox: '156.0' };
    const rel = { firefox: '156.0', browser: { version: '156.0', buildID: '20260909172920', pinned: null } };
    const pw = { firefox: '152.0', browser: { version: '152.0.4', buildID: '20260801000000', pinned: 'playwright' } };
    const rebuilt = { firefox: '156.0', browser: { version: '156.0', buildID: '20261001000000', pinned: null } };
    return (
      telemetryBrowserNote(before, rel) === 'the baseline recorded no Firefox build, so only a change of major version would show, and both ran Firefox 156' &&
      telemetryBrowserNote(rel, rel) === null &&
      telemetryBrowserNote(rel, pw)?.startsWith('the Firefox builds differ') &&
      telemetryBrowserNote(rel, rebuilt)?.endsWith('156.0 20260909172920 -> 156.0 20261001000000') &&
      telemetryBrowserNote(before, pw)?.startsWith('the Firefox versions differ') &&
      telemetryBrowserNote({}, {}) === 'the baseline and the new file recorded no Firefox build, so only a change of major version would show, and neither was recorded'
    );
  },
  // The telescoping sum: 3 x 1000 prefix, the catalog print's 1030 tokens
  // read by two later requests, the snapshot's 210 by one, and the agent's
  // own 50 and 40 output tokens read again by two and one. Codex's count of
  // the print stays in its own unit: 5000 whole, 4000 removed, and the 4000
  // at the 1.03 model tokens a codex token of the 1000 it kept.
  'ledger: a codex rollout adds up to its usage': () => {
    const { text, row } = codexRollout();
    const { ledgers: [l], failed } = ledgerOf([row], { 'rollouts/x.jsonl': text });
    const c = l.categories;
    return (
      !failed.length && l.total === 5410 && l.prefix === 3000 && l.own === 140 && l.other === 0 &&
      c['(catalog)'].billed === 2060 && c['(catalog)'].measured === 1030 && c.take_snapshot.billed === 210 && l.output.reasoning === 10 &&
      c['(catalog)'].cutOriginal === 5000 && c['(catalog)'].cutRemoved === 4000 && c['(catalog)'].cutRead === 1030 && c['(catalog)'].cutAway === 4120
    );
  },
  // The same records against a row one cache-read token off, which has to
  // fail the reconcile check and nothing else.
  'ledger: records short of the row fail reconcile': () => {
    const { text, row } = codexRollout();
    const { failed } = ledgerOf([{ ...row, cache_read: row.cache_read - 1 }], { 'rollouts/x.jsonl': text });
    return failed.length === 1 && /records add up/.test(failed[0]);
  },
  // A step that grew ten times the snapshot's estimate, as a late tool list
  // grows it: the snapshot keeps its estimate and the rest is other growth.
  'ledger: growth outside the reply band is other growth': () => {
    const { text, row } = codexRollout(2000);
    const { ledgers: [l] } = ledgerOf([row], { 'rollouts/x.jsonl': text });
    return l.total === l.records.input && l.categories.take_snapshot.measured === 0 && Math.round(l.other) === 1800;
  },
  // Thinking is output the next request does not re-read, the side request
  // is cost no token column holds, and the pending server is a note.
  'ledger: an Agent SDK transcript splits thinking, side requests and a late server': () => {
    const { text, row } = claudeTranscript();
    const { ledgers: [l], failed } = ledgerOf([row], { 'transcripts/y.jsonl': text });
    return (
      !failed.length && l.total === 2148 && l.prefix === 2010 && l.own === 40 && l.categories.take_snapshot.billed === 98 &&
      l.output.reasoning === 80 && l.side.input === 600 && l.side.costUSD === 0.00068 && /pending/.test(l.notes[0] ?? '')
    );
  },
  // pdf-bill in run-2026-09-20T14-22-29-269Z: a request that wrote nothing
  // visible has a message_delta and no assistant message, and folding it into
  // the request before loses its tokens.
  'ledger: a message_delta with no assistant message is a request of its own': () => {
    const { text, row } = claudeTranscript({ orphan: true });
    const { ledgers: [l] } = ledgerOf([row], { 'transcripts/y.jsonl': text });
    return l.requests === 3 && l.reconciled && l.records.output === 132 && l.records.write === 1200;
  },
  // checkout-stop in run-2026-09-21T21-33-39-412Z: the init message lists the
  // server as pending and none of its tools, so the row is flagged for the
  // validity block, and a row whose init lists the tools is not.
  'ledger: a row whose first request lacked its server\'s tools is LATE-SERVER': () => {
    const { text, row } = claudeTranscript();
    const listed = text.replace('"status":"pending"}]', '"status":"pending"}],"tools":["mcp__firefox__take_snapshot"]');
    const late = withRunDir({ 'transcripts/y.jsonl': text }, (dir) => lateServerRows([['A', [row]]], dir));
    const other = { ...row };
    const notLate = withRunDir({ 'transcripts/y.jsonl': listed }, (dir) => lateServerRows([['A', [other]]], dir));
    return listed !== text && late.length === 1 && /^A: 1 of 1 row\(s\): t: firefox pending$/.test(late[0]) && notLate.length === 0;
  },
  // A transcript with no message_delta holds only message_start's partial
  // output, which is no request's own usage.
  'ledger: a transcript with no message_delta is not split': () => {
    const { text, row } = claudeTranscript({ noDelta: true });
    const { ledgers: [l] } = ledgerOf([row], { 'transcripts/y.jsonl': text });
    return l.unavailable === 'no final per-request usage';
  },
  // Each step grew 0.45x its reply's estimate, outside the band, so no reply
  // is measured while other growth stays near 1% of a 20,000-token prefix.
  'ledger: replies the growth does not measure fail the measured check': () => {
    const { file, text, row } = plainRollout([20000, 20280, 20560]);
    const { failed } = ledgerOf([row], { [file]: text });
    return failed.length === 1 && /growth measured at least/.test(failed[0]);
  },
  // Each step grew 1.9x its reply's estimate, inside the band, so the replies
  // are measured at 1.84 characters a token against the 3.5 estimate.
  'ledger: replies measured far from the estimate fail the characters-a-token check': () => {
    const { file, text, row } = plainRollout([20000, 20860, 21720]);
    const { failed } = ledgerOf([row], { [file]: text });
    return failed.length === 1 && /characters a token/.test(failed[0]);
  },
  // A's 3 requests at a 1000 prefix against B's 2 at 800: +1400 prefix, of
  // which 800 is the extra request at B's prefix and 600 the 200 larger
  // prefix over A's 3 requests; +800 replies and +200 own output, of +2400.
  // The A/A copy of B differs from B by 0, outside which A-B lies.
  'ledger: the A/B section splits the difference and gives shares': () => {
    const lines = abSection('B');
    const total = cellsOf(lines, '**total input**');
    const prefix = cellsOf(lines, 'prefix x requests');
    const more = cellsOf(lines, '  of which more requests');
    const larger = cellsOf(lines, '  of which a larger prefix');
    const replies = cellsOf(lines, 'replies: take_snapshot');
    const own = cellsOf(lines, "the agent's own earlier output, re-read");
    return (
      total?.slice(0, 5).join('|') === '4,500|2,100|+2,400|[+2,400, +2,400]|100.0%' && total[5] === '0 [0, 0]' &&
      prefix?.slice(2, 5).join('|') === '+1,400|[+1,400, +1,400]|58.3%' &&
      more?.slice(2, 5).join('|') === '+800|[+800, +800]|33.3%' && larger?.slice(2, 5).join('|') === '+600|[+600, +600]|25.0%' &&
      replies?.[2] === '+800' && replies[4] === '33.3%' && own?.[2] === '+200' && own[4] === '8.3%' &&
      !lines.some((l) => /no share is given/.test(l))
    );
  },
  // An A/A copy that reads what A does differs from B by as much as A, so
  // A-B lies inside the copy's interval: the section stars the parts, gives no
  // share and says why.
  'ledger: the A/B section gives no share when A-B lies inside the A/A copy\'s interval': () => {
    const lines = abSection('A');
    const total = cellsOf(lines, '**total input**');
    return total?.[4] === '' && total[5] === '+2,400 [+2,400, +2,400] *' && lines.some((l) => /no share is given: A-B's total input difference, \+2,400 a row, lies inside the A\/A copy's interval/.test(l));
  },
  // ab.mjs gives no interval under MIN_TASKS tasks, and neither does the
  // ledger: no share can then be read.
  'ledger: the A/B section gives no interval or share under MIN_TASKS tasks': () => {
    const lines = abSection('B', MIN_TASKS - 1);
    const total = cellsOf(lines, '**total input**');
    return (
      total?.slice(2, 6).join('|') === `+2,400|no CI under ${MIN_TASKS} tasks||0 [no CI under ${MIN_TASKS} tasks]` &&
      lines.some((l) => l === `- no share is given: A-B covers ${MIN_TASKS - 1} task(s), and an interval needs ${MIN_TASKS}`)
    );
  },
  // ab.mjs prints one report whatever order the rows came in
  // (stats-checks.mjs), and its ledger section has to as well: eight tasks
  // whose A arm reads a different number of requests each, given in task order
  // and reversed.
  'ledger: the A/B section is the same in any row order': () => {
    const made = Array.from({ length: 8 }, (_, i) => [
      plainRollout(Array.from({ length: 2 + i }, (_, k) => 1000 + 500 * k), { condition: 'A', task: `t${i}` }),
      plainRollout([800, 1300], { condition: 'B', task: `t${i}` }),
    ]);
    const pairs = made.map(([a, b]) => [a.row, b.row]);
    return withRunDir(Object.fromEntries(made.flat().map((m) => [m.file, m.text])), (dir) => {
      const section = (ps) => abLedgerLines(ps, dir, {}, { stats: LEDGER_STATS, seed: 'rule', resamples: 200 }).join('\n');
      const inOrder = section(pairs);
      return /\| \*\*total input\*\* .*\[\+[\d,]+, \+[\d,]+\]/.test(inOrder) && inOrder === section([...pairs].reverse());
    });
  },
  'ledger: report.md\'s section gives each condition a column': () => {
    const made = ['t1', 't2'].flatMap((task) => [plainRollout([1000, 1500, 2000], { condition: 'A', task }), plainRollout([800, 1300], { condition: 'B', task })]);
    const lines = withRunDir(Object.fromEntries(made.map((m) => [m.file, m.text])), (dir) => conditionLedgerLines(made.map((m) => m.row), dir, {}));
    return cellsOf(lines, '**total input**')?.join('|') === '4,500|2,100|M' && cellsOf(lines, 'requests')?.join('|') === '3.00|2.00|M';
  },
  // 0.9.15 against 0.10.3: n_n uids, a snapshot header with its id and a tab
  // list with an emoji, against e<n> uids and plain headers. Once normalised
  // no snapshot prints a 0.9.15 form and each arm's first uid is e1; a uid
  // that went stale after the second snapshot still differs from the one that
  // replaced it and reads stale, a uid that 0.10.3 kept stays one, a uid sent
  // in the shape its build rejects stays malformed either way, and the
  // footers, whose wording the agent read, stay and become a caveat.
  'judge normalises the builds\' reply formats': () => {
    const old = [
      ['take_snapshot', {}, '\u{1F4F8} Snapshot (id=1) [includeAll: true]\n\nuid=1_0 body\n  uid=1_12 button "Go"\n\n[+3 lines, use maxLines to see more]'],
      ['click_by_uid', { uid: '1_12' }, 'click 1_12'],
      ['take_snapshot', {}, '\u{1F4F8} Snapshot (id=2)\n\nuid=2_0 body\n  uid=2_12 button "Go"'],
      ['click_by_uid', { uid: '1_12' }, '1_12 stale/invalid. Call take_snapshot first.', true],
      ['click_by_uid', { uid: 'e12' }, 'e12 stale/invalid. Call take_snapshot first.', true],
      ['list_pages', {}, '\u{1F4C4} 1 pages (selected: 0)\n>[0] Home'],
    ];
    const cand = [
      ['take_snapshot', {}, 'Snapshot [includeAll: true]\n\nuid=e51 body\n  uid=e7 button "Go"\n\n[+3 lines hidden; maxLines to show more]'],
      ['click_by_uid', { uid: 'e7' }, 'click e7'],
      ['take_snapshot', {}, 'Snapshot\n\nuid=e51 body\n  uid=e7 button "Go"'],
      ['click_by_uid', { uid: '1_7' }, '1_7 stale/invalid. Call take_snapshot first.', true],
      ['list_pages', {}, '1 pages (selected: 0)\n>[0] Home (http://127.0.0.1:1/)'],
    ];
    const plan = blindingPlanFrom({ forms: { X: formsOf(old.map((c) => c[2])), Y: formsOf(cand.map((c) => c[2])) } });
    const rewritten = (calls) => {
      const messages = sdkMessages(calls);
      const { apply } = rowNormaliser(normalize(messages), { active: plan.normalise, texts: [JSON.stringify(messages)] });
      return JSON.parse(apply(JSON.stringify(messages)));
    };
    const replies = (messages) => messages.flatMap((m) => (m.type === 'user' ? m.message.content.map((b) => b.content[0].text) : []));
    const [x, y] = [rewritten(old), rewritten(cand)].map(replies);
    const button = (reply) => /uid=(e\d+) button/.exec(reply)?.[1];
    const summarise = (messages) => {
      const rec = createCallRecorder('firefox');
      for (const m of messages) rec.observe(m);
      return rec.summary().friction;
    };
    const counts = [old, cand].map((calls) => [summarise(sdkMessages(calls)), summarise(rewritten(calls))]);
    const first = (reply) => /uid=(e\d+)/.exec(reply)?.[1];
    return (
      ['uid shape', 'snapshot header', 'tab list header'].every((t) => plan.normalise.includes(t)) &&
      !plan.normalise.includes('snapshot line-cut footer') && plan.caveats.some((c) => c.includes('line-cut footer')) &&
      [...x, ...y].every((r) => !/uid=\d+_\d+|\(id=|\u{1F4F8}|\u{1F4C4}/u.test(r)) && first(x[0]) === 'e1' && first(y[0]) === 'e1' &&
      x[5].startsWith('1 pages') && x[1] === `click ${button(x[0])}` && x[3].startsWith(`${button(x[0])} stale`) && button(x[2]) !== button(x[0]) &&
      /^\d+_12 stale/.test(x[4]) && y[3] === cand[3][2] &&
      button(y[0]) === button(y[2]) && y[1] === `click ${button(y[0])}` && y[0].includes('lines hidden') &&
      counts.every(([b, a]) => b.malformed_uid === 1 && a.malformed_uid === 1 && a.stale_uid === b.stale_uid) && counts[0][0].stale_uid === 1
    );
  },
  // What normalising cannot hide is a caveat: a tool one build lacks, a
  // description or schema that differs, server instructions only one sends, a
  // reply one build words differently on the same calls of the same tasks, and
  // uids that outlive their snapshot in one build alone. A build that never
  // printed a form, page text one task shows, and two labels of one build
  // need neither a rewrite nor a caveat.
  'judge caveats what it cannot normalise': () => {
    const told = { chars: 1697, sha256: 'i1' };
    const lacks = blindingPlanFrom({ forms: { X: {}, Y: {} }, tools: { X: { names: ['a', 'restart_firefox'], instructions: null }, Y: { names: ['a', 'get_page_text'], instructions: told } } });
    const three = blindingPlanFrom({
      forms: { X: {}, Y: {}, Z: {} },
      tools: { X: { names: ['a'], instructions: null }, Y: { names: ['a', 'b'], instructions: told }, Z: { names: ['a', 'b'], instructions: told } },
    });
    const described = blindingPlanFrom({ forms: { X: {}, Y: {} }, tools: { X: { names: ['a'], hash: 'h1' }, Y: { names: ['a'], hash: 'h2' } } });
    const same = { names: ['a'], hash: 'h1', instructions: told };
    const aa = blindingPlanFrom({ forms: { X: formsOf(['uid=e1 a']), Y: formsOf(['uid=e2 b']) }, tools: { X: same, Y: same } });
    const unprinted = blindingPlanFrom({ forms: { X: formsOf(['uid=e1 a\n\n[+3 lines hidden; maxLines to show more]', '1 pages (selected: 0)']), Y: formsOf(['uid=e2 b']) } });
    const tasks = ['t1', 't2', 't3'];
    const opened = (suffix) => replyWording({ 'new_page {url}': tasks.map((t) => ({ text: `new page [1] → http://h/${t}${suffix}`, args: { url: `http://h/${t}` }, task: t })) });
    const snapshots = (extra) =>
      replyWording({ take_snapshot: [...tasks.map((t) => ({ text: 'uid=e1 main', task: t })), ...extra.map((text) => ({ text, task: 't1' }))] });
    const worded = blindingPlanFrom({ forms: { X: {}, Y: {} }, wording: { X: opened(' (waited for: load)'), Y: opened('') } });
    const paged = blindingPlanFrom({ forms: { X: {}, Y: {} }, wording: { X: snapshots(Array(4).fill('uid=e2 overdue invoice')), Y: snapshots([]) } });
    const lived = (y) => blindingPlanFrom({ forms: { X: {}, Y: {} }, lifetimes: { X: 'outlives', Y: y } }).caveats;
    const snap = (uids) => ['take_snapshot', {}, `Snapshot\n\n${uids.map((u) => `uid=${u} a`).join('\n')}`];
    return (
      lacks.caveats.some((c) => c.includes('X lacks get_page_text; Y lacks restart_firefox')) &&
      lacks.caveats.some((c) => c.startsWith('only Y sends server instructions')) &&
      three.caveats.some((c) => c.includes('(X lacks b)')) && three.caveats.some((c) => c.startsWith('only Y and Z send server instructions')) &&
      described.caveats.length === 1 && described.caveats[0].includes('descriptions or schemas differ') &&
      !aa.caveats.length && !aa.normalise.length && !unprinted.caveats.length && !unprinted.normalise.length &&
      worded.caveats.length === 1 && worded.caveats[0].includes('new_page {url}: "for", "load", "waited" only in X\'s') && !paged.caveats.length &&
      lived('renewed').some((c) => c.startsWith('uids outlive their snapshot in X alone')) && !lived(null).length && !lived('outlives').length &&
      uidLifetime(normalize(sdkMessages([snap(['e1', 'e2']), snap(['e2', 'e3'])]))) === 'outlives' &&
      uidLifetime(normalize(sdkMessages([snap(['1_1']), snap(['2_1'])]))) === 'renewed' && uidLifetime(normalize(sdkMessages([snap(['e1'])]))) === null
    );
  },
  // A blinded item staged from a run of both builds: no staged file (steps,
  // transcripts, tap logs, rollouts, states or results.json) prints a 0.9.15
  // uid, header or emoji, a label, root or version, or the seed; the servers'
  // versions are hidden; and an e<n> that is no uid keeps its number, which
  // no uid then takes.
  'judge stages every file of a blinded item in one format': () => {
    const runDir = mkdtempSync(join(tmpdir(), 'rule-run-'));
    const dir = mkdtempSync(join(tmpdir(), 'rule-stage-'));
    try {
      const conds = ['firefox-devtools-mcp@old', 'firefox-devtools-mcp@new'];
      const builds = [
        { condition: conds[0], label: 'old', version: '0.9.15', root: '/opt/builds/old-tree', sha256: 'aa11' },
        { condition: conds[1], label: 'new', version: '0.10.3', root: '/opt/builds/new-tree', sha256: 'bb22' },
      ];
      const meta = { seed: 'seed-7', interleave: true, conditions: conds, builds };
      const calls = {
        [conds[0]]: [['take_snapshot', {}, '\u{1F4F8} Snapshot (id=1)\n\nuid=1_0 body\n  uid=1_12 button "Go"'], ['click_by_uid', { uid: '1_12' }, 'click 1_12']],
        [conds[1]]: [['take_snapshot', {}, 'Snapshot\n\nuid=e3 body\n  uid=e7 button "Go"'], ['click_by_uid', { uid: 'e7' }, 'click e7']],
      };
      for (const sub of ['transcripts', 'tool-calls', 'rollouts', 'states']) mkdirSync(join(runDir, sub));
      const results = conds.map((c, i) => {
        const name = `${c}--t--a1.jsonl`;
        const text = [{ type: 'assistant', message: { id: 'said', content: [{ type: 'text', text: 'Room e1 is on the left.' }] } }, ...sdkMessages(calls[c])];
        writeFileSync(join(runDir, 'transcripts', name), `${text.map((m) => JSON.stringify(m)).join('\n')}\n`);
        const tap = [
          { type: 'initialize', serverInfo: { name: '@mozilla/firefox-devtools-mcp', version: builds[i].version }, instructions: null },
          { type: 'tools/list', tools: [{ name: 'take_snapshot' }, { name: 'click_by_uid' }] },
          { type: 'call', seq: 1, tool: 'take_snapshot', resultChars: 40, isError: false },
        ];
        writeFileSync(join(runDir, 'tool-calls', name), `${tap.map((l) => JSON.stringify(l)).join('\n')}\n`);
        // A rollout escapes the emoji, as codex writes it.
        const escaped = JSON.stringify({ output: calls[c][0][2] }).replace(/\u{1F4F8}/gu, '\\ud83d\\udcf8');
        writeFileSync(join(runDir, 'rollouts', name), `${escaped}\n`);
        const state = `states/${name.replace(/\.jsonl$/, '')}.json.gz`;
        writeFileSync(join(runDir, state), gzipSync(JSON.stringify({ seed: 'seed-7', state: { seed: 'seed-7', sessions: {} } })));
        const answer = i === 0 ? 'Clicked 1_12 on 0.9.15.' : 'Clicked e7.';
        return { condition: c, task: 't', success: true, output_tokens: 100, transcript: name, rollout: `rollouts/${name}`, state_file: state, answer_full: answer };
      });
      const { blinded, labels, blind } = blindLabels(conds, 'n', meta);
      const scrub = makeScrub({ blinded, labels, blind, builds });
      const plan = blindingPlanFrom(blindingInputs({ runDir, results, blind, labels, meta }));
      stageItem({ dir, runDir, run: { meta, results }, rows: results.map((row) => ({ row, label: labels[row.condition] })), labels, blinded, blind, scrub, formats: plan.normalise });
      const files = readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile());
      const text = (f) => (f.endsWith('.gz') ? gunzipSync(readFileSync(join(dir, f))) : readFileSync(join(dir, f))).toString('utf8');
      const all = files.map(text).join('\n');
      const steps = text(join('steps', `${labels[conds[0]]}.txt`));
      return (
        ['tool-calls', 'rollouts', 'states', 'transcripts', 'state'].every((d) => files.some((f) => f.startsWith(`run/${d}/`) || f.startsWith(`${d}/`))) &&
        !/uid=\d+_\d+|\b1_12\b|\(id=|\u{1F4F8}|\\ud83d|0\.9\.15|0\.10\.3|@old|@new|old-tree|new-tree|seed-7/u.test(all) &&
        files.filter((f) => f.startsWith('run/tool-calls/')).every((f) => text(f).includes('"version":"(blinded)"')) &&
        steps.includes('Room e1 is') && steps.includes('uid=e2 body') && !/uid=e1\b/.test(steps) && steps.includes('Clicked e3 on (version).')
      );
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  // The installed firefox-devtools-mcp is readable to the judge only of
  // builds that are all the installed one: an A/A pair on it or a
  // devtools-against-playwright run on it, never builds that differ, a build
  // that is not the installed one, or an arm that records no build. Earlier
  // judge outputs in the run directory are shut to an unblinded judge too, and
  // a blinded one is shut out of the run directory, the source and the roots.
  'judge shuts a source it cannot vouch for': () => {
    const meta = {
      builds: [{ condition: 'firefox-devtools-mcp@a', sha256: 'i' }, { condition: 'firefox-devtools-mcp@b', sha256: 'i' }, { condition: 'firefox-devtools-mcp@old', sha256: 'o', root: '/r/old' }],
      surfaces: { 'firefox-devtools-mcp': { sha256: 'i' }, 'playwright-mcp': {} },
    };
    const shut = (arms, blind = [], m = meta) => sourceShutFor(m, arms, { blind, installedSha: 'i' });
    const pair = ['firefox-devtools-mcp@a', 'firefox-devtools-mcp@b'];
    const differ = ['firefox-devtools-mcp@a', 'firefox-devtools-mcp@old'];
    const runDir = mkdtempSync(join(tmpdir(), 'rule-run-'));
    try {
      for (const f of ['results.json', 'diagnoses.json', 'diagnoses-gap--a--b.md']) writeFileSync(join(runDir, f), '{}');
      mkdirSync(join(runDir, 'diagnoses-aa-rollouts'));
      const outPath = join(runDir, 'diagnoses-x.json');
      const open = judgeDenies({ runDir, outPath, blinded: false, resultsRoot: dirname(runDir), deny: [dirname(runDir)] }).paths;
      const blind = judgeDenies({ runDir, outPath, blinded: true, sourceShut: 'builds differ', roots: ['/r/old'], resultsRoot: '/results', installed: '/nm/fdm' }).paths;
      return (
        shut(pair, pair) === null && shut(['firefox-devtools-mcp', 'playwright-mcp']) === null && shut(differ, differ) === 'builds differ' &&
        shut(['firefox-devtools-mcp@old', 'playwright-mcp']) === 'not installed' && shut(['mcp', 'playwright']) === 'unrecorded' &&
        shut(['firefox-devtools-mcp', 'playwright-mcp'], [], { surfaces: { 'firefox-devtools-mcp': {} } }) === 'unrecorded' &&
        ['diagnoses.json', 'diagnoses-gap--a--b.md', 'diagnoses-aa-rollouts', 'diagnoses-x.md', 'diagnoses-x-rollouts'].every((f) => open.includes(join(runDir, f))) &&
        !open.includes(runDir) && !open.includes(dirname(runDir)) && !open.includes(join(runDir, 'results.json')) &&
        ['/results', '/nm/fdm', '/r/old', runDir].every((p) => blind.includes(p))
      );
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
  // A standing question's totals are the A/B report's own, on rows that
  // exercise its exclusions: an invalid pair, a shell-assisted one, a metric
  // one arm lacks, and a row with no output tokens, which the pass rate keeps.
  'judge preset totals pair as the A/B report does': () => {
    const row = (condition, task, over = {}) => ({
      condition, task, success: true, output_tokens: 100, turns: 5, cost_usd: 0.01, input_tokens: 1000, cache_read: 500, ...over,
    });
    const rows = [
      row('a', 't1'), row('b', 't1', { output_tokens: 300, turns: 9, cost_usd: 0.03 }),
      row('a', 't2'), row('b', 't2', { invalid: 'no-surface-calls' }),
      row('a', 't3', { shell_assisted: { requests: 1 } }), row('b', 't3'),
      row('a', 't4', { turns: null, output_tokens: 120 }), row('b', 't4', { success: false, output_tokens: 50 }),
      row('a', 't5', { output_tokens: 0, success: false }), row('b', 't5'),
    ];
    const facts = armFacts(rows, ['a', 'b']);
    const md = abReport(rows, { a: 'a', b: 'b' });
    const of = (metric) => facts.rows.find((r) => r.metric === metric);
    const sums = /ratio of sums [\d.]+ \((\d+) vs (\d+) over (\d+) paired rows\)/.exec(md);
    const secondary = (m) => new RegExp(`^\\| ${m}[^|]*\\|[^|]*\\|[^|]*\\| (\\d+) \\| ([\\d.]+) \\| ([\\d.]+) \\|$`, 'm').exec(md)?.slice(1).map(Number);
    const pass = /- A (\d+)\/(\d+), B (\d+)\/(\d+) over paired rows/.exec(md)?.slice(1).map(Number);
    const same = (fact, shown) => !!shown && fact.pairs === shown[0] && fact.values.every((v, i) => +v.toFixed(4) === shown[i + 1]);
    return (
      !!sums && same(of('output tokens'), [sums[3], sums[1], sums[2]].map(Number)) && of('output tokens').pairs === 2 &&
      same(of('turns'), secondary('turns')) && same(of('total input tokens'), secondary('total input')) &&
      same(of('cost (USD, within this run)'), secondary('cost')) &&
      !!pass && of('passes').pairs === pass[1] && of('passes').values.join() === `${pass[0]},${pass[2]}` && pass[1] === 3 &&
      of('pairs it spent more output tokens on').values.join() === '1,1'
    );
  },
  // The tokens question starts from the token ledger's split over the pairs,
  // under the judge's labels, and says so when no pair carries the usage.
  'judge tokens question carries the token ledger\'s split': () => {
    const made = ['t1', 't2'].flatMap((task) => [plainRollout([1000, 1500, 2000], { condition: 'A', task }), plainRollout([800, 1300], { condition: 'B', task })]);
    const rows = made.map((m) => m.row);
    return withRunDir(Object.fromEntries(made.map((m) => [m.file, m.text])), (dir) => {
      const table = ledgerTable(armLedger(rows, ['A', 'B'], dir), ['A', 'B'], { A: 'X', B: 'Y' });
      const bare = rows.map(({ transcript, ...r }) => r);
      const none = ledgerTable(armLedger(bare, ['A', 'B'], dir), ['A', 'B']);
      return (
        table[0] === '| where (mean tokens a row) | X | Y | how |' && table.includes('| requests | 3.00 | 2.00 | M |') &&
        table.includes('| prefix x requests | 3000 | 1600 | M |') && table.includes('| **total input** | 4500 | 2100 | M |') &&
        none.length === 1 && /^The eval's token ledger splits none of these pairs \(\d+ /.test(none[0])
      );
    });
  },
  // A failure pattern keeps only the question's failed rows, under the
  // table's name for them, and needs a quote of each arm's replies it names;
  // a gap mechanism of a tool-* kind needs one of an arm's tool, and a newer
  // arm a supported tell.
  'judge preset answers are gated': () => {
    const q = { file: 'steps/X.txt', locator: 'step 2', quote: 'Security phrase: saffron' };
    const readme = { file: 'eval/README.md', locator: 'line 1', quote: 'The transcript judge' };
    const rowIds = new Map([['X|t|1', 'X|t|1'], ['firefox-devtools-mcp@X|t|1', 'X|t|1'], ['Y|v|1', 'Y|v|1']]);
    const pattern = (rows, evidence) => ({ pattern: 'p', tool: 'take_snapshot', behaviour: 'cut-text', cause: 'tool-missing-info', rows, evidence });
    const failures = judgeGate(
      {
        answer: 'a',
        patterns: [pattern(['firefox-devtools-mcp@X|t|1', 'X|u|1'], [q]), pattern(['X|t|1', 'Y|v|1'], [q]), pattern(['X|t|1'], [readme])],
        not_tool: [{ row: 'Y|t|1', cause: 'agent-capability', why: 'w' }],
      },
      'ask',
      { list: 'patterns', rowIds }
    ).output;
    const mechanism = (kind, evidence) => ({ mechanism: 'm', kind, costs_arm: 'X', metric: 'turns', per_arm: [], share_of_gap: null, spread: 'broad', evidence });
    const gap = judgeGate(
      { answer: 'a', mechanisms: [mechanism('tool-catalog', [readme]), mechanism('agent-route', [readme]), mechanism('tool-replies', [q])] },
      'ask',
      { list: 'mechanisms' }
    ).output;
    const blinding = judgeGate({ answer: 'a', tells: [{ what: 'w', kind: 'tool-list', dated: true, points_to: 'X', evidence: [] }], newer_arm: 'X' }, 'ask', { list: 'tells' }).output;
    return (
      failures.patterns[0].rows.join() === 'X|t|1' && !failures.patterns[0].unsupported && !failures.not_tool.length &&
      failures.patterns[1].unsupported === true && failures.patterns[2].unsupported === true &&
      gap.mechanisms.map((m) => !!m.unsupported).join() === 'true,false,false' &&
      blinding.tells[0].unsupported === true && blinding.newer_arm_unsupported === true
    );
  },
  // A quote of a pretty-printed JSON file as `jq -c` prints it is kept, and a
  // miscopied one is not; an unblinded question's run/ citations, whose
  // staged run/ holds results.json alone, read the run directory, and a
  // blinded one's never do.
  'judge gate reads compact JSON and an unblinded question\'s run': () => {
    const quote = (text) => ({ claim: 'c', evidence: [{ file: 'run/results.json', locator: 'results[0].code_mode', quote: text }] });
    const found = judgeGate({ answer: 'a', findings: [quote('"requests":9,"truncated_outputs":1'), quote('"requests":9,"truncated_outputs":2')] }, 'ask').output.findings;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rule-cite-')));
    try {
      const [itemDir, repoDir, runDir] = ['item', 'repo', 'run'].map((d) => join(root, d));
      for (const d of [join(itemDir, 'run'), repoDir, join(runDir, 'tool-calls')]) mkdirSync(d, { recursive: true });
      writeFileSync(join(itemDir, 'run', 'results.json'), '{}');
      writeFileSync(join(runDir, 'tool-calls', 'a.jsonl'), '{}');
      const at = (file, over = {}) => citedFile(file, { itemDir, repoDir, runDir, allowedRoots: [itemDir, repoDir, runDir], ...over });
      return (
        !found[0].unsupported && found[1].unsupported === true &&
        at('run/tool-calls/a.jsonl') === join(runDir, 'tool-calls', 'a.jsonl') && at('$RUN/tool-calls/a.jsonl') === join(runDir, 'tool-calls', 'a.jsonl') &&
        at('run/results.json') === join(itemDir, 'run', 'results.json') && at('run/tool-calls/a.jsonl', { runDir: null }) === null &&
        at('run/tool-calls/a.jsonl', { denied: [runDir] }) === null
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  // --report-from's judge commands: a run of one condition gets the failures
  // question alone, two builds every question in meta.conditions order, and
  // a devtools-against-playwright pair no blinding check.
  'judge prints only the standing questions a run can answer': () => {
    const asks = (conditions, meta = {}, ab = null) => judgeCommands('r', { conditions, meta, ab }).filter((l) => l.includes('--ask'));
    const one = asks(['firefox-devtools-mcp']);
    const builds = asks(['firefox-devtools-mcp@b', 'firefox-devtools-mcp@a'], { conditions: 'firefox-devtools-mcp@a,firefox-devtools-mcp@b' });
    const mixed = asks(['playwright-mcp', 'firefox-devtools-mcp'], { conditions: ['firefox-devtools-mcp', 'playwright-mcp'] });
    return (
      one.length === 1 && one[0].includes('--ask failures') && !one[0].includes('--ab') &&
      builds.length === 4 && builds.every((l) => l.includes('--ask failures --paid') || l.includes('--ab firefox-devtools-mcp@a,firefox-devtools-mcp@b')) &&
      mixed.length === 3 && !mixed.some((l) => l.includes('blinding')) && mixed[0].includes('--ab firefox-devtools-mcp,playwright-mcp')
    );
  },
  // A question-only blinded output names its letters and prints no empty
  // verdict tables.
  'judge question output names its arms': () => {
    const md = renderMarkdown({
      run: 'r', model: 'm', effort: 'e', blinded: true, labels: { 'firefox-devtools-mcp@a': 'X', 'firefox-devtools-mcp@b': 'Y' },
      items: [{ kind: 'ask', id: 'ask|gap', preset: 'gap', question: 'What? More.', diagnosis: { answer: 'because', mechanisms: [] } }],
    });
    return md.includes('saw the builds as X and Y') && !md.includes('## By primary cause') && md.includes('### gap: What?');
  },
  // price-compare: the winner's "**Price:**" names no Gadgetron price, which
  // a heading or label naming the store does.
  'a label names the whole field path': () =>
    !labelled('**Cheapest store:** Marrowgate\n**Price:** $274.50', 'perStore.Gadgetron.price') &&
    labelled('**Gadgetron:**\n- Price: $281.00', 'perStore.Gadgetron.price') &&
    labelled('Gadgetron price: $281.00', 'perStore.Gadgetron.price'),
  // A billed failure, then a timeout, then an answer: the case grades on the
  // third attempt's fields and totals the first one's cost with its own.
  '--extract retries an extraction and totals every attempt\'s cost': async () => {
    const fields = { code: 'AR-4149B7', pages: 3 };
    const billed = Object.assign(new Error('extraction failed: error_max_turns'), { cost_usd: 0.002 });
    const extract = stubExtractor(fields, [billed, new Error('extraction timed out after 120s')]);
    const r = await extractCase(extractTask(), {}, driverCase, extract);
    const counts = extractCounts([r]);
    return (
      r.attempts.length === 3 && r.pass === true && !r.extractorError && !r.validatorError &&
      Math.abs(r.cost_usd - 0.007) < 1e-9 && r.differs?.length === 0 &&
      counts.calls === 3 && counts.unpricedCalls === 1 && counts.retriedCases === 1 &&
      counts.unexpected.driver === 0
    );
  },
  // An extractor that never answered and a validator that threw are each
  // counted as themselves, and neither as an unexpected outcome or as
  // disagreement with the driver's fields.
  '--extract keeps extractor and validator errors apart': async () => {
    const down = new Error('extraction failed: no result message');
    const never = await extractCase(extractTask(), {}, driverCase, stubExtractor({}, [down, down, down]));
    const broken = extractTask(() => {
      throw new Error('fields.code.trim is not a function');
    });
    const threw = await extractCase(broken, {}, driverCase, stubExtractor({ code: 'AR-4149B7', pages: 3 }));
    const wrong = await extractCase(extractTask(), {}, { name: 'wrong[0]', text: EXTRACT_ANSWER, expect: false },
      stubExtractor({ code: 'AR-4149B7', pages: 3 }));
    const counts = extractCounts([never, threw, wrong], { queued: ['stub-task', 'skipped-task'], reached: ['stub-task'] });
    return (
      never.extractorError && !never.validatorError && never.fields === null && never.pass === false &&
      never.driverFields && never.differs === undefined &&
      threw.validatorError && !threw.extractorError &&
      counts.extractorErrors === 1 && counts.validatorErrors === 1 &&
      counts.unexpected.driver === 0 && counts.unexpected.wrong === 1 &&
      counts.differingDrivers === 0 && JSON.stringify(counts.skippedTasks) === '["skipped-task"]'
    );
  },
  'extraction disagreement is read leaf by leaf, strings as normalised': () => {
    const d = leafDiff({ name: '**Welcome back**, Ops', pages: [1, 2] }, { name: 'welcome back, ops', pages: [1] });
    return d.length === 1 && d[0].path === '.pages[1]' && d[0].want === 2 && d[0].got === null;
  },
  // The log is appended as the run goes, so an interrupted run keeps every
  // finished case and shows no summary line.
  '--extract log keeps each case as it lands': async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rule-'));
    try {
      const path = join(dir, 'extract.jsonl');
      const write = openExtractLog(path, { extractor: 'stub', seed: null });
      write('task', { task: 'stub-task', taskHash: 'h', ask: extractTask().ask });
      write('case', await extractCase(extractTask(), {}, driverCase, stubExtractor({ code: 'AR-4149B7', pages: 3 })));
      const cut = readExtractLog(path);
      write('summary', { cases: 1 });
      const whole = readExtractLog(path);
      return (
        cut.run?.extractor === 'stub' && cut.cases.length === 1 && cut.summary === null &&
        cut.tasks.get('stub-task')?.ask === extractTask().ask && cut.cases[0].raw.code.quote === EXTRACT_ANSWER &&
        whole.summary?.cases === 1
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  // firefox-devtools-mcp 0.9.15's pr-review server exited with code 1 before
  // its first call, which is a death, as is a server that never started. A
  // close the client asked for, any exit after the stop signal the tap logs
  // (the SIGKILL it sends a server slow to close among them), and an exit
  // record the harness wrote for a killed tap are none.
  'a server death is read from its tap log': () => {
    const died = serverExit([{ type: 'start', at: 1000 }, { type: 'exit', at: 9500, code: 1, signal: null }]);
    const stopped = (exit) => serverExit([{ type: 'start', at: 0 }, { type: 'signal', at: 5, signal: 'SIGTERM' }, { type: 'exit', at: 10, ...exit }]);
    return (
      died?.code === 1 && died.after_s === 8.5 &&
      serverExit([{ type: 'start', at: 0 }, { type: 'exit', at: 10, code: 0, signal: null }]) === null &&
      serverExit([{ type: 'exit', at: 10, code: null, signal: null, by: 'harness' }]) === null &&
      serverExit([{ type: 'exit', at: 10, code: null, signal: 'SIGSEGV' }])?.signal === 'SIGSEGV' &&
      serverExit([{ type: 'start', at: 0 }, { type: 'exit', at: 30, error: 'spawn npx ENOENT' }])?.error === 'spawn npx ENOENT' &&
      stopped({ code: null, signal: 'SIGKILL' }) === null && stopped({ code: 1, signal: null }) === null && stopped({ code: 0, signal: null }) === null
    );
  },
  // A dirty tree edits a rule's directory through any file under it, and a
  // rename through either of its paths.
  'a run edited a rule in its dirty tree': () =>
    dirtyIn({ dirty: true, dirtyFiles: ['M  sites/index.mjs'] }, ['sites']) &&
    dirtyIn({ dirty: true, dirtyFiles: ['R  eval/old.mjs -> eval/extract.mjs'] }, ['eval/extract.mjs']) &&
    dirtyIn({ dirty: true, dirtyFiles: ['R  eval/extract.mjs -> eval/new.mjs'] }, ['eval/extract.mjs']) &&
    dirtyIn({ dirty: true }, ['sites']) &&
    !dirtyIn({ dirty: true, dirtyFiles: ['M  sitesx/index.mjs', '?? docs/sites'] }, ['sites']) &&
    !dirtyIn({ dirty: false }, ['sites']),
  // A printout cuts a long list, and --all and --json print every item.
  'run health evidence keeps every item': () => {
    const tasks = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const { checks } = healthOf('codex', (dir, edit) => edit((run) => Object.assign(run.meta, { tasks, taskHashes: {} })));
    const [entry] = checks.find((c) => c.id === 'identity').evidence;
    return (
      evidenceLines(entry, true)[0] === `12 selected task(s) without a hash: ${tasks.join(', ')}` &&
      evidenceLines(entry, false)[0] === `12 selected task(s) without a hash: ${tasks.slice(0, 8).join(', ')}, ... 4 more (--all)`
    );
  },
  // Hard rule 9's helpers: a site mints a date that stays ahead of the run from
  // the session's UTC day, and a driver fails the gate on one that has aged.
  // A Sunday session's next Sunday is that day, and a count crosses a month, a
  // year and a leap day; null, a string or a weekday out of 0 to 6 throws
  // rather than mint 1970 or NaN into a page.
  'nextWeekday counts on or after a UTC day': () => {
    const sunday = Date.UTC(2026, 8, 27, 23, 59, 59, 999);
    return (
      isoOf(nextWeekday(sunday, 0)) === '2026-09-27' &&
      isoOf(nextWeekday(sunday, 1)) === '2026-09-28' &&
      isoOf(nextWeekday(new Date(sunday), 6)) === '2026-10-03' &&
      isoOf(nextWeekday(Date.UTC(2026, 11, 31, 12), 4)) === '2026-12-31' &&
      isoOf(nextWeekday(Date.UTC(2026, 11, 31, 12), 5)) === '2027-01-01' &&
      isoOf(nextWeekday(Date.UTC(2028, 1, 28), 2)) === '2028-02-29' &&
      isoOf(nextWeekday(Date.UTC(2027, 1, 28), 1)) === '2027-03-01' &&
      [7, -1, 1.5, '1'].every((w) => thrown(() => nextWeekday(sunday, w))?.startsWith('not a weekday')) &&
      [null, undefined, '2026-09-27', NaN, new Date('x')].every((at) => thrown(() => nextWeekday(at, 1))?.startsWith('not a timestamp'))
    );
  },
  // A fixed day lands on its own weekday from any hour of any day over three
  // years, 0 to 6 days on, or with `past` 1 to 7 days back, and `weeks` is the
  // whole weeks it moved; one past the session's week moves back.
  'shiftWeeks keeps the weekday in whole weeks': () => {
    const sunday = Date.UTC(2026, 8, 27, 23, 59);
    const cases = [
      ['2026-07-27', sunday, false, '2026-09-28', 9],
      ['2026-07-26', sunday, false, '2026-09-27', 9],
      ['2026-07-28', new Date(Date.UTC(2026, 8, 22, 8)), false, '2026-09-22', 8],
      ['2026-07-31', Date.UTC(2026, 8, 29), false, '2026-10-02', 9],
      ['2026-07-31', Date.UTC(2026, 11, 29, 23, 30), false, '2027-01-01', 22],
      ['2024-02-29', Date.UTC(2028, 1, 26), false, '2028-03-02', 209],
      ['2027-01-05', Date.UTC(2026, 8, 22), false, '2026-09-22', -15],
      ['2026-07-27', sunday, true, '2026-09-21', 8],
      ['2026-07-26', sunday, true, '2026-09-20', 8],
      ['2026-07-31', new Date(Date.UTC(2027, 0, 1, 0, 1)), true, '2026-12-25', 21],
      ['2024-02-29', Date.UTC(2028, 2, 1), true, '2028-02-24', 208],
      ['2027-01-05', Date.UTC(2026, 8, 22), true, '2026-09-15', -16],
    ];
    const fixed = ['2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01'];
    for (let at = Date.UTC(2026, 0, 1); at < Date.UTC(2029, 0, 1); at += 7 * 3600000) {
      for (const day of fixed) {
        for (const [past, lo, hi] of [[false, 0, WEEK_MS - DAY_MS], [true, -WEEK_MS, -DAY_MS]]) {
          const moved = shiftWeeks(day, at, { past });
          const ahead = moved.day - utcDay(at);
          if (
            ahead < lo || ahead > hi || !Number.isInteger(moved.weeks) || moved.day !== isoDay(day) + moved.weeks * WEEK_MS ||
            moved.iso !== isoOf(moved.day) || new Date(moved.day).getUTCDay() !== new Date(isoDay(day)).getUTCDay()
          ) return false;
        }
      }
    }
    return (
      cases.every(([day, at, past, iso, weeks]) => {
        const moved = shiftWeeks(day, at, { past });
        return moved.iso === iso && moved.weeks === weeks && moved.day === isoDay(iso);
      }) &&
      ['2026-02-30', '2026-7-28', '2026-07-28T00:00:00Z', 20260728, null].every((day) => thrown(() => shiftWeeks(day, sunday))?.startsWith('not a YYYY-MM-DD day')) &&
      [null, undefined, '2026-09-27'].every((at) => thrown(() => shiftWeeks('2026-07-28', at, { past: true }))?.startsWith('not a timestamp'))
    );
  },
  // A week starts on Monday and belongs to the year of its Thursday, so the
  // last days of December can sit in week 1 and the first of January in week
  // 52 or 53; over twelve years the week moves on each Monday alone.
  'isoWeek counts ISO 8601 weeks in UTC': () => {
    const cases = [
      ['2026-05-11', 2026, 20], ['2026-01-01', 2026, 1], ['2026-12-31', 2026, 53], ['2027-01-01', 2026, 53],
      ['2027-01-03', 2026, 53], ['2027-01-04', 2027, 1], ['2024-12-30', 2025, 1], ['2021-01-03', 2020, 53],
      ['2029-12-31', 2030, 1],
    ];
    let prev = isoWeek(Date.UTC(2019, 11, 31));
    for (let day = Date.UTC(2020, 0, 1); day < Date.UTC(2032, 0, 1); day += DAY_MS) {
      const w = isoWeek(day + DAY_MS - 1);
      const weekday = new Date(day).getUTCDay();
      const same = w.year === prev.year && w.week === prev.week;
      const next = w.year === prev.year ? w.week === prev.week + 1 : w.year === prev.year + 1 && w.week === 1 && prev.week >= 52;
      if (weekday === 1 ? !next : !same) return false;
      if (weekday === 4 && w.year !== new Date(day).getUTCFullYear()) return false;
      prev = w;
    }
    return (
      cases.every(([iso, year, week]) => {
        const w = isoWeek(new Date(isoDay(iso) + DAY_MS - 1));
        return w.year === year && w.week === week;
      }) &&
      [null, '2026-05-11', NaN].every((at) => thrown(() => isoWeek(at))?.startsWith('not a timestamp'))
    );
  },
  // A page's date text is read by its weekday or, with neither a year nor a
  // weekday, as its nearest occurrence: "Fri, Jul 31" on 22 September 2026 is
  // seven weeks past, not next July, and "Monday 11 May" is 2026's however late
  // the gate runs. A weekday no nearby year fits, a day the month lacks and
  // other words read as null.
  'pageDay reads a date as the page printed it': () => {
    const near = Date.UTC(2026, 8, 22, 23, 59);
    const reads = [
      ['Tue 22 Sep', near, '2026-09-22'],
      ['Friday 31 July 2026', near, '2026-07-31'],
      ['Fri, Jul 31', near, '2026-07-31'],
      ['31 Jul', near, '2026-07-31'],
      ['Jul 31, 2027', near, '2027-07-31'],
      ['2026-07-31', near, '2026-07-31'],
      [' thurs. 1 OCT ', near, '2026-10-01'],
      ['Monday 11 May', Date.UTC(2027, 2, 1), '2026-05-11'],
      ['Tue 28 Jul', new Date(near), '2026-07-28'],
      ['Mon 22 Sep', near, '2025-09-22'],
      ['31 Dec', Date.UTC(2027, 0, 1), '2026-12-31'],
      ['Fri 1 Jan', Date.UTC(2026, 11, 31), '2027-01-01'],
      ['29 Feb', Date.UTC(2027, 8, 22), '2028-02-29'],
      ['1 Apr', near, '2026-04-01'],
      ['1 Apr', Date.UTC(2026, 9, 15), '2027-04-01'],
      ['1 Mar', '2027-08-31', '2027-03-01'],
      ['1 Mar', '2027-09-01', '2028-03-01'],
    ];
    return (
      reads.every(([text, at, iso]) => pageDay(text, at) === isoDay(iso)) &&
      [['Fri 22 Sep', near], ['Mon 22 Sep 2026', near], ['Fri 31 Jul', Date.UTC(2028, 5, 1)], ['29 Feb', near], ['31 Sep', near],
        ['next Tuesday', near], ['Tuesday', near], ['Ju 3', near], ['3 Juli', near], ['', near], ['2026-7-28', near],
        ['2026-02-30', near], [42, near], [null, near]].every(([text, at]) => pageDay(text, at) === null) &&
      thrown(() => pageDay('31 Jul'))?.startsWith('pageDay: near is undefined')
    );
  },
  // The error names the page, the words it printed and the day they read as,
  // and a date the driver failed to read throws rather than passes as NaN.
  // today has no default, so no driver checks a minted date against a clock
  // that has passed midnight since the session opened.
  'notBeforeToday names the page and the date': () => {
    const today = Date.UTC(2026, 8, 22, 23, 59);
    const fails = (date, opts) => thrown(() => notBeforeToday('carrier.html', date, { today, ...opts }));
    return (
      notBeforeToday('carrier.html', '2026-09-22', { today }) === Date.UTC(2026, 8, 22) &&
      notBeforeToday('carrier.html', Date.UTC(2026, 8, 22), { today: new Date(today) }) === Date.UTC(2026, 8, 22) &&
      notBeforeToday('carrier.html', 'Tue 22 Sep', { today }) === Date.UTC(2026, 8, 22) &&
      notBeforeToday('carrier.html', '22 Sep 2026', { today: '2026-09-22' }) === Date.UTC(2026, 8, 22) &&
      notBeforeToday('carrier.html', new Date(Date.UTC(2026, 8, 23, 1)), { today, ahead: 1 }) === Date.UTC(2026, 8, 23) &&
      notBeforeToday('carrier.html', '2026-09-30', { today, ahead: 8 }) === Date.UTC(2026, 8, 30) &&
      notBeforeToday('carrier.html', 'Fri 1 Jan', { today: Date.UTC(2026, 11, 31, 23, 59), ahead: 1 }) === Date.UTC(2027, 0, 1) &&
      fails('2026-09-21') === 'carrier.html prints 2026-09-21, before today (2026-09-22)' &&
      fails('Mon 21 Sep') === 'carrier.html prints "Mon 21 Sep" (2026-09-21), before today (2026-09-22)' &&
      fails('Fri, Jul 31') === 'carrier.html prints "Fri, Jul 31" (2026-07-31), before today (2026-09-22)' &&
      fails(Date.UTC(2026, 8, 21, 23, 59), { text: 'Mon 21 Sep' }) === 'carrier.html prints "Mon 21 Sep" (2026-09-21), before today (2026-09-22)' &&
      fails('2026-09-22', { ahead: 1 }) === 'carrier.html prints 2026-09-22, not after today (2026-09-22)' &&
      fails('2026-09-29', { ahead: 8 }) === 'carrier.html prints 2026-09-29, fewer than 8 days after today (2026-09-22)' &&
      fails('2026-12-31', { today: Date.UTC(2027, 0, 1) }) === 'carrier.html prints 2026-12-31, before today (2027-01-01)' &&
      [NaN, null, undefined, 'Fri 22 Sep', '31 Sep', 'next Tuesday', '2026-02-30', new Date('x')].every((date) => fails(date)?.startsWith('carrier.html: the driver read no date from ')) &&
      fails(null, { text: 'Tue 28 Jul' }) === 'carrier.html: the driver read no date from "Tue 28 Jul"' &&
      fails('Fri 22 Sep') === 'carrier.html: the driver read no date from "Fri 22 Sep"' &&
      thrown(() => notBeforeToday('carrier.html', '2026-09-22'))?.startsWith('notBeforeToday: today is undefined') &&
      fails('2026-09-22', { today: null })?.startsWith('notBeforeToday: today is') &&
      fails('2026-09-22', { ahead: -1 })?.startsWith('notBeforeToday: ahead is')
    );
  },
  // The same guard for history and issue dates, which must not run ahead of
  // today, or must sit `behind` days before it.
  'notAfterToday names the page and the date': () => {
    const today = Date.UTC(2026, 8, 22, 0, 1);
    const fails = (date, opts) => thrown(() => notAfterToday('lexvane.html', date, { today, ...opts }));
    return (
      notAfterToday('lexvane.html', '2026-09-22', { today }) === Date.UTC(2026, 8, 22) &&
      notAfterToday('lexvane.html', 'Mon 21 Sep', { today, behind: 1 }) === Date.UTC(2026, 8, 21) &&
      notAfterToday('lexvane.html', new Date(Date.UTC(2026, 8, 15, 23)), { today: new Date(today), behind: 7 }) === Date.UTC(2026, 8, 15) &&
      notAfterToday('lexvane.html', '31 Dec', { today: Date.UTC(2027, 0, 1), behind: 1 }) === Date.UTC(2026, 11, 31) &&
      fails('2026-09-23') === 'lexvane.html prints 2026-09-23, after today (2026-09-22)' &&
      fails('Tue 22 Sep', { behind: 1 }) === 'lexvane.html prints "Tue 22 Sep" (2026-09-22), not before today (2026-09-22)' &&
      fails('Mon 21 Sep', { behind: 7 }) === 'lexvane.html prints "Mon 21 Sep" (2026-09-21), fewer than 7 days before today (2026-09-22)' &&
      fails('1 Jan', { today: Date.UTC(2026, 11, 31) }) === 'lexvane.html prints "1 Jan" (2027-01-01), after today (2026-12-31)' &&
      [NaN, null, 'Sat 22 Sep', '2026-02-30'].every((date) => fails(date)?.startsWith('lexvane.html: the driver read no date from ')) &&
      thrown(() => notAfterToday('lexvane.html', '2026-09-22'))?.startsWith('notAfterToday: today is undefined') &&
      fails('2026-09-22', { behind: 0.5 })?.startsWith('notAfterToday: behind is')
    );
  },
  // Every helper gives the same days in zones with and without summer time,
  // half an hour of it (Lord Howe) and fourteen hours either side of UTC, each
  // run in a child of its own so the gate's process keeps its zone. The six
  // zones' offsets differ, so a child that ignored TZ fails the check.
  'date helpers read no local time zone': async () => {
    const script = [
      `import { isoWeek, nextWeekday, shiftWeeks } from ${JSON.stringify(new URL('../../sites/lib.mjs', import.meta.url).href)};`,
      `import { notAfterToday, notBeforeToday, pageDay } from ${JSON.stringify(new URL('../verify-drivers/lib.mjs', import.meta.url).href)};`,
      `process.stdout.write(JSON.stringify((${zoneDays})()));`,
    ].join('\n');
    const zones = ['UTC', 'America/Los_Angeles', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
    const seen = await Promise.all(zones.map(async (TZ) => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ } });
      return JSON.parse(stdout);
    }));
    const here = JSON.stringify(zoneDays().days);
    return new Set(seen.map((s) => s.offsets.join())).size === zones.length && seen.every((s) => JSON.stringify(s.days) === here);
  },
  ...Object.fromEntries(
    Object.entries(CLEAN).map(([backend, want]) => [
      `run health passes a consistent ${backend} run`,
      () => {
        const { status } = healthOf(backend);
        return HEALTH_CHECKS.every((id) => status[id] === want[id]) && Object.keys(status).length === HEALTH_CHECKS.length;
      },
    ])
  ),
  ...Object.fromEntries(
    Object.entries(HEALTH_DEFECTS).map(([defect, [backend, moved, mutate, shows]]) => [
      `run health on ${defect}`,
      () => {
        const { status, evidence } = healthOf(backend, mutate);
        const want = { ...CLEAN[backend], ...moved };
        return HEALTH_CHECKS.every((id) => status[id] === want[id]) && (!shows || shows.test(evidence));
      },
    ])
  ),
};

// The names of the checks that fail.
export async function ruleCheckFailures() {
  const failed = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      if (!(await check())) failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const failed = await ruleCheckFailures();
  for (const name of failed) console.error(`rule check failed: ${name}`);
  console.log(`${Object.keys(CHECKS).length - failed.length}/${Object.keys(CHECKS).length} reporting rule checks pass`);
  process.exit(failed.length ? 1 : 0);
}
