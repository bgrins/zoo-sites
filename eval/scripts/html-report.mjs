import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totalsByCondition } from '../report.mjs';
import { latestRun, readRun } from '../run-files.mjs';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const count = (value) => value == null ? '—' : Number(value).toLocaleString('en-US');
const seconds = (value) => value == null ? '—' : `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 })}s`;
const ratio = (value) => value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}×`;
const percent = (value) => value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
const input = (row) => [row.input_tokens, row.cache_creation, row.cache_read].some((value) => value != null)
  ? (row.input_tokens ?? 0) + (row.cache_creation ?? 0) + (row.cache_read ?? 0)
  : null;
const sum = (rows, field) => rows.some((row) => row[field] != null)
  ? rows.reduce((total, row) => total + (row[field] ?? 0), 0)
  : null;
const cacheShare = (rows) => {
  const totalInput = rows.reduce((total, row) => total + (input(row) ?? 0), 0);
  const reads = sum(rows, 'cache_read');
  return totalInput && reads != null ? reads / totalInput : null;
};
const median = (values) => {
  const sorted = values.filter((value) => value != null).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const geometricMean = (values) => {
  const positive = values.filter((value) => value != null && Number.isFinite(value) && value > 0);
  return positive.length ? Math.exp(positive.reduce((sum, value) => sum + Math.log(value), 0) / positive.length) : null;
};
const badge = (passed) => `<span class="badge ${passed ? 'pass' : 'fail'}">${passed ? 'Pass' : 'Fail'}</span>`;
const anchorFor = (id) => `task-${/^[a-z0-9-]+$/.test(id) ? id : `encoded-${Buffer.from(id).toString('hex')}`}`;

const css = `
:root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f2; color: #172420; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 1180px; margin: 0 auto; padding: 48px 28px 80px; }
header { border-bottom: 1px solid #cdd6ce; padding-bottom: 30px; }
.eyebrow { color: #3e6654; font-size: .78rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
h1 { font-size: clamp(2rem, 4vw, 3.35rem); letter-spacing: -.045em; line-height: 1.08; margin: 12px 0; }
h2 { font-size: 1.32rem; letter-spacing: -.025em; margin: 0 0 14px; }
p { line-height: 1.55; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
.meta span { background: #e9ede7; padding: 6px 10px; border-radius: 6px; font-size: .81rem; color: #31443a; }
section { margin-top: 38px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 14px; }
.card, .panel { border: 1px solid #d5ddd5; background: #fff; border-radius: 12px; box-shadow: 0 3px 12px #173b2110; }
.card { padding: 22px; }
.card h2 { font-size: .86rem; font-weight: 650; line-height: 1.4; min-height: 2.2em; margin-bottom: 14px; overflow-wrap: anywhere; }
.card strong { font-size: 2rem; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.035em; }
.card small { font-size: .91rem; color: #69756c; font-weight: 500; }
.card .rule { height: 1px; background: #e4e8e2; margin: 17px 0 13px; }
.card dl { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; margin: 0; font-size: .85rem; }
.card dt { color: #59695e; }.card dd { margin: 0; font-variant-numeric: tabular-nums; }
.panel { padding: 23px; }
.overview { display: flex; gap: 30px; flex-wrap: wrap; align-items: flex-end; }
.overview .figure { font-size: 2.2rem; font-weight: 750; line-height: 1; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
.overview .figure-label { font-size: .84rem; color: #59695e; margin-top: 7px; }
.method { font-size: .84rem; color: #607167; margin: 20px 0 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.section-head p { color: #647268; font-size: .88rem; margin: 0 0 16px; }
.table-wrap { overflow-x: auto; border: 1px solid #d5ddd5; border-radius: 10px; background: #fff; }
table { border-collapse: collapse; width: 100%; font-size: .86rem; }
th, td { padding: 11px 13px; text-align: left; border-bottom: 1px solid #e8ece7; vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
th { background: #eef1eb; color: #405447; font-size: .76rem; font-weight: 700; white-space: nowrap; }
tbody tr:hover { background: #f8faf7; }
thead tr:first-child th:first-child, tbody td:first-child { position: sticky; left: 0; z-index: 1; background: #eef1eb; }
tbody td:first-child { background: #fff; }
tbody tr:hover td:first-child { background: #f8faf7; }
td.number, th.number { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.task-name { font-weight: 620; white-space: nowrap; }
.task-toggle { background: none; border: 0; color: inherit; cursor: pointer; font: inherit; font-weight: inherit; padding: 0; text-align: left; }
.task-toggle:hover, .permalink:hover { text-decoration: underline; }
.permalink { margin-left: 8px; font-size: .78rem; color: #527264; text-decoration: none; }
.task-detail td, .task-detail td:first-child { background: #f7f9f5; position: static; }
.detail-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); padding: 8px 0; white-space: normal; }
.detail-grid article { border-left: 2px solid #a9c6b2; padding: 6px 14px; }
.detail-grid h3 { font-size: .88rem; margin: 0 0 8px; overflow-wrap: anywhere; }
.detail-grid p { margin: 6px 0; color: #415348; font-size: .84rem; }
.detail-grid .review { grid-column: 1 / -1; border-color: #829ca7; }
.muted { color: #6b786f; }
.badge { display: inline-block; font-size: .72rem; font-weight: 750; border-radius: 99px; padding: 4px 9px; white-space: nowrap; }
.pass { color: #20593d; background: #dff0e4; }
.fail { color: #8f3d31; background: #fae5df; }
.controls { display: flex; gap: 11px; flex-wrap: wrap; margin: 0 0 17px; }
.controls label { display: flex; gap: 6px; flex-direction: column; color: #405447; font-size: .78rem; font-weight: 650; }
.controls input, .controls select { background: #fff; border: 1px solid #aebcb1; border-radius: 6px; font: inherit; font-size: .9rem; padding: 9px 11px; color: #172420; min-width: 150px; }
.controls input { min-width: min(270px, 80vw); }
:focus-visible { outline: 3px solid #237c9a; outline-offset: 2px; }
@media (max-width: 680px) { main { padding: 30px 16px 55px; } .panel { padding: 17px; } th, td { padding: 9px; } }
`;

const script = `
const search = document.getElementById('search');
const family = document.getElementById('family');
const outcome = document.getElementById('outcome');
const order = document.getElementById('order');
const visible = document.getElementById('visible');
const rows = Array.from(document.querySelectorAll('#tasks tbody tr.task-row'));
const body = document.querySelector('#tasks tbody');
function update() {
  const query = search.value.trim().toLocaleLowerCase();
  rows.sort((left, right) => order.value === 'difference'
    ? Number(right.dataset.difference) - Number(left.dataset.difference) || left.dataset.task.localeCompare(right.dataset.task)
    : left.dataset.task.localeCompare(right.dataset.task));
  const fragment = document.createDocumentFragment();
  let shown = 0;
  for (const row of rows) {
    const match = (!query || row.dataset.task.toLocaleLowerCase().includes(query))
      && (!family.value || row.dataset.family === family.value)
      && (outcome.value === 'all' || outcome.value === 'failures' && row.dataset.failure === 'true'
        || outcome.value === 'different' && row.dataset.different === 'true');
    row.hidden = !match;
    const detail = row.nextElementSibling;
    detail.hidden = !match || row.querySelector('.task-toggle').getAttribute('aria-expanded') !== 'true';
    if (match) shown++;
    fragment.append(row);
    fragment.append(detail);
  }
  body.append(fragment);
  visible.textContent = shown + ' of ' + rows.length + ' tasks shown';
}
for (const control of [search, family, outcome, order]) control.addEventListener('input', update);
function revealHash() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const row = document.getElementById(id);
  if (!row || !row.classList.contains('task-row')) return;
  if (row.hidden) {
    search.value = '';
    family.value = '';
    outcome.value = 'all';
    update();
  }
  row.querySelector('.task-toggle').setAttribute('aria-expanded', 'true');
  row.nextElementSibling.hidden = false;
  requestAnimationFrame(() => row.scrollIntoView({ block: 'start' }));
}
body.addEventListener('click', (event) => {
  const link = event.target.closest('.permalink');
  if (link) { requestAnimationFrame(revealHash); return; }
  const button = event.target.closest('.task-toggle');
  if (!button) return;
  const row = button.closest('.task-row');
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  row.nextElementSibling.hidden = !open;
  if (open) history.replaceState(null, '', '#' + row.id);
});
window.addEventListener('hashchange', revealHash);
update();
revealHash();
`;

export function renderHtmlReport(run, runName = 'eval run', { homeHref = null, diagnoses = null } = {}) {
  if (diagnoses && diagnoses.run !== runName) throw new Error(`diagnoses belong to ${diagnoses.run}, not ${runName}`);
  const rows = run.results ?? [];
  if (!rows.length) throw new Error('the run has no result rows');
  const backendsInRun = new Set(rows.map((row) => row.backend).filter(Boolean));
  const groupFor = (row) => backendsInRun.size > 1 ? `${row.backend}/${row.condition}` : row.condition;
  const conditions = [...new Set(rows.map(groupFor))];
  const totals = backendsInRun.size > 1
    ? totalsByCondition(rows.map((row) => ({ ...row, condition: groupFor(row) })))
    : run.totals ?? totalsByCondition(rows);
  const tasks = new Map();
  for (const row of rows) {
    if (!tasks.has(row.task)) tasks.set(row.task, { family: row.family ?? 'unknown', rows: new Map() });
    const task = tasks.get(row.task);
    const group = groupFor(row);
    if (!task.rows.has(group)) task.rows.set(group, []);
    task.rows.get(group).push(row);
  }
  const paired = conditions.length === 2;
  const pairs = [...tasks].map(([id, task]) => {
    const arms = conditions.map((condition) => {
      const attempts = task.rows.get(condition) ?? [];
      return {
        attempts,
        passes: attempts.filter((row) => row.success === true).length,
        input: median(attempts.map(input)),
        cache: cacheShare(attempts),
        output: median(attempts.map((row) => row.output_tokens)),
        wall: median(attempts.map((row) => row.wall_s)),
      };
    });
    const complete = arms.every((arm) => arm.attempts.length > 0);
    const different = paired && complete && arms[0].passes / arms[0].attempts.length !== arms[1].passes / arms[1].attempts.length;
    const failure = arms.some((arm) => arm.passes < arm.attempts.length);
    return { id, family: task.family, arms, complete, different, failure };
  });
  const matched = paired ? pairs.filter((task) => task.complete && task.arms.every((arm) => arm.input > 0)) : [];
  const inputRatio = geometricMean(matched.map((task) => task.arms[0].input / task.arms[1].input));
  const outputMatched = paired ? pairs.filter((task) => task.complete && task.arms.every((arm) => arm.output > 0)) : [];
  const outputRatio = geometricMean(outputMatched.map((task) => task.arms[0].output / task.arms[1].output));
  const flips = pairs.filter((task) => task.different).length;
  const cards = conditions.map((condition) => {
    const total = totals[condition] ?? {};
    return `<article class="card"><h2>${escapeHtml(condition)}</h2><strong>${count(total.passed)} <small>/ ${count(total.tasks)} passed</small></strong><div class="rule"></div><dl><dt>Input tokens</dt><dd>${count(input(total))}</dd><dt>Cache-read share</dt><dd>${percent(cacheShare([total]))}</dd><dt>Output tokens</dt><dd>${count(total.output_tokens)}</dd><dt>Task time (sum)</dt><dd>${seconds(total.wall_s)}</dd>${total.cost_usd == null ? '' : `<dt>Estimated cost</dt><dd>$${Number(total.cost_usd).toFixed(2)}</dd>`}</dl></article>`;
  }).join('\n');
  const familyNames = [...new Set(pairs.map((task) => task.family))].sort();
  const families = familyNames.map((family) => {
    const group = pairs.filter((task) => task.family === family);
    const cells = conditions.map((condition, index) => {
      const attempts = group.flatMap((task) => task.arms[index].attempts);
      return `<td class="number">${group.reduce((total, task) => total + task.arms[index].passes, 0)}/${attempts.length}</td><td class="number">${count(attempts.reduce((total, row) => total + (input(row) ?? 0), 0))}</td><td class="number">${percent(cacheShare(attempts))}</td><td class="number">${count(sum(attempts, 'output_tokens'))}</td>`;
    }).join('');
    const familyMatched = paired ? group.filter((task) => task.complete && task.arms.every((arm) => arm.input > 0)) : [];
    const familyRatio = paired ? geometricMean(familyMatched.map((task) => task.arms[0].input / task.arms[1].input)) : null;
    return `<tr><td>${escapeHtml(family)}</td><td class="number">${count(group.length)}</td>${cells}${paired ? `<td class="number">${ratio(familyRatio)}</td>` : ''}</tr>`;
  }).join('\n');
  const tableRows = pairs.map((task) => {
    const cells = task.arms.map((arm) => `<td>${arm.attempts.length ? `${badge(arm.passes === arm.attempts.length)}${arm.attempts.length > 1 ? ` <span class="muted">${arm.passes}/${arm.attempts.length}</span>` : ''}` : '—'}</td><td class="number">${count(arm.input)}</td><td class="number">${percent(arm.cache)}</td><td class="number">${count(arm.output)}</td>`).join('');
    const inputGap = paired && task.arms.every((arm) => arm.input > 0) ? task.arms[0].input / task.arms[1].input : null;
    const anchor = anchorFor(task.id);
    const details = task.arms.map((arm, index) => {
      const tools = new Map();
      for (const attempt of arm.attempts) for (const [name, stats] of Object.entries(attempt.tools ?? {})) {
        tools.set(name, (tools.get(name) ?? 0) + (stats.calls ?? 0));
      }
      const topTools = [...tools].sort((left, right) => right[1] - left[1]).slice(0, 5);
      return `<article><h3>${escapeHtml(conditions[index])}</h3><p>${arm.passes}/${arm.attempts.length} passed · ${count(median(arm.attempts.map((row) => row.turns)))} turns · ${seconds(arm.wall)} task time</p><p>Median per attempt: input ${count(arm.input)} · cache reads ${count(median(arm.attempts.map((row) => row.cache_read)))} · cache writes ${count(median(arm.attempts.map((row) => row.cache_creation)))} · output ${count(arm.output)}</p><p>Top tools: ${topTools.length ? topTools.map(([name, calls]) => `${escapeHtml(name)} (${count(calls)})`).join(', ') : 'not recorded'}</p></article>`;
    }).join('');
    const reviews = (diagnoses?.items ?? []).filter((item) => item.task === task.id && ['row', 'pair'].includes(item.kind) && typeof item.diagnosis?.summary === 'string');
    const reviewHtml = reviews.map((item) => `<article class="review"><h3>Model review${item.rep && item.rep !== 1 ? ` · repeat ${count(item.rep)}` : ''}</h3><p>${escapeHtml(item.diagnosis.summary)}</p><p class="muted">${escapeHtml(item.diagnosis.difference_driver ?? item.diagnosis.primary_cause ?? 'Interpretation, not a grade')}</p></article>`).join('');
    const columns = 3 + conditions.length * 4 + Number(paired);
    return `<tr class="task-row" id="${anchor}" data-task="${escapeHtml(task.id)}" data-family="${escapeHtml(task.family)}" data-failure="${task.failure}" data-different="${task.different}" data-difference="${inputGap == null ? 0 : Math.abs(Math.log(inputGap))}"><td class="task-name"><button class="task-toggle" type="button" aria-expanded="false" aria-controls="${anchor}-detail">${escapeHtml(task.id)}</button><a class="permalink" href="#${anchor}" aria-label="Link to ${escapeHtml(task.id)}">#</a></td><td class="muted">${escapeHtml(task.family)}</td>${cells}${paired ? `<td class="number">${ratio(inputGap)}</td>` : ''}<td class="number">${task.arms.map((arm) => seconds(arm.wall)).join(' / ')}</td></tr><tr class="task-detail" id="${anchor}-detail" hidden><td colspan="${columns}"><div class="detail-grid">${details}${reviewHtml}</div></td></tr>`;
  }).join('\n');
  const date = Number.isFinite(Date.parse(run.meta?.date)) ? new Date(run.meta.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Date not recorded';
  const models = [...new Set(rows.map((row) => row.model).filter(Boolean))].join(', ') || 'Model not recorded';
  const backends = [...new Set(rows.map((row) => row.backend).filter(Boolean))].join(', ') || run.meta?.backend || 'Backend not recorded';
  const metadata = [date, models, backends, `${tasks.size} tasks`, run.meta?.suite && `Suite: ${run.meta.suite}`, run.meta?.git?.commit && `Eval: ${run.meta.git.commit.slice(0, 10)}`].filter(Boolean);
  const metaHtml = metadata.map((item) => `<span>${escapeHtml(item)}</span>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Eval report · ${escapeHtml(runName)}</title><style>${css}</style></head>
<body><main><header>${homeHref ? `<a class="eyebrow" href="${escapeHtml(homeHref)}">All reports</a>` : '<div class="eyebrow">Zoo sites / eval report</div>'}<h1>Browser-agent evaluation</h1><div class="meta">${metaHtml}</div></header>
<section aria-label="Results by condition"><div class="summary">${cards}</div></section>
${paired ? `<section class="panel" aria-label="Comparison"><h2>Comparison</h2><p class="method">${escapeHtml(conditions[0])} / ${escapeHtml(conditions[1])} · ${count(matched.length)} paired tasks · above 1 means the first used more</p><div class="overview"><div><div class="figure">${ratio(inputRatio)}</div><div class="figure-label">Input ratio</div></div><div><div class="figure">${ratio(outputRatio)}</div><div class="figure-label">Output ratio</div></div><div><div class="figure">${flips}</div><div class="figure-label">Different pass outcomes</div></div></div></section>` : ''}
<p class="method">Input includes cache writes and reads; cache is reads / input. Token ratios are not cost ratios. One run is directional.</p>
<section><div class="section-head"><h2>By task family</h2><p>Token totals and pass rate by surface; cache is read share</p></div><div class="table-wrap"><table><thead><tr><th scope="col" rowspan="2">Family</th><th scope="col" rowspan="2" class="number">Tasks</th>${conditions.map((condition) => `<th scope="colgroup" colspan="4">${escapeHtml(condition)}</th>`).join('')}${paired ? '<th scope="col" rowspan="2" class="number">Input ratio</th>' : ''}</tr><tr>${conditions.map(() => '<th scope="col" class="number">Pass</th><th scope="col" class="number">Input</th><th scope="col" class="number">Cache</th><th scope="col" class="number">Output</th>').join('')}</tr></thead><tbody>${families}</tbody></table></div></section>
<section><div class="section-head"><h2>Tasks</h2><p id="visible" aria-live="polite">${tasks.size} tasks shown</p></div><div class="controls"><label>Search tasks<input id="search" type="search" placeholder="Task name"></label><label>Family<select id="family"><option value="">All families</option>${familyNames.map((family) => `<option value="${escapeHtml(family)}">${escapeHtml(family)}</option>`).join('')}</select></label><label>Outcome<select id="outcome"><option value="all">All outcomes</option><option value="failures">Any failure</option>${paired ? '<option value="different">Different outcomes</option>' : ''}</select></label><label>Order<select id="order"><option value="difference">Largest input gap</option><option value="name">Task name</option></select></label></div><div class="table-wrap"><table id="tasks"><thead><tr><th scope="col" rowspan="2">Task</th><th scope="col" rowspan="2">Family</th>${conditions.map((condition) => `<th scope="colgroup" colspan="4">${escapeHtml(condition)}</th>`).join('')}${paired ? '<th scope="col" rowspan="2" class="number">Input ratio</th>' : ''}<th scope="col" rowspan="2" class="number">Wall time (s)</th></tr><tr>${conditions.map(() => '<th scope="col">Pass</th><th scope="col" class="number">Input</th><th scope="col" class="number">Cache</th><th scope="col" class="number">Output</th>').join('')}</tr></thead><tbody>${tableRows}</tbody></table></div></section>
</main><script>${script}</script></body></html>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node eval/scripts/html-report.mjs [run-dir] [--out report.html] [--diagnoses diagnoses.json]\nDefaults to the latest finished run. Generates one standalone HTML file without raw prompts, answers or state.');
  } else {
    const outIndex = args.indexOf('--out');
    if (outIndex !== -1 && (!args[outIndex + 1] || args[outIndex + 1].startsWith('--'))) throw new Error('--out needs a file path');
    const diagnosesIndex = args.indexOf('--diagnoses');
    if (diagnosesIndex !== -1 && (!args[diagnosesIndex + 1] || args[diagnosesIndex + 1].startsWith('--'))) throw new Error('--diagnoses needs a JSON path');
    const consumed = new Set();
    for (const index of [outIndex, diagnosesIndex]) if (index >= 0) {
      consumed.add(index);
      consumed.add(index + 1);
    }
    const positional = args.filter((arg, index) => !consumed.has(index));
    if (positional.length > 1 || positional.some((arg) => arg.startsWith('--'))) throw new Error('expected one run directory and optionally --out <file> or --diagnoses <file>');
    const dir = resolve(positional[0] ?? latestRun());
    const out = resolve(outIndex < 0 ? join(dir, 'report.html') : args[outIndex + 1]);
    const diagnoses = diagnosesIndex < 0 ? null : JSON.parse(readFileSync(resolve(args[diagnosesIndex + 1]), 'utf8'));
    writeFileSync(out, renderHtmlReport(readRun(dir), basename(dir), { diagnoses }));
    console.log(`wrote ${out}`);
  }
}
