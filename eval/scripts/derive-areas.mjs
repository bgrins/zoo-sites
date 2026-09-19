// Derives eval/tasks/areas.json: the capability areas each task exercises, so
// a tool change can be gated and measured on the tasks it touches
// (`verify.mjs --area`, `run.mjs --area`).
//
//   node eval/verify.mjs --jobs 1 --telemetry /tmp/dep.json
//   FIREFOX_DEVTOOLS_MCP=<build with the text caps raised> \
//     node eval/verify.mjs --jobs 1 --telemetry /tmp/caps.json      (optional)
//   node eval/scripts/derive-areas.mjs --telemetry /tmp/dep.json [--caps /tmp/caps.json]
//        [--results eval/results] [--write]
//
// Four sources, each read the same way for every task, then OVERRIDES:
//   - what the golden-path driver called and which pages it visited (the
//     --telemetry run), and whether its graded values reached a snapshot;
//   - the source of those pages and the scripts they load, for the page
//     features a tool limit bites on (tables, frames, shadow roots, dialogs);
//   - the ask;
//   - the tools agents called on the task in stored runs (eval/results), and
//     whether a devtools agent's script recovered text a snapshot had cut.
// Without --write it prints each task's areas and what changed against the
// current file.
//
// Two inputs live outside the repo: eval/results is gitignored and holds only
// the runs this machine made, and the caps build is a local patch of the
// tool. A clean checkout therefore derives a file close to the committed one,
// not identical to it; the diff printed without --write shows how close.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webTasks } from '../tasks/web.mjs';
import { devtoolsTasks } from '../tasks/devtools.mjs';
import { basicTasks } from '../tasks/basic.mjs';
import { DRIVERS } from '../verify-drivers/index.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AREAS_FILE = join(REPO, 'eval', 'tasks', 'areas.json');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
if (!flag('telemetry')) throw new Error('--telemetry <file> is required: a `verify.mjs --telemetry` run');
const telemetry = JSON.parse(readFileSync(flag('telemetry'), 'utf8'));
const caps = flag('caps') ? JSON.parse(readFileSync(flag('caps'), 'utf8')) : null;
const RESULTS = resolve(flag('results', join(REPO, 'eval', 'results')));

// Every area, and what earns it. The list is the vocabulary: an area named
// nowhere else does not exist.
const AREA_DOCS = {
  'snapshot-text': 'a graded value was cut by the snapshot text cap, or appears only once the cap is raised, or an agent scripted to recover text a snapshot cut',
  tables: 'a page the task visits holds a <table>',
  dialogs: 'a page raises alert/confirm/prompt/beforeunload, or a driver or agent called a dialog tool',
  'input-fill': 'the driver or an agent filled a field through a fill tool',
  select: 'a page the task visits holds a <select> that the driver or an agent filled',
  'control-state': 'a page the task visits has checkboxes or radio buttons, whose state the default snapshot does not print',
  navigation: 'the driver visited two or more pages, or navigated by link, or an agent went back in history',
  network: 'the ask is about requests or responses, or the driver or an agent listed network requests',
  script: 'in stored runs, agents on both surfaces mostly reached for script (evaluate_script, browser_evaluate)',
  'shadow-dom': 'a page the task visits attaches a shadow root',
  iframes: 'a page the task visits holds an <iframe>',
  downloads: 'a page offers a download, the ask names an export, or a tool listed downloads',
  timing: 'the ask names a wait, a delay or a retry, or the golden path takes 8 s or more',
  'multi-tab': 'a page opens a new tab or window, or the driver opened a page',
  drag: 'a page is built for dragging, or the driver or an agent called a drag tool',
  uploads: 'a page takes a file input, or a tool uploaded a file',
  viewport: 'the driver or an agent resized the viewport',
  console: 'the ask is about an error the page throws, or the driver or an agent read the console',
  canvas: 'a page draws on a <canvas>',
};

