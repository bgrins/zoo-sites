// Generates the Trelowen Land Trust ledger fixture:
//   pages/ledger/index.html + page-2.html .. page-7.html  (paginated postings;
//   the last page carries one extra entry, so pages x rows-per-page is the
//   WRONG total)
//   sites/ledger-rows.mjs  (row source of truth; the CSV export endpoint in
//   server.mjs reads this file)
// This generator and the row source both live OUTSIDE pages/ so neither is
// reachable over HTTP from the served static root.
// Run: node scripts/gen/ledger.mjs
// The generated answers (hardware total, max amount, row count) are printed at
// the end for copying into answers.mjs.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = dirname(self);
const PAGES_DIR = join(here, '..', '..', 'pages', 'ledger');
const ROWS_MODULE = join(here, '..', '..', 'sites', 'ledger-rows.mjs');

const PAGE_COUNT = 7;
const PER_PAGE = 20;
const TOTAL_ROWS = PAGE_COUNT * PER_PAGE + 1;
// Index of the one capital purchase, deliberately deep in the ledger.
const BIG_ROW = 96;
const ORG = 'Trelowen Land Trust';

const DESCRIPTIONS = {
  hardware: [
    'Trail camera replacement',
    'Soil probe kit',
    'Field laptop dock',
    'Weather station mast',
    'Water pump rebuild kit',
    'Gate hardware and locks',
    'Handheld GPS unit',
    'Battery bank for cabin',
    'Chainsaw and safety gear',
    'Solar panel bracket set',
    'Culvert pipe section',
    'Deer fencing rolls',
    'Two-way radio pair',
    'Bench grinder for shop',
  ],
  travel: [
    'Mileage - north parcel',
    'Mileage - county hearing',
    'Lodging - regional summit',
    'Rail fare - state capital',
    'Fuel - survey truck',
    'Parking - permit office',
    'Per diem - field crew',
    'Airfare - land trust forum',
    'Ferry fare - island survey',
  ],
  software: [
    'GIS subscription renewal',
    'Accounting seat license',
    'Mapping plugin license',
    'Cloud backup tier',
    'Donor database renewal',
    'E-signature credits',
    'Survey app annual plan',
    'Website hosting renewal',
  ],
  misc: [
    'Printing - annual report',
    'Postage - donor mailing',
    'Permit filing fee',
    'Volunteer refreshments',
    'Native seed mix',
    'Legal notice publication',
    'Storage unit rent',
    'First aid restock',
    'Sign printing - trailhead',
  ],
};

const RANGES = {
  hardware: [55, 1450],
  travel: [22, 780],
  software: [95, 1150],
  misc: [12, 420],
};

const TAG_WEIGHTS = [
  ['hardware', 0.27],
  ['travel', 0.24],
  ['software', 0.22],
  ['misc', 0.27],
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (n) => Math.round(n * 100);
const money = (n) =>
  n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',');

function pickTag(r) {
  let acc = 0;
  for (const [tag, weight] of TAG_WEIGHTS) {
    acc += weight;
    if (r < acc) return tag;
  }
  return 'misc';
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function build(seed) {
  const rand = rng(seed);
  const rows = [];
  // Postings land on weekdays only; the cursor walks forward 1-2 business days
  // per entry so the ledger covers roughly January through July 2026.
  const cursor = new Date(Date.UTC(2026, 0, 5));
  for (let i = 0; i < TOTAL_ROWS; i++) {
    if (i > 0) {
      const draw = rand();
      let steps = draw < 0.25 ? 0 : draw < 0.8 ? 1 : 2;
      while (steps-- > 0) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }
    }
    const tag = i === BIG_ROW ? 'hardware' : pickTag(rand());
    const pool = DESCRIPTIONS[tag];
    const description =
      i === BIG_ROW ? 'Utility trailer purchase' : pool[Math.floor(rand() * pool.length)];
    const [min, max] = RANGES[tag];
    const amount =
      i === BIG_ROW
        ? Math.round((3200 + rand() * 600) * 100) / 100
        : Math.round((min + rand() * (max - min)) * 100) / 100;
    rows.push({ date: isoDate(cursor), description, tag, amount });
  }
  return rows;
}

