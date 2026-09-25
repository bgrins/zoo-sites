import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totalsByCondition } from '../report.mjs';
import { latestRun, readRun, transcriptCandidates } from '../run-files.mjs';

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
const groupClass = (index) => index % 2 ? 'surface-b' : 'surface-a';
const ratioCell = (value) => `<td class="number ratio-col"><span>${ratio(value)}</span></td>`;
export const brandMark = `<svg class="brand-mark" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M29 58V23M29 37 13 21M29 27 44 12M29 46 49 29M29 51 12 42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><g fill="#507b9d"><circle cx="13" cy="21" r="6"/><circle cx="44" cy="12" r="6"/><circle cx="49" cy="29" r="6"/><circle cx="12" cy="42" r="6"/></g></svg>`;
const traceName = (name) => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._@-]*\.jsonl$/.test(name) ? name : null;

export function tracePath(runDir, row, type) {
  const folder = type === 'transcript' ? 'transcripts' : type === 'rollout' ? 'rollouts' : null;
  if (!folder) return null;
  const sourceDir = join(runDir, folder);
  if (!existsSync(sourceDir) || !lstatSync(sourceDir).isDirectory()) return null;
  let names = [];
  if (type === 'transcript') {
    if (typeof row.transcript === 'string') names = [row.transcript];
    else if (typeof row.condition === 'string' && typeof row.task === 'string') names = transcriptCandidates(row);
  } else if (typeof row.rollout === 'string') {
    names = [row.rollout.replace(/^rollouts\//, '')];
  }
  for (const name of names) {
    const safeName = traceName(name);
    const file = safeName && join(sourceDir, safeName);
    if (file && existsSync(file) && lstatSync(file).isFile()) return file;
  }
  return null;
}

export const localTraceHref = (runDir, out) => (row, type) => {
  const file = tracePath(runDir, row, type);
  return file ? relative(dirname(out), file).split(sep).map(encodeURIComponent).join('/') : null;
};

const css = `
:root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #eef0ec; color: #303232; --ink: #303232; --blue: #507b9d; --mint: #c7ddcb; --line: #d5dad5; overflow-anchor: none; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 1180px; margin: 0 auto; padding: 0 28px 80px; }
header { display: grid; grid-template-rows: 1fr; padding: 27px 32px 32px; border-radius: 0 0 19px 19px; background: var(--ink); color: #fff; transition: grid-template-rows .2s ease, padding .2s ease; }
header .hero-inner { min-height: 0; overflow: hidden; }
header.has-compact-nav { grid-template-rows: 0fr; padding: 28px 0; border-radius: 0; }
header.has-compact-nav .hero-inner { pointer-events: none; }
header.has-compact-nav .report-nav { visibility: hidden; }
.report-compact { position: fixed; top: 0; left: 50%; z-index: 5; display: flex; align-items: center; gap: 18px; width: min(1124px, calc(100% - 56px)); padding: 10px 18px; background: var(--ink); color: #fff; box-shadow: 0 9px 26px #30323240; transform: translateX(-50%); visibility: hidden; }
.report-compact.is-visible { visibility: visible; }
.report-nav, .brand { display: flex; align-items: center; }
.report-nav { justify-content: space-between; gap: 18px; margin-bottom: 22px; }
.brand { flex: none; gap: 9px; font-family: Georgia, "Times New Roman", serif; font-size: 1.35rem; font-weight: 700; letter-spacing: -.05em; }
.brand-mark { width: 36px; height: 36px; flex: none; color: #fff; }
.brand small { font-family: system-ui, sans-serif; font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.compact-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: .88rem; font-weight: 600; }
.back-link { flex: none; border: 1px solid #aebcb0; border-radius: 999px; padding: 8px 13px; color: #fff; font-size: .8rem; font-weight: 650; text-decoration: none; white-space: nowrap; }
.back-link:hover { background: var(--mint); border-color: var(--mint); color: var(--ink); }
h1, h2 { font-family: Georgia, "Times New Roman", serif; }
h1 { font-size: clamp(2rem, 4vw, 3.2rem); letter-spacing: -.035em; line-height: 1.1; margin: 0; }
h2 { font-size: 1.42rem; letter-spacing: -.025em; margin: 0 0 14px; }
p { line-height: 1.55; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.meta span { background: #495251; padding: 6px 10px; border-radius: 6px; font-size: .81rem; color: #fff; }
section { margin-top: 38px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 14px; }
.comparison .summary { margin-top: 20px; }
.card, .panel { border: 1px solid var(--line); background: #fff; border-radius: 12px; box-shadow: 0 7px 22px #3032320c; }
.card { padding: 23px 25px; border-top: 5px solid #78a98b; }
.card:nth-child(2) { border-top-color: #c7a364; }
.comparison .card { background: #f7f9f7; box-shadow: none; }
.card h2 { font-size: 1.21rem; line-height: 1.3; margin-bottom: 14px; overflow-wrap: anywhere; }
.card dl { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; margin: 0; font-size: .86rem; }
.card dt { color: #596560; }.card dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 650; text-align: right; }
.panel { padding: 25px; }
.run-review-list { display: grid; gap: 14px; margin-top: 18px; }
.run-review-list article { padding: 15px 17px; border-left: 3px solid var(--mint); background: #f4f7f4; }
.run-review-list h3 { margin: 0 0 7px; font-size: 1rem; }
.run-review-list p { margin: 7px 0; font-size: .86rem; }
.run-review-list a { color: var(--blue); }
.run-review-list details { margin-top: 10px; font-size: .8rem; }
.overview { display: flex; gap: 30px; flex-wrap: wrap; align-items: flex-end; }
.comparison .overview { margin-top: 22px; }
.overview .figure { font-family: Georgia, "Times New Roman", serif; font-size: 2.1rem; font-weight: 700; line-height: 1; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.overview .figure-label { font-size: .84rem; color: #596560; margin-top: 7px; }
.method { font-size: .84rem; color: #596560; margin: 18px 0 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.section-head p { color: #647268; font-size: .88rem; margin: 0 0 16px; }
.table-wrap { container-type: inline-size; overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
.floating-head { position: fixed; z-index: 4; overflow: hidden; pointer-events: none; padding: 0 1px; box-shadow: 0 9px 20px #30323224; }
.floating-head table { table-layout: fixed; }
table { border-collapse: collapse; width: 100%; font-size: .86rem; }
th, td { padding: 11px 13px; text-align: left; border-bottom: 1px solid #e8ece7; vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
th { background: #e2eae3; color: var(--ink); font-size: .76rem; font-weight: 700; white-space: nowrap; }
thead th.surface-a { background: #dce9df; color: #305844; }
thead th.surface-b { background: #f2e7ce; color: #5d492b; }
tbody td.surface-a { background: #f1f7f2; }
tbody td.surface-b { background: #fbf8ef; }
tbody tr:hover td.surface-a { background: #e4f0e8; }
tbody tr:hover td.surface-b { background: #f5ecd8; }
th.group-start, td.group-start { border-left: 2px solid #b9c6c2; }
th.ratio-col { background: var(--blue); color: #fff; border-left: 2px solid #8aacc2; }
th.ratio-group { text-align: center; }
td.ratio-col { background: #eaf2f8; color: #244b66; border-left: 2px solid #b7cbd8; font-weight: 750; }
td.ratio-col span { display: inline-block; min-width: 4.1em; }
tbody tr:hover td.ratio-col { background: #dbeaf4; }
tbody tr:hover { background: #f0f5f3; }
thead tr:first-child th:first-child, tbody td:first-child { position: sticky; left: 0; z-index: 1; background: #e2eae3; }
tbody td:first-child { background: #fff; }
tbody tr:hover td:first-child { background: #f0f5f3; }
td.number, th.number { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.task-name { font-weight: 620; white-space: nowrap; }
.task-row { scroll-margin-top: 150px; }
.task-toggle { background: none; border: 0; color: inherit; cursor: pointer; font: inherit; font-weight: inherit; padding: 2px 5px; text-align: left; }
.task-toggle::before { content: ''; display: inline-block; width: 7px; height: 7px; margin: 0 10px 2px 1px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); transition: transform .15s; }
.task-toggle[aria-expanded="true"]::before { transform: rotate(45deg); }
.task-toggle:hover, .permalink:hover { text-decoration: underline; }
.permalink { margin-left: 8px; font-size: .78rem; color: var(--blue); text-decoration: none; }
.task-detail td, .task-detail td:first-child { background: #f4f7f4; position: static; }
.detail-grid { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); max-width: calc(100cqw - 32px); position: sticky; left: 0; padding: 8px 0; white-space: normal; }
.detail-grid.paired { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.detail-grid .detail-arm { min-width: 0; border: 1px solid var(--line); border-top: 4px solid #78a98b; border-radius: 10px; background: #f7fbf8; padding: 14px 17px; }
.detail-grid .detail-arm.surface-b { border-top-color: #c7a364; background: #fdfaf2; }
.detail-grid h3 { font-size: .88rem; margin: 0 0 8px; overflow-wrap: anywhere; }
.detail-grid p { margin: 6px 0; color: #415348; font-size: .84rem; }
.detail-grid .detail-family { grid-column: 1 / -1; margin: 0; }
.detail-grid .review { grid-column: 1 / -1; border-left: 2px solid #9cbfa7; padding: 6px 14px; }
@container (max-width: 680px) { .detail-grid.paired { grid-template-columns: minmax(0, 1fr); } }
.trace-links { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.review-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); margin: 16px 0; }
.review-grid section { margin: 0; }
.review-grid h4, .review h4 { margin: 12px 0 5px; font-size: .84rem; }
.review ul { margin: 6px 0; padding-left: 20px; font-size: .84rem; line-height: 1.5; }
.review li { margin: 5px 0; overflow-wrap: anywhere; }
.review details { margin-top: 8px; font-size: .82rem; }
.review summary { cursor: pointer; }
.review blockquote { margin: 6px 0; padding-left: 10px; border-left: 2px solid #becdc3; white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: #6b786f; }
.badge { display: inline-block; font-size: .72rem; font-weight: 750; border-radius: 99px; padding: 4px 9px; white-space: nowrap; }
.pass { color: #20593d; background: #dff0e4; }
.fail { color: #8f3d31; background: #fae5df; }
.controls { display: flex; gap: 11px; flex-wrap: wrap; margin: 0 0 17px; }
.controls label { display: flex; gap: 6px; flex-direction: column; color: #405447; font-size: .78rem; font-weight: 650; }
.controls input, .controls select { background: #fff; border: 1px solid #aebcb1; border-radius: 6px; font: inherit; font-size: .9rem; padding: 9px 11px; color: var(--ink); min-width: 150px; }
.controls input { min-width: min(270px, 80vw); }
:focus-visible { outline: 3px solid var(--blue); outline-offset: 2px; }
@media (max-width: 680px) { main { padding: 0 14px 55px; } header { padding: 19px; } header.has-compact-nav { padding: 27px 0; } .report-compact { width: calc(100% - 28px); padding: 10px; gap: 10px; } .report-nav { gap: 10px; } .brand { font-size: 1.05rem; } .brand-mark { width: 30px; height: 30px; } .panel { padding: 17px; } th, td { padding: 9px; } }
@media (max-width: 430px) { .report-compact .brand small { display: none; } }
@media (prefers-reduced-motion: reduce) { header { transition: none; } }
`;

const script = `
const reportHeader = document.querySelector('main > header');
const compactHeader = document.querySelector('.report-compact');
function updateHeader() {
  const visible = reportHeader.getBoundingClientRect().top < 0;
  compactHeader.classList.toggle('is-visible', visible);
  reportHeader.classList.toggle('has-compact-nav', visible);
}
const floatingHeads = Array.from(document.querySelectorAll('.table-wrap'), (wrapper) => {
  const table = wrapper.querySelector('table');
  const floating = document.createElement('div');
  floating.className = 'floating-head';
  floating.setAttribute('aria-hidden', 'true');
  floating.hidden = true;
  const copy = table.cloneNode(false);
  copy.removeAttribute('id');
  const columns = document.createElement('colgroup');
  copy.append(columns, table.tHead.cloneNode(true));
  floating.append(copy);
  document.body.append(floating);
  wrapper.addEventListener('scroll', updateFloatingHeads, { passive: true });
  return { wrapper, table, floating, copy, columns };
});
function measureFloatingHeads() {
  for (const { table, copy, columns } of floatingHeads) {
    const cells = [...table.tHead.rows[0].cells].filter((cell) => cell.rowSpan === 2).concat([...table.tHead.rows[1].cells]);
    columns.replaceChildren(...cells.map((cell) => {
      const column = document.createElement('col');
      column.style.width = cell.getBoundingClientRect().width + 'px';
      return column;
    }));
    copy.style.width = table.getBoundingClientRect().width + 'px';
  }
  updateFloatingHeads();
}
function updateFloatingHeads() {
  const top = compactHeader.getBoundingClientRect().height;
  for (const { wrapper, table, floating, copy } of floatingHeads) {
    const bounds = wrapper.getBoundingClientRect();
    const head = table.tHead.getBoundingClientRect();
    const visible = head.top <= top && bounds.bottom > top;
    if (floating.hidden === visible) floating.hidden = !visible;
    if (!visible) continue;
    floating.style.top = Math.min(top, bounds.bottom - head.height) + 'px';
    floating.style.left = bounds.left + 'px';
    floating.style.width = bounds.width + 'px';
    copy.style.transform = 'translateX(' + -wrapper.scrollLeft + 'px)';
    const pinned = copy.tHead.rows[0].cells[0];
    pinned.style.position = 'relative';
    pinned.style.zIndex = '2';
    pinned.style.transform = 'translateX(' + wrapper.scrollLeft + 'px)';
  }
}
window.addEventListener('scroll', () => { updateHeader(); updateFloatingHeads(); }, { passive: true });
window.addEventListener('resize', measureFloatingHeads);
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
  measureFloatingHeads();
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
updateHeader();
update();
revealHash();
`;

const judgeEvidence = (evidence) => evidence?.length
  ? `<details><summary>Evidence (${count(evidence.length)})</summary><ul>${evidence.map((entry) => `<li><strong>${escapeHtml(entry.file)}${entry.locator ? ` · ${escapeHtml(entry.locator)}` : ''}</strong><blockquote>${escapeHtml(entry.quote)}</blockquote></li>`).join('')}</ul></details>`
  : '';

const judgeArm = (arm, name) => {
  const verdict = [
    arm.grade_correct == null ? null : arm.grade_correct ? 'Grade confirmed' : 'Grade disputed',
    arm.legitimate == null ? null : arm.legitimate ? 'Outcome earned' : 'Outcome not earned',
  ].filter(Boolean).join(' · ');
  const trigger = arm.trigger?.step != null || arm.trigger?.tool
    ? `<p>Trigger: ${arm.trigger.step == null ? '' : `step ${count(arm.trigger.step)} · `}${escapeHtml(arm.trigger.tool ?? 'tool not recorded')}${arm.trigger.reply_quote ? ` · “${escapeHtml(arm.trigger.reply_quote)}”` : ''}</p>` : '';
  const wasted = arm.wasted_steps?.length
    ? `<h4>Wasted steps</h4><ul>${arm.wasted_steps.map((step) => `<li>${count(step.from)}${step.to !== step.from ? `–${count(step.to)}` : ''} · ${escapeHtml(step.cause)}: ${escapeHtml(step.why)}</li>`).join('')}</ul>` : '';
  return `<section><h4>${escapeHtml(name)}${arm.primary_cause ? ` · ${escapeHtml(arm.primary_cause)}` : ''}</h4>${verdict ? `<p class="muted">${verdict}</p>` : ''}${arm.summary ? `<p>${escapeHtml(arm.summary)}</p>` : ''}${arm.grade_note ? `<p>Grade: ${escapeHtml(arm.grade_note)}</p>` : ''}${arm.legitimacy_note ? `<p>Legitimacy: ${escapeHtml(arm.legitimacy_note)}</p>` : ''}${arm.cost_driver ? `<p>Cost driver: ${escapeHtml(arm.cost_driver)}</p>` : ''}${arm.contributing?.length ? `<p>Also: ${arm.contributing.map(escapeHtml).join(', ')}</p>` : ''}${trigger}${wasted}</section>`;
};

const judgeReview = (item) => {
  const diagnosis = item.diagnosis;
  const labels = [
    diagnosis.difference_driver ?? diagnosis.primary_cause,
    diagnosis.better_arm ? `better: ${diagnosis.better_arm}` : null,
    diagnosis.confidence ? `${diagnosis.confidence} confidence` : null,
    item.model ? `judge: ${item.model}${item.effort ? ` / ${item.effort}` : ''}` : null,
    item.gate ? `quotes kept: ${count(item.gate.kept)}/${count(item.gate.checked)}` : null,
    item.cost_usd != null ? `judge cost: $${Number(item.cost_usd).toFixed(4)}` : null,
    diagnosis.driver_unsupported || diagnosis.unsupported ? 'evidence limited' : null,
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const arms = diagnosis.arms ?? (item.kind === 'row' ? [diagnosis] : []);
  const differences = diagnosis.surface_differences?.length
    ? `<h4>Surface differences</h4><ul>${diagnosis.surface_differences.map((difference) => `<li>${escapeHtml(difference.what)}${difference.favours ? ` · favours ${escapeHtml(difference.favours)}` : ''}${difference.turns_delta == null ? '' : ` · turns ${count(difference.turns_delta)}`}${difference.tokens_delta == null ? '' : ` · output tokens ${count(difference.tokens_delta)}`}${difference.unsupported ? ' · evidence limited' : ''}${judgeEvidence(difference.evidence)}</li>`).join('')}</ul>` : '';
  const behaviours = diagnosis.tool_behaviours?.length
    ? `<h4>Tool behaviours</h4><ul>${diagnosis.tool_behaviours.map((behaviour) => `<li>${behaviour.arm ? `${escapeHtml(behaviour.arm)} · ` : ''}${escapeHtml(behaviour.tool)} · ${escapeHtml(behaviour.behaviour)}: ${escapeHtml(behaviour.effect)}${behaviour.turns == null ? '' : ` · turns ${count(behaviour.turns)}`}${behaviour.tokens == null ? '' : ` · output tokens ${count(behaviour.tokens)}`}${behaviour.unsupported ? ' · evidence limited' : ''}${judgeEvidence(behaviour.evidence)}</li>`).join('')}</ul>` : '';
  return `<article class="review"><h3>Model review${item.rep && item.rep !== 1 ? ` · repeat ${count(item.rep)}` : ''}</h3><p>${escapeHtml(diagnosis.summary)}</p>${labels ? `<p class="muted">${labels}</p>` : ''}${diagnosis.missing_arms?.length ? `<p>Missing verdict: ${diagnosis.missing_arms.map(escapeHtml).join(', ')}</p>` : ''}${arms.length ? `<div class="review-grid">${arms.map((arm, index) => judgeArm(arm, arm.arm ?? (item.kind === 'row' ? 'Attempt' : `Arm ${index + 1}`))).join('')}</div>` : ''}${differences}${behaviours}${diagnosis.tool_feedback ? `<p><strong>Tool feedback:</strong> ${escapeHtml(diagnosis.tool_feedback)}</p>` : ''}${judgeEvidence(diagnosis.evidence)}</article>`;
};

const runReviewHtml = (review) => {
  const details = (item) => `<p>${item.affected_tasks?.map((task) => `<a href="#${anchorFor(task)}">${escapeHtml(task)}</a>`).join(' · ') ?? ''}</p>${judgeEvidence(item.evidence)}`;
  const recommendations = (review.diagnosis.recommendations ?? []).map((item) => `<article><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.target)} · ${escapeHtml(item.priority)} priority${item.unsupported ? ' · evidence limited' : ''}</p><p>${escapeHtml(item.change)}</p><p>${escapeHtml(item.rationale)}</p>${details(item)}</article>`).join('');
  const findings = (review.diagnosis.findings ?? []).map((item) => `<article><p>${escapeHtml(item.claim)}${item.unsupported ? ' · evidence limited' : ''}</p>${details(item)}</article>`).join('');
  return `<section class="panel" aria-label="Run-wide review"><h2>Run-wide review</h2><p>${escapeHtml(review.diagnosis.summary)}</p><p class="muted">${escapeHtml(review.model)} / ${escapeHtml(review.effort)} · ${count(review.source.pairs)} judged pairs · ${escapeHtml(review.diagnosis.confidence)} confidence · quotes kept ${count(review.gate.kept)}/${count(review.gate.checked)}</p>${recommendations ? `<h3>Recommendations</h3><div class="run-review-list">${recommendations}</div>` : ''}${findings ? `<h3>Findings</h3><div class="run-review-list">${findings}</div>` : ''}${review.diagnosis.caveats ? `<p>Caveats: ${escapeHtml(review.diagnosis.caveats)}</p>` : ''}</section>`;
};

export function readRunReview(path, runName, diagnosesText, resultsText) {
  if (!diagnosesText || !resultsText) throw new Error('run-wide review needs its paired judgments and run results');
  const review = JSON.parse(readFileSync(path, 'utf8'));
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  if (review.run !== runName || review.mode !== 'run' || review.source?.judgments_sha256 !== hash(diagnosesText) || review.source?.results_sha256 !== hash(resultsText) || !review.diagnosis) throw new Error('run-wide review does not match the selected judgments or results');
  return review;
}

export function renderHtmlReport(run, runName = 'eval run', { homeHref = null, diagnoses = null, runReview = null, traceHref = null, title = 'Browser-agent evaluation' } = {}) {
  if (diagnoses && diagnoses.run !== runName) throw new Error(`diagnoses belong to ${diagnoses.run}, not ${runName}`);
  if (runReview && (runReview.run !== runName || runReview.mode !== 'run' || runReview.source?.pairs !== diagnoses?.items?.filter((item) => item.kind === 'pair').length)) throw new Error('run-wide review needs the matching complete pair judgments');
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
  const wallMatched = paired ? pairs.filter((task) => task.complete && task.arms.every((arm) => arm.wall > 0)) : [];
  const wallRatio = geometricMean(wallMatched.map((task) => task.arms[0].wall / task.arms[1].wall));
  const outputMatched = paired ? pairs.filter((task) => task.complete && task.arms.every((arm) => arm.output > 0)) : [];
  const outputRatio = geometricMean(outputMatched.map((task) => task.arms[0].output / task.arms[1].output));
  const flips = pairs.filter((task) => task.different).length;
  const cards = conditions.map((condition) => {
    const total = totals[condition] ?? {};
    return `<article class="card"><h2>${escapeHtml(condition)}</h2><dl><dt>Pass</dt><dd>${count(total.passed)} / ${count(total.tasks)}</dd><dt>Input tokens</dt><dd>${count(input(total))}</dd><dt>Cache-read share</dt><dd>${percent(cacheShare([total]))}</dd><dt>Output tokens</dt><dd>${count(total.output_tokens)}</dd><dt>Task time (sum)</dt><dd>${seconds(total.wall_s)}</dd>${total.cost_usd == null ? '' : `<dt>Estimated cost</dt><dd>$${Number(total.cost_usd).toFixed(2)}</dd>`}</dl></article>`;
  }).join('\n');
  const familyNames = [...new Set(pairs.map((task) => task.family))].sort();
  const families = familyNames.map((family) => {
    const group = pairs.filter((task) => task.family === family);
    const cells = conditions.map((condition, index) => {
      const attempts = group.flatMap((task) => task.arms[index].attempts);
      const surface = groupClass(index);
      return `<td class="${surface} group-start">${group.reduce((total, task) => total + task.arms[index].passes, 0)}/${attempts.length}</td><td class="${surface} number">${count(attempts.reduce((total, row) => total + (input(row) ?? 0), 0))}</td><td class="${surface} number">${percent(cacheShare(attempts))}</td><td class="${surface} number">${count(sum(attempts, 'output_tokens'))}</td>`;
    }).join('');
    const familyMatched = paired ? group.filter((task) => task.complete && task.arms.every((arm) => arm.input > 0)) : [];
    const familyRatio = paired ? geometricMean(familyMatched.map((task) => task.arms[0].input / task.arms[1].input)) : null;
    const familyWallMatched = paired ? group.filter((task) => task.complete && task.arms.every((arm) => arm.wall > 0)) : [];
    const familyWallRatio = paired ? geometricMean(familyWallMatched.map((task) => task.arms[0].wall / task.arms[1].wall)) : null;
    return `<tr><td>${escapeHtml(family)}</td><td class="number">${count(group.length)}</td>${paired ? ratioCell(familyRatio) + ratioCell(familyWallRatio) : ''}${cells}</tr>`;
  }).join('\n');
  const tableRows = pairs.map((task) => {
    const cells = task.arms.map((arm, index) => {
      const surface = groupClass(index);
      return `<td class="${surface} group-start">${arm.attempts.length ? `${badge(arm.passes === arm.attempts.length)}${arm.attempts.length > 1 ? ` <span class="muted">${arm.passes}/${arm.attempts.length}</span>` : ''}` : '—'}</td><td class="${surface} number">${count(arm.input)}</td><td class="${surface} number">${percent(arm.cache)}</td><td class="${surface} number">${count(arm.output)}</td><td class="${surface} number">${seconds(arm.wall)}</td>`;
    }).join('');
    const inputGap = paired && task.arms.every((arm) => arm.input > 0) ? task.arms[0].input / task.arms[1].input : null;
    const wallGap = paired && task.arms.every((arm) => arm.wall > 0) ? task.arms[0].wall / task.arms[1].wall : null;
    const anchor = anchorFor(task.id);
    const details = task.arms.map((arm, index) => {
      const tools = new Map();
      for (const attempt of arm.attempts) for (const [name, stats] of Object.entries(attempt.tools ?? {})) {
        tools.set(name, (tools.get(name) ?? 0) + (stats.calls ?? 0));
      }
      const topTools = [...tools].sort((left, right) => right[1] - left[1]).slice(0, 5);
      const traces = arm.attempts.map((row, attempt) => {
        const links = ['transcript', 'rollout'].map((type) => {
          const href = traceHref?.(row, type);
          return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${type === 'transcript' ? 'Full transcript' : 'Full rollout'}</a>` : '';
        }).filter(Boolean);
        return links.length ? `<p class="trace-links">${arm.attempts.length > 1 ? `Repeat ${count(row.rep ?? attempt + 1)} · ` : ''}${links.join(' · ')}</p>` : '';
      }).join('');
      return `<article class="detail-arm ${groupClass(index)}"><h3>${escapeHtml(conditions[index])}</h3><p>${arm.passes}/${arm.attempts.length} passed · ${count(median(arm.attempts.map((row) => row.turns)))} turns · ${seconds(arm.wall)} task time</p><p>Median per attempt: input ${count(arm.input)} · cache reads ${count(median(arm.attempts.map((row) => row.cache_read)))} · cache writes ${count(median(arm.attempts.map((row) => row.cache_creation)))} · output ${count(arm.output)}</p><p>Top tools: ${topTools.length ? topTools.map(([name, calls]) => `${escapeHtml(name)} (${count(calls)})`).join(', ') : 'not recorded'}</p>${traces}</article>`;
    }).join('');
    const reviews = (diagnoses?.items ?? []).filter((item) => item.task === task.id && ['row', 'pair'].includes(item.kind) && typeof item.diagnosis?.summary === 'string');
    const reviewHtml = reviews.map(judgeReview).join('');
    const columns = 1 + conditions.length * 5 + Number(paired) * 2;
    return `<tr class="task-row" id="${anchor}" data-task="${escapeHtml(task.id)}" data-family="${escapeHtml(task.family)}" data-failure="${task.failure}" data-different="${task.different}" data-difference="${inputGap == null ? 0 : Math.abs(Math.log(inputGap))}"><td class="task-name"><button class="task-toggle" type="button" aria-expanded="false" aria-controls="${anchor}-detail">${escapeHtml(task.id)}</button><a class="permalink" href="#${anchor}" aria-label="Link to ${escapeHtml(task.id)}">#</a></td>${paired ? ratioCell(inputGap) + ratioCell(wallGap) : ''}${cells}</tr><tr class="task-detail" id="${anchor}-detail" hidden><td colspan="${columns}"><div class="detail-grid${paired ? ' paired' : ''}"><p class="detail-family">Family: ${escapeHtml(task.family)}</p>${details}${reviewHtml}</div></td></tr>`;
  }).join('\n');
  const date = Number.isFinite(Date.parse(run.meta?.date)) ? new Date(run.meta.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Date not recorded';
  const models = [...new Set(rows.map((row) => row.model).filter(Boolean))].join(', ') || 'Model not recorded';
  const backends = [...new Set(rows.map((row) => row.backend).filter(Boolean))].join(', ') || run.meta?.backend || 'Backend not recorded';
  const metadata = [date, models, backends, `${tasks.size} tasks`, run.meta?.suite && `Suite: ${run.meta.suite}`, run.meta?.git?.commit && `Eval: ${run.meta.git.commit.slice(0, 10)}`].filter(Boolean);
  const metaHtml = metadata.map((item) => `<span>${escapeHtml(item)}</span>`).join('');
  const brandHtml = `<div class="brand">${brandMark}<span>the_zoo <small>/ Evals</small></span></div>`;
  const backLinkHtml = homeHref ? `<a class="back-link" href="${escapeHtml(homeHref)}">All reports</a>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Eval report · ${escapeHtml(runName)}</title><style>${css}</style></head>
<body><main><header><div class="hero-inner"><div class="report-nav">${brandHtml}${backLinkHtml}</div><h1>${escapeHtml(title)}</h1><div class="meta">${metaHtml}</div></div></header><nav class="report-compact" aria-label="Report navigation">${brandHtml}<span class="compact-title">${escapeHtml(title)}</span>${backLinkHtml}</nav>
${paired ? `<section class="panel comparison" aria-label="Comparison"><h2>Comparison</h2><div class="overview"><div><div class="figure">${ratio(inputRatio)}</div><div class="figure-label">Input ratio</div></div><div><div class="figure">${ratio(wallRatio)}</div><div class="figure-label">Wall-clock ratio</div></div><div><div class="figure">${ratio(outputRatio)}</div><div class="figure-label">Output ratio</div></div><div><div class="figure">${flips}</div><div class="figure-label">Different pass outcomes</div></div></div><p class="method">${count(matched.length)} paired tasks · ratios above 1 mean ${escapeHtml(conditions[0])} used more</p><div class="summary">${cards}</div></section>` : `<section aria-label="Results by condition"><div class="summary">${cards}</div></section>`}
${runReview ? runReviewHtml(runReview) : ''}
<section><div class="section-head"><h2>By task family</h2><p>Token totals and pass rate by surface</p></div><div class="table-wrap"><table><thead><tr><th scope="col" rowspan="2">Family</th><th scope="col" rowspan="2" class="number">Tasks</th>${paired ? '<th scope="colgroup" colspan="2" class="ratio-col ratio-group">Ratios</th>' : ''}${conditions.map((condition, index) => `<th scope="colgroup" colspan="4" class="${groupClass(index)} group-start">${escapeHtml(condition)}</th>`).join('')}</tr><tr>${paired ? '<th scope="col" class="number ratio-col" aria-label="Input ratio">Input</th><th scope="col" class="number ratio-col" aria-label="Wall-clock ratio">Wall</th>' : ''}${conditions.map((condition, index) => `<th scope="col" class="${groupClass(index)} group-start">Pass</th><th scope="col" class="${groupClass(index)} number">Input</th><th scope="col" class="${groupClass(index)} number">Cache</th><th scope="col" class="${groupClass(index)} number">Output</th>`).join('')}</tr></thead><tbody>${families}</tbody></table></div></section>
<section><div class="section-head"><h2>Tasks</h2><p id="visible" aria-live="polite">${tasks.size} tasks shown</p></div><div class="controls"><label>Search tasks<input id="search" type="search" placeholder="Task name"></label><label>Family<select id="family"><option value="">All families</option>${familyNames.map((family) => `<option value="${escapeHtml(family)}">${escapeHtml(family)}</option>`).join('')}</select></label><label>Outcome<select id="outcome"><option value="all">All outcomes</option><option value="failures">Any failure</option>${paired ? '<option value="different">Different outcomes</option>' : ''}</select></label><label>Order<select id="order"><option value="difference">Largest input gap</option><option value="name">Task name</option></select></label></div><div class="table-wrap"><table id="tasks"><thead><tr><th scope="col" rowspan="2">Task</th>${paired ? '<th scope="colgroup" colspan="2" class="ratio-col ratio-group">Ratios</th>' : ''}${conditions.map((condition, index) => `<th scope="colgroup" colspan="5" class="${groupClass(index)} group-start">${escapeHtml(condition)}</th>`).join('')}</tr><tr>${paired ? '<th scope="col" class="number ratio-col" aria-label="Input ratio">Input</th><th scope="col" class="number ratio-col" aria-label="Wall-clock ratio">Wall</th>' : ''}${conditions.map((condition, index) => `<th scope="col" class="${groupClass(index)} group-start">Pass</th><th scope="col" class="${groupClass(index)} number">Input</th><th scope="col" class="${groupClass(index)} number">Cache</th><th scope="col" class="${groupClass(index)} number">Output</th><th scope="col" class="${groupClass(index)} number" aria-label="Wall time">Wall</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></div></section>
</main><script>${script}</script></body></html>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node eval/scripts/html-report.mjs [run-dir] [--out report.html] [--diagnoses diagnoses.json] [--review diagnoses-run.json]\nDefaults to the latest finished run. Links to local graded traces when present. Judge evidence and traces may contain task answers; review before publishing.');
  } else {
    const outIndex = args.indexOf('--out');
    if (outIndex !== -1 && (!args[outIndex + 1] || args[outIndex + 1].startsWith('--'))) throw new Error('--out needs a file path');
    const diagnosesIndex = args.indexOf('--diagnoses');
    if (diagnosesIndex !== -1 && (!args[diagnosesIndex + 1] || args[diagnosesIndex + 1].startsWith('--'))) throw new Error('--diagnoses needs a JSON path');
    const reviewIndex = args.indexOf('--review');
    if (reviewIndex !== -1 && (!args[reviewIndex + 1] || args[reviewIndex + 1].startsWith('--'))) throw new Error('--review needs a JSON path');
    const consumed = new Set();
    for (const index of [outIndex, diagnosesIndex, reviewIndex]) if (index >= 0) {
      consumed.add(index);
      consumed.add(index + 1);
    }
    const positional = args.filter((arg, index) => !consumed.has(index));
    if (positional.length > 1 || positional.some((arg) => arg.startsWith('--'))) throw new Error('expected one run directory and optionally --out, --diagnoses, or --review');
    const dir = resolve(positional[0] ?? latestRun());
    const out = resolve(outIndex < 0 ? join(dir, 'report.html') : args[outIndex + 1]);
    const diagnosesText = diagnosesIndex < 0 ? null : readFileSync(resolve(args[diagnosesIndex + 1]), 'utf8');
    const diagnoses = diagnosesText ? JSON.parse(diagnosesText) : null;
    const runReview = reviewIndex < 0 ? null : readRunReview(resolve(args[reviewIndex + 1]), basename(dir), diagnosesText, readFileSync(join(dir, 'results.json'), 'utf8'));
    writeFileSync(out, renderHtmlReport(readRun(dir), basename(dir), { diagnoses, runReview, traceHref: localTraceHref(dir, out) }));
    console.log(`wrote ${out}`);
  }
}