// Where the sources above miss what a task is about, with the reason.
const OVERRIDES = {
  'mfa-login': { add: ['snapshot-text'], why: 'the welcome phrase is the graded value and the cap cuts it (roadmap section 2, item 1)' },
  'canvas-pick': { add: ['script'], why: 'the colour lives in canvas pixels, which only script reads' },
  'dead-images': { add: ['script'], why: 'load state (naturalWidth) never reaches a snapshot' },
  'live-auction': { add: ['timing'], why: 'the room moves on a clock the agent has to wait out' },
  'maze-escape': { add: ['navigation'], why: 'the maze is walked room by room inside one document' },
  'status-flash': { add: ['timing'], why: 'the probe code shows for a moment and is gone' },
  'mid-flight-rate': { add: ['network'], why: 'the multiplier is only in the quote response body' },
  'partial-import': { add: ['network'], why: 'what the intake accepted is only in the post response' },
};

const toolAreas = [
  [/^(fill_by_uid|fill_form_by_uid|browser_fill_form|browser_type)$/, 'input-fill'],
  [/^(accept_dialog|dismiss_dialog|browser_handle_dialog)$/, 'dialogs'],
  [/^(list_network_requests|get_network_request|browser_network_requests?)$/, 'network'],
  [/^(drag_by_uid_to_uid|browser_drag|browser_drop)$/, 'drag'],
  [/^(upload_file_by_uid|browser_file_upload)$/, 'uploads'],
  [/^(set_viewport_size|browser_resize)$/, 'viewport'],
  [/^(list_console_messages|browser_console_messages)$/, 'console'],
  [/^(list_downloads|set_download_behavior)$/, 'downloads'],
  [/^(navigate_history|browser_navigate_back)$/, 'navigation'],
];
const SCRIPT_TOOLS = /^(evaluate_script|browser_evaluate|browser_run_code_unsafe)$/;