function pageSlice(rows, page) {
  const start = (page - 1) * PER_PAGE;
  return page === PAGE_COUNT ? rows.slice(start) : rows.slice(start, start + PER_PAGE);
}

function analyze(rows) {
  const tagTotals = { hardware: 0, travel: 0, software: 0, misc: 0 };
  const tagCounts = { hardware: 0, travel: 0, software: 0, misc: 0 };
  for (const row of rows) {
    tagTotals[row.tag] = Math.round((tagTotals[row.tag] + row.amount) * 100) / 100;
    tagCounts[row.tag]++;
  }
  const pageTotals = [];
  const pageHardware = [];
  for (let page = 1; page <= PAGE_COUNT; page++) {
    const slice = pageSlice(rows, page);
    pageTotals.push(
      Math.round(slice.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
    );
    pageHardware.push(slice.filter((row) => row.tag === 'hardware').length);
  }
  const grand = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
  const sorted = [...rows].map((row) => row.amount).sort((a, b) => b - a);
  return {
    tagTotals,
    tagCounts,
    pageTotals,
    pageHardware,
    grand,
    max: sorted[0],
    runnerUp: sorted[1],
    maxRows: rows.filter((row) => row.amount === sorted[0]).length,
  };
}

function problems(rows) {
  const a = analyze(rows);
  const out = [];
  const h = cents(a.tagTotals.hardware);
  if (h % 10 === 0) out.push(`hardware total ${a.tagTotals.hardware} is a round figure`);
  for (const [tag, total] of Object.entries(a.tagTotals)) {
    if (tag === 'hardware') continue;
    if (Math.abs(h - cents(total)) < 100) out.push(`${tag} total collides with hardware`);
  }
  a.pageTotals.forEach((total, idx) => {
    if (Math.abs(h - cents(total)) < 100) out.push(`page ${idx + 1} total collides`);
  });
  if (Math.abs(h - cents(a.grand)) < 100) out.push('grand total collides with hardware');
  for (const row of rows) {
    if (Math.abs(h - cents(row.amount)) < 100) out.push('a single amount collides with hardware');
    if (/[",]/.test(row.description)) out.push(`description not CSV-safe: ${row.description}`);
  }
  if (a.maxRows !== 1) out.push(`largest amount ${a.max} is not unique`);
  if (cents(a.max) % 10 === 0) out.push(`largest amount ${a.max} is a round figure`);
  if (a.max - a.runnerUp < 10) out.push('largest amount is within $10 of the runner-up');
  if (rows[BIG_ROW].amount !== a.max) out.push('largest amount is not the designated capital row');
  for (const [tag, count] of Object.entries(a.tagCounts)) {
    if (count < 25) out.push(`only ${count} ${tag} rows`);
  }
  a.pageHardware.forEach((count, idx) => {
    if (count < 3) out.push(`page ${idx + 1} has only ${count} hardware rows`);
  });
  const last = rows.at(-1).date;
  if (last < '2026-07-01' || last > '2026-07-31') out.push(`last date ${last} out of range`);
  return out;
}

const head = (title, subtitle) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html { background: #d9d3c4; }
  body { font-family: "Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", serif;
    color: #241f1a; margin: 0; font-size: 15px; line-height: 1.45; }
  .strip { background: #4d1f27; color: #e8d9cf; font-size: 10px; letter-spacing: 0.2em;
    text-transform: uppercase; padding: 5px 0; }
  .strip .inner, .sheet { max-width: 720px; margin: 0 auto; }
  .strip .inner { display: flex; justify-content: space-between; padding: 0 40px; }
  .sheet { background: #fdfbf5; border: 1px solid #c9c0ac; border-top: 0;
    box-shadow: 0 2px 6px rgba(60, 48, 36, 0.18); padding: 30px 40px 34px; }
  .masthead { display: flex; align-items: baseline; justify-content: space-between; }
  .masthead .org { font-size: 21px; letter-spacing: 0.09em; text-transform: uppercase; }
  .masthead .folio { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #6b5f52; }
  .rule { border-bottom: 3px solid #4d1f27; margin-top: 7px; }
  .rule-thin { border-bottom: 1px solid #4d1f27; margin-top: 2px; margin-bottom: 18px; }
  h1 { font-size: 17px; font-weight: normal; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 10px; }
  dl.facts { display: grid; grid-template-columns: 8em 1fr; gap: 2px 14px; margin: 0 0 16px;
    font-size: 13px; }
  dl.facts dt { color: #6b5f52; font-size: 11px; letter-spacing: 0.11em; text-transform: uppercase;
    padding-top: 2px; }
  dl.facts dd { margin: 0; }
  .note { font-size: 13px; font-style: italic; color: #55483c; margin: 0 0 16px; }
  .toolbar { display: flex; align-items: baseline; gap: 14px; border-top: 1px solid #ddd3bf;
    border-bottom: 1px solid #ddd3bf; padding: 9px 0; margin-bottom: 20px; }
  button { font-family: inherit; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    padding: 6px 13px; background: #fdfbf5; color: #4d1f27; border: 1px solid #4d1f27;
    border-radius: 0; cursor: pointer; }
  button:hover { background: #4d1f27; color: #fdfbf5; }
  .toolbar .hint { font-size: 12px; font-style: italic; color: #6b5f52; }
  #export-status { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: #4d1f27; margin-left: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  caption { text-align: left; font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase;
    color: #6b5f52; padding: 0 0 6px; }
  th, td { padding: 3px 8px; border-bottom: 1px solid #e7dfcd; text-align: left; }
  td + td, th + th { border-left: 1px solid #e7dfcd; }
  thead th { font-size: 10px; font-weight: normal; letter-spacing: 0.15em; text-transform: uppercase;
    color: #4d1f27; border-bottom: 1px solid #8a7b6a; padding-bottom: 5px; }
  td.amount, th.amount { text-align: right; font-family: "Courier New", Courier, monospace;
    font-size: 13px; white-space: nowrap; }
  th.amount { font-family: inherit; font-size: 10px; letter-spacing: 0.15em; }
  td.date { white-space: nowrap; font-family: "Courier New", Courier, monospace; font-size: 12px;
    color: #4b4034; }
  td.tag { font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: #6b5f52; }
  tfoot td { border-top: 3px double #8a7b6a; border-bottom: 0; padding-top: 6px;
    font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
  tfoot td.amount { letter-spacing: 0; font-size: 13px; }
  .pager { text-align: center; margin: 22px 0 4px; font-size: 12px; letter-spacing: 0.06em; }
  .pager a { color: #4d1f27; text-decoration: none; border-bottom: 1px solid #c4a8ac; }
  .pager a:hover { border-bottom-color: #4d1f27; }
  .pager .nums { margin: 0 10px; }
  .pager .nums a, .pager .current { padding: 2px 6px; }
  .pager .current { color: #4d1f27; font-weight: 700; border: 1px solid #4d1f27; }
  .pager .off { color: #a89b8b; }
  .pageline { text-align: center; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #6b5f52; margin: 0; }
  footer { border-top: 1px solid #ddd3bf; margin-top: 24px; padding-top: 10px; font-size: 11px;
    line-height: 1.5; color: #74695c; }
  @media print {
    html, .sheet { background: #fff; }
    .strip, .toolbar, .pager { display: none; }
    .sheet { border: 0; box-shadow: none; max-width: none; padding: 0; }
  }
</style>
</head>
<body>
<div class="strip"><div class="inner"><span>Bookkeeping &middot; Operating fund</span><span>${subtitle}</span></div></div>
`;

function renderPage(rows, page) {
  const slice = pageSlice(rows, page);
  const subtotal = Math.round(slice.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
  const file = (n) => (n === 1 ? 'index.html' : `page-${n}.html`);
  const nums = [];
  for (let n = 1; n <= PAGE_COUNT; n++) {
    nums.push(
      n === page
        ? `<span class="current" aria-current="page">${n}</span>`
        : `<a href="${file(n)}">${n}</a>`
    );
  }
  const prev =
    page === 1
      ? '<span class="off">Previous</span>'
      : `<a href="${file(page - 1)}">Previous</a>`;
  const next =
    page === PAGE_COUNT
      ? '<span class="off">Next</span>'
      : `<a href="${file(page + 1)}">Next</a>`;
  const pager = `  <nav class="pager" aria-label="Ledger pages">
    ${prev}
    <span class="nums">${nums.join('\n    ')}</span>
    ${next}
  </nav>
  <p class="pageline">Page ${page} of ${PAGE_COUNT}</p>
`;
  const body = slice
    .map(
      (row) => `      <tr>
        <td class="date">${row.date}</td>
        <td>${row.description}</td>
        <td class="tag">${row.tag}</td>
        <td class="amount">$${money(row.amount)}</td>
      </tr>`
    )
    .join('\n');

  return `${head(
    `Transaction Ledger - Page ${page} - ${ORG}`,
    'Fiscal 2026 &middot; unaudited'
  )}<main class="sheet">
  <div class="masthead">
    <span class="org">${ORG}</span>
    <span class="folio">Folio ${page}</span>
  </div>
  <div class="rule"></div>
  <div class="rule-thin"></div>
  <h1>Transaction Ledger</h1>
  <dl class="facts">
    <dt>Fund</dt><dd>Operating</dd>
    <dt>Period</dt><dd>Fiscal year 2026, postings entered oldest first</dd>
    <dt>Basis</dt><dd>Cash; every posting carries one tag: hardware, travel, software, or misc</dd>
    <dt>Prepared by</dt><dd>K. Ostergaard, bookkeeper</dd>
  </dl>
  <p class="note">Amounts are entered as posted. Subtotals shown at the foot of each
  folio cover that folio only and are not carried forward.</p>
  <div class="toolbar">
    <button id="export" type="button">Export CSV</button>
    <span class="hint">Exports every posting in the ledger, not just this folio.</span>
    <span id="export-status" role="status"></span>
  </div>
${pager}  <table>
    <caption>Ledger postings &middot; folio ${page}</caption>
    <thead>
      <tr><th>Date</th><th>Description</th><th>Tag</th><th class="amount">Amount</th></tr>
    </thead>
    <tbody>
${body}
    </tbody>
    <tfoot>
      <tr><td colspan="3">Folio subtotal</td><td class="amount">$${money(subtotal)}</td></tr>
    </tfoot>
  </table>
${pager}  <footer>${ORG} &middot; Old Creamery Road, Trelowen &middot; registered
  charity no. 08-2247. Postings are reviewed annually by Harrow &amp; Pike, chartered
  accountants. Queries about an entry: bookkeeping@trelowentrust.example</footer>
</main>
<script>
  const NONCE = '__SESSION_NONCE__';
  const status = document.getElementById('export-status');
  fetch('/api/beacon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: NONCE, kind: 'ledger-folio', data: { page: ${page} } }),
  }).catch(() => {});
  document.getElementById('export').addEventListener('click', async () => {
    status.textContent = 'Preparing export...';
    try {
      const res = await fetch('/api/ledger/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: NONCE, page: ${page} }),
      });
      if (!res.ok) {
        status.textContent = 'Export failed - reload the page and try again.';
        return;
      }
      const data = await res.json();
      status.textContent = 'Export ready - opening CSV.';
      window.location.assign(data.url);
    } catch {
      status.textContent = 'Export failed - reload the page and try again.';
    }
  });
</script>
</body>
</html>
`;
}

let seed = 0;
let rows = null;
let issues = null;
for (let candidate = 1; candidate <= 4000; candidate++) {
  const built = build(candidate);
  const found = problems(built);
  if (!found.length) {
    seed = candidate;
    rows = built;
    issues = found;
    break;
  }
  if (!issues || found.length < issues.length) {
    issues = found;
  }
}
if (!rows) {
  console.error('no seed satisfied the constraints; closest issues:');
  for (const issue of issues ?? []) console.error(`  - ${issue}`);
  process.exit(1);
}

const stats = analyze(rows);
const rowLines = rows
  .map(
    (row) =>
      `  { date: ${JSON.stringify(row.date)}, description: ${JSON.stringify(row.description)}, ` +
      `tag: ${JSON.stringify(row.tag)}, amount: ${row.amount} },`
  )
  .join('\n');
await writeFile(
  ROWS_MODULE,
  `// The ${rows.length} ledger postings, shared by two consumers: sites/ledger.mjs serves them\n` +
    `// as the CSV export, and scripts/gen/ledger.mjs renders the seven folio pages\n` +
    `// from them. Kept out of pages/ so the rows are not fetchable as a file, which\n` +
    `// is what makes ledger-sum a per-page extraction task rather than one GET.\n` +
    `export const LEDGER_ROWS = [\n${rowLines}\n];\n`
);
const pageFiles = [];
for (let page = 1; page <= PAGE_COUNT; page++) {
  const name = page === 1 ? 'index.html' : `page-${page}.html`;
  const file = join(PAGES_DIR, name);
  await writeFile(file, renderPage(rows, page));
  pageFiles.push(file);
}

// The graded figures must not appear anywhere an agent can read: the served
// fixture (read back off disk), the row source, or this generator itself.
const rendered = [
  ...(await Promise.all(pageFiles.map((file) => readFile(file, 'utf8')))),
  await readFile(self, 'utf8'),
].join('\n');
const leaks = [
  [
    'hardware total',
    new RegExp(
      money(stats.tagTotals.hardware).replace(',', '[,\\s]?').replace('.', '\\.')
    ),
  ],
  ['row count', new RegExp(`(?<![\\d,.])${TOTAL_ROWS}(?!\\d|,\\d|\\.\\d)`)],
].filter(([, re]) => re.test(rendered));

console.log(`seed ${seed}`);
console.log(`rows ${rows.length} (pages 1-6 x ${PER_PAGE}, page ${PAGE_COUNT} x ${pageSlice(rows, PAGE_COUNT).length})`);
console.log('tag counts', stats.tagCounts);
console.log('tag totals', stats.tagTotals);
console.log('page totals', stats.pageTotals.map(money).join('  '));
console.log('hardware rows per page', stats.pageHardware.join(' '));
console.log(`grand total $${money(stats.grand)}`);
console.log(`largest amount $${money(stats.max)} (runner-up $${money(stats.runnerUp)})`);
console.log(
  leaks.length
    ? `LEAK in fixture: ${leaks.map(([what]) => what).join(', ')}`
    : 'no graded figure leaks into fixture source'
);
console.log('\nanswers.mjs entry:\n');
console.log(`  // pages/ledger/ (generated by gen/ledger.mjs, seed ${seed}) — the ledger
  // is static page content, so the answer key lives here only. The hardware
  // total ($${money(stats.tagTotals.hardware)}) collides with no other tag total, page subtotal,
  // grand total, or single amount (asserted at generation time); the largest
  // single amount ($${money(stats.max)}) is unique and leads the runner-up by more
  // than $10.
  ledger: {
    rowCount: ${TOTAL_ROWS},
    rowCountRe: /(?<![\\d,.])${TOTAL_ROWS}(?!\\d|,\\d|\\.\\d)/,
    hardwareTotal: ${stats.tagTotals.hardware},
    maxAmount: ${stats.max},
  },`);