const pageFeatures = [
  [/<table\b|createElement\(\s*['"]table/i, 'tables'],
  [/<iframe\b|createElement\(\s*['"]iframe/i, 'iframes'],
  [/attachShadow\s*\(/, 'shadow-dom'],
  [/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(\s*['"`]|beforeunload/, 'dialogs'],
  [/type=["']?file\b/i, 'uploads'],
  [/type\s*[=:]\s*["']?(?:checkbox|radio)\b/i, 'control-state'],
  [/<canvas\b|getContext\(\s*['"]2d/, 'canvas'],
  [/target=["']?_blank|window\.open\s*\(/, 'multi-tab'],
  [/\sdownload(?:=|\s|>)|\.download\s*=|createObjectURL/, 'downloads'],
  [/draggable=["']?true|['"]dragstart['"]|['"]pointermove['"]/, 'drag'],
];

// A page path as the single-origin server serves it, read off disk with the
// scripts it loads from its own site.
const sourceCache = new Map();
function pageSource(path) {
  const clean = path.split(/[?#]/)[0];
  if (sourceCache.has(clean)) return sourceCache.get(clean);
  let file = join(REPO, 'pages', clean);
  if (clean.endsWith('/') || (existsSync(file) && statSync(file).isDirectory())) file = join(file, 'index.html');
  let text = '';
  if (existsSync(file) && statSync(file).isFile()) {
    text = readFileSync(file, 'utf8');
    for (const [, src] of text.matchAll(/<script[^>]+src=["']([^"'#?]+)/gi)) {
      if (/^[a-z]+:/i.test(src)) continue;
      const script = src.startsWith('/') ? join(REPO, 'pages', src) : join(dirname(file), src);
      if (existsSync(script) && statSync(script).isFile()) text += '\n' + readFileSync(script, 'utf8');
    }
  }
  sourceCache.set(clean, text);
  return text;
}

// Tool calls to the condition's own server in every stored transcript, by task:
// codex events and Agent SDK messages both.
function storedRuns() {
  const byTask = {};
  if (!existsSync(RESULTS)) return byTask;
  for (const run of readdirSync(RESULTS)) {
    const dir = join(RESULTS, run, 'transcripts');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const task = f.replace(/\.jsonl$/, '').split('--').at(-1);
      const calls = [];
      const pending = new Map();
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === 'item.completed' && e.item?.type === 'mcp_tool_call' && e.item.server === 'firefox') {
          calls.push({ tool: e.item.tool, text: (e.item.result?.content ?? []).map((c) => c.text ?? '').join('\n') });
        }
        for (const block of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (block.type === 'tool_use' && /^mcp__firefox__/.test(block.name ?? '')) {
            const call = { tool: block.name.replace(/^mcp__firefox__/, ''), text: '' };
            pending.set(block.id, call);
            calls.push(call);
          }
          if (block.type === 'tool_result' && pending.has(block.tool_use_id)) {
            const c = block.content;
            pending.get(block.tool_use_id).text = typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('\n');
          }
        }
      }
      if (calls.length) (byTask[task] ??= []).push(calls);
    }
  }
  return byTask;
}

// Whether an evaluate_script result carries, past its cut, a string an
// earlier snapshot in the same row showed cut with "...".
function scriptRecoveredCut(calls) {
  const cut = [];
  for (const c of calls) {
    if (c.tool === 'take_snapshot') {
      for (const [, head] of c.text.matchAll(/"([^"\n]{12,})\.\.\."/g)) cut.push(head);
    } else if (c.tool === 'evaluate_script' && cut.some((head) => new RegExp(`${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\S`).test(c.text))) {
      return true;
    }
  }
  return false;
}

const base = 'http://placeholder';
const tasks = [...basicTasks(base), ...(await webTasks(base)), ...(await devtoolsTasks(base))];
const runs = storedRuns();
const derived = {};
const why = {};
for (const task of tasks) {
  const areas = new Set();
  const reasons = (why[task.id] = {});
  const add = (area, reason) => {
    if (!AREA_DOCS[area]) throw new Error(`unknown area ${area}`);
    if (!areas.has(area)) reasons[area] = reason;
    areas.add(area);
  };
  const tele = telemetry.tasks?.[task.id];
  const driverTools = Object.keys(tele?.tools ?? {});
  for (const tool of driverTools) for (const [re, area] of toolAreas) if (re.test(tool)) add(area, `driver called ${tool}`);
  const entry = [...String(task.ask ?? '').matchAll(/http:\/\/placeholder(\/[^\s)"'`]*)/g)].map((m) => m[1].replace(/[.,;:]$/, ''));
  const pages = [...new Set([...(tele?.pages ?? []), ...entry])];
  for (const path of pages) {
    const src = pageSource(path);
    for (const [re, area] of pageFeatures) if (re.test(src)) add(area, `${path} matches ${re.source.slice(0, 40)}`);
  }
  const driverSource = DRIVERS[task.id]?.run?.toString() ?? '';
  // The ask's words, without its URLs, whose "http" would read as a keyword.
  const words = String(task.ask ?? '').replace(/https?:\/\/\S+/g, ' ');
  if (new Set(tele?.pages ?? []).size >= 2) add('navigation', `driver visited ${new Set(tele.pages).size} pages`);
  if (/clickToPath|atPath\(/.test(driverSource)) add('navigation', 'driver navigates by link');
  if (/\b(network|HTTP|status code|endpoint|XHR|which request|request (?:that )?failed|failed request)\b/i.test(words)) {
    add('network', 'the ask is about requests');
  }
  if (/\b(download|export(?:ed)?|CSV)\b/i.test(words)) add('downloads', 'the ask names a download or export');
  if (/\b(wait|embargo|countdown|retry|can take|every \d+ (?:seconds?|minutes?)|\d+ seconds)\b/i.test(words)) add('timing', 'the ask names a wait');
  if ((tele?.ms ?? 0) >= 8000) add('timing', `the golden path takes ${Math.round(tele.ms / 1000)} s`);
  if (/\b(throws?|uncaught|stack trace)\b/i.test(words)) add('console', 'the ask is about a thrown error');
  if (/\bresponse\b/i.test(words)) add('network', 'the ask is about a response');
  if (driverTools.includes('new_page')) add('multi-tab', 'driver opened a page');
  const selects = pages.some((p) => /<select\b/i.test(pageSource(p)));
  const reach = [tele?.reach?.driver?.fields ?? {}, tele?.reach?.final?.fields ?? {}];
  if (reach.some((r) => Object.values(r).includes('truncated'))) add('snapshot-text', 'a graded value reached a snapshot cut');
  const capsReach = caps?.tasks?.[task.id]?.reach;
  if (capsReach) {
    for (const key of ['driver', 'final']) {
      for (const [field, state] of Object.entries(capsReach[key]?.fields ?? {})) {
        if (state === 'seen' && tele?.reach?.[key]?.fields?.[field] !== 'seen') add('snapshot-text', `${field} is seen only once the caps are raised`);
      }
    }
  }
  const rows = runs[task.id] ?? [];
  const scripted = { devtools: [0, 0], playwright: [0, 0] };
  for (const calls of rows) {
    for (const { tool } of calls) for (const [re, area] of toolAreas) if (re.test(tool)) add(area, `an agent called ${tool}`);
    const surface = calls.some((c) => /^browser_/.test(c.tool)) ? 'playwright' : 'devtools';
    scripted[surface][1]++;
    if (calls.some((c) => SCRIPT_TOOLS.test(c.tool))) scripted[surface][0]++;
    if (scriptRecoveredCut(calls)) add('snapshot-text', 'an agent scripted past text a snapshot cut');
    if (selects && calls.some((c) => /^(browser_select_option|fill_by_uid|fill_form_by_uid|browser_fill_form)$/.test(c.tool))) add('select', 'an agent filled a page with a <select>');
  }
  if (selects && driverTools.some((t) => /^fill/.test(t))) add('select', 'driver filled a page with a <select>');
  const mostly = ([n, of]) => of > 0 && n / of >= 0.5;
  if (mostly(scripted.devtools) && mostly(scripted.playwright)) {
    add('script', `script in ${scripted.devtools.join(' of ')} devtools and ${scripted.playwright.join(' of ')} playwright rows`);
  }
  for (const area of OVERRIDES[task.id]?.add ?? []) add(area, `override: ${OVERRIDES[task.id].why}`);
  for (const area of OVERRIDES[task.id]?.remove ?? []) {
    areas.delete(area);
    delete reasons[area];
  }
  derived[task.id] = [...areas].sort();
}

const current = existsSync(AREAS_FILE) ? JSON.parse(readFileSync(AREAS_FILE, 'utf8')) : {};
const counts = {};
for (const list of Object.values(derived)) for (const a of list) counts[a] = (counts[a] ?? 0) + 1;
console.log(`areas over ${tasks.length} tasks (${Object.keys(telemetry.tasks ?? {}).length} with telemetry, ${Object.keys(runs).length} with stored transcripts):`);
for (const [area, doc] of Object.entries(AREA_DOCS)) console.log(`  ${area.padEnd(14)} ${String(counts[area] ?? 0).padStart(3)}  ${doc}`);
const changed = tasks.filter((t) => JSON.stringify(current[t.id] ?? []) !== JSON.stringify(derived[t.id]));
if (args.includes('--verbose')) {
  for (const t of tasks) {
    console.log(`\n${t.id}: ${derived[t.id].join(', ') || '(none)'}`);
    for (const [area, reason] of Object.entries(why[t.id])) console.log(`    ${area}: ${reason}`);
  }
}
console.log(`\n${changed.length} tasks differ from ${AREAS_FILE.slice(REPO.length + 1)}`);
for (const t of changed.slice(0, 40)) {
  console.log(`  ${t.id}: ${(current[t.id] ?? []).join(', ') || '(none)'} -> ${derived[t.id].join(', ') || '(none)'}`);
}
if (args.includes('--write')) {
  // One task per line, so a regeneration diffs by task.
  const lines = Object.entries(derived)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, list]) => `  ${JSON.stringify(id)}: ${JSON.stringify(list)}`);
  writeFileSync(AREAS_FILE, `{\n${lines.join(',\n')}\n}\n`);
  console.log(`\nwrote ${AREAS_FILE}`);
}
