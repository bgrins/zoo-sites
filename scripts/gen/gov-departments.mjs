// Generates the Bureau of Civic Revenue department directory under
// pages/gov/departments/ — a five-level tree of 127 legacy pages for
// the `dept-descent` and `breadcrumb-sibling` eval tasks.
//
// This lives outside pages/ on purpose: everything under pages/ is served over
// HTTP, and a generator that prints the answer key would be a one-request
// cheat. Run it from the repo root:
//
//   node scripts/gen/gov-departments.mjs
//
// Output is deterministic (a fixed tree, a fixed integer hash for hours, rooms
// and lines, no clock, no randomness), so regeneration is byte-stable and a
// re-run leaves `git status` clean. The output directory is wiped first, so
// shape changes never leave orphan pages behind.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pages', 'gov', 'departments');

// The graded facts. Only the two target desk pages ever carry these strings;
// assertTargetsUnique() fails the build if a filler page collides.
const TARGET = {
  path: ['assessment-standards', 'field-operations', 'ground-works'],
  desk: 'subsurface-permits',
  hours: 'Tue &amp; Thu 9:15 AM - 12:45 PM',
  phone: '(804) 555-0163',
};
const SIBLING = { desk: 'surface-permits', phone: '(804) 555-0178' };

// Where the near-miss desks live: the division an agent reaches for first when
// told to find a permits desk.
const DECOY_SECTION = 'permits-and-clearances/occupancy-consents/change-of-use';
const DECOY_DESKS = { 'subsurface-utility-notices': 'Subsurface', 'surface-water-permits': 'Surface' };

// Every line in the tree is a direct line in the NANP 555-0100 to 555-0199
// fiction block under one area code. These are published on the top-level gov
// pages (general, TTY, status line, the three satellite offices, Purchasing) or
// belong to the two graded desks, so no filler desk may take one.
const AREA = '804';
const RESERVED_LINES = new Set([100, 101, 102, 103, 110, 111, 112, 163, 178]);

const desk = (slug, name) => ({ kind: 'desk', slug, name });
const section = (slug, name, blurb, children) => ({ kind: 'section', slug, name, blurb, children });
const office = (slug, name, blurb, children) => ({ kind: 'office', slug, name, blurb, children });
const division = (slug, name, blurb, children) => ({ kind: 'division', slug, name, blurb, children });

const DIVISIONS = [
  division(
    'assessment-standards',
    'Assessment Standards Division',
    'Maintains the assessment manuals and valuation tables, reviews declared values, and inspects sites in the field, including excavation and ground works.',
    [
      office(
        'field-operations',
        'Office of Field Operations',
        'Field inspection crews, site access, and permits for excavation and ground works.',
        [
          section(
            'ground-works',
            'Ground Works Section',
            'Subsurface and surface permitting, boring notices and trench inspection.',
            [
              desk('subsurface-permits', 'Subsurface Permits Desk'),
              desk('surface-permits', 'Surface Permits Desk'),
              desk('boring-notices', 'Boring Notices Desk'),
            ]
          ),
          section(
            'site-inspection',
            'Site Inspection Section',
            'Scheduled and complaint-driven inspections of declared improvements.',
            [
              desk('inspection-scheduling', 'Inspection Scheduling Desk'),
              desk('complaint-inspections', 'Complaint Inspections Desk'),
              desk('reinspection-requests', 'Reinspection Requests Desk'),
            ]
          ),
          section(
            'field-audit-support',
            'Field Audit Support Section',
            'Scheduling, travel and survey equipment for field audit teams.',
            [
              desk('audit-scheduling', 'Audit Scheduling Desk'),
              desk('survey-equipment', 'Survey Equipment Desk'),
            ]
          ),
        ]
      ),
      office(
        'valuation-review',
        'Office of Valuation Review',
        'Reviews declared values against comparable sales and the published depreciation tables, and dockets appeals.',
        [
          section(
            'comparable-sales',
            'Comparable Sales Section',
            'Verifies reported sales and maintains the adjustment factors.',
            [
              desk('sales-verification', 'Sales Verification Desk'),
              desk('adjustment-factors', 'Adjustment Factors Desk'),
            ]
          ),
          section(
            'depreciation-tables',
            'Depreciation Tables Section',
            'Age-life tables and condition ratings for declared property and vehicles.',
            [
              desk('age-life-tables', 'Age-Life Tables Desk'),
              desk('condition-ratings', 'Condition Ratings Desk'),
              desk('vehicle-valuation', 'Vehicle Valuation Desk'),
            ]
          ),
          section(
            'appeals-intake',
            'Appeals Intake Section',
            'Receives and dockets appeals of assessed values and schedules hearings.',
            [
              desk('appeal-docketing', 'Appeal Docketing Desk'),
              desk('hearing-calendar', 'Hearing Calendar Desk'),
              desk('hearing-exhibits', 'Hearing Exhibits Desk'),
            ]
          ),
        ]
      ),
      office(
        'methodology-standards',
        'Office of Methodology Standards',
        'Assessment manuals, rate studies and inspector training.',
        [
          section(
            'rate-studies',
            'Rate Studies Section',
            'The annual rate and trend studies behind the valuation tables.',
            [
              desk('annual-rate-study', 'Annual Rate Study Desk'),
              desk('trend-analysis', 'Trend Analysis Desk'),
            ]
          ),
          section(
            'training-standards',
            'Training Standards Section',
            'Inspector certification, refresher courses and quality sampling.',
            [
              desk('inspector-certification', 'Inspector Certification Desk'),
              desk('refresher-courses', 'Refresher Courses Desk'),
              desk('quality-sampling', 'Quality Sampling Desk'),
            ]
          ),
        ]
      ),
    ]
  ),
  division(
    'permits-and-clearances',
    'Permits and Clearances Division',
    'Issues certificates of occupancy and change-of-use consents, and licenses street furniture, signage and temporary uses of public space.',
    [
      office(
        'occupancy-consents',
        'Office of Occupancy Consents',
        'Certificates of occupancy and change-of-use consents.',
        [
          section(
            'change-of-use',
            'Change of Use Section',
            'Reclassification of occupied premises, with the utility and drainage notices a change of use requires.',
            [
              // The near misses: a desk whose name also starts "Subsurface", and
              // one that also starts "Surface".
              desk('subsurface-utility-notices', 'Subsurface Utility Notices Desk'),
              desk('surface-water-permits', 'Surface Water Permits Desk'),
              desk('reclassification-requests', 'Reclassification Requests Desk'),
            ]
          ),
          section(
            'certificate-issue',
            'Certificate Issue Section',
            'Printing and mailing of issued certificates.',
            [
              desk('certificate-printing', 'Certificate Printing Desk'),
              desk('temporary-certificates', 'Temporary Certificates Desk'),
            ]
          ),
          section(
            'premises-records',
            'Premises Records Section',
            'Occupancy histories and certificate searches for premises changing hands.',
            [
              desk('occupancy-histories', 'Occupancy Histories Desk'),
              desk('certificate-searches', 'Certificate Searches Desk'),
            ]
          ),
        ]
      ),
      office(
        'street-furniture',
        'Office of Street Furniture',
        'Benches, kiosks, planters, signs and other fixed objects on or over the sidewalk.',
        [
          section(
            'sidewalk-fixtures',
            'Sidewalk Fixtures Section',
            'Placement review for benches, planters and bus shelters.',
            [
              desk('bench-placement', 'Bench Placement Desk'),
              desk('bus-shelters', 'Bus Shelters Desk'),
              desk('planter-licenses', 'Planter Licenses Desk'),
            ]
          ),
          section(
            'signs-and-kiosks',
            'Signs and Kiosks Section',
            'Projecting signs, awnings, and vending and information kiosks.',
            [
              desk('projecting-signs', 'Projecting Signs Desk'),
              desk('awning-consents', 'Awning Consents Desk'),
              desk('kiosk-siting', 'Kiosk Siting Desk'),
            ]
          ),
        ]
      ),
      office(
        'temporary-use',
        'Office of Temporary Use',
        'Short-term consents for events, filming and seasonal uses of public space.',
        [
          section(
            'event-staging',
            'Event Staging Section',
            'Staging areas, barricades and street closures for permitted events.',
            [
              desk('street-closures', 'Street Closures Desk'),
              desk('barricade-requests', 'Barricade Requests Desk'),
              desk('filming-consents', 'Filming Consents Desk'),
            ]
          ),
          section(
            'seasonal-consents',
            'Seasonal Consents Section',
            'Outdoor seating, holiday markets and other seasonal uses.',
            [
              desk('outdoor-seating', 'Outdoor Seating Desk'),
              desk('holiday-markets', 'Holiday Markets Desk'),
            ]
          ),
        ]
      ),
    ]
  ),
  division(
    'collections-and-remittance',
    'Collections and Remittance Division',
    'Receives and posts payments, administers installment agreements, and follows up delinquent balances through notices, liens and write-off review.',
    [
      office(
        'payment-processing',
        'Office of Payment Processing',
        'Lockbox, counter and electronic remittance.',
        [
          section(
            'lockbox-operations',
            'Lockbox Operations Section',
            'Opening and posting of mailed remittances.',
            [
              desk('mail-opening', 'Mail Opening Desk'),
              desk('remittance-posting', 'Remittance Posting Desk'),
              desk('unapplied-payments', 'Unapplied Payments Desk'),
            ]
          ),
          section(
            'counter-receipts',
            'Counter Receipts Section',
            'Window payments and same-day receipting.',
            [
              desk('window-payments', 'Window Payments Desk'),
              desk('receipt-corrections', 'Receipt Corrections Desk'),
            ]
          ),
          section(
            'returned-items',
            'Returned Items Section',
            'Checks returned unpaid, and the returned-item charge.',
            [
              desk('returned-checks', 'Returned Checks Desk'),
              desk('charge-reversals', 'Charge Reversals Desk'),
            ]
          ),
        ]
      ),
      office(
        'delinquency-review',
        'Office of Delinquency Review',
        'Aged balances, liens and write-off recommendations.',
        [
          section(
            'aged-balances',
            'Aged Balances Section',
            'Balances past the second notice cycle.',
            [
              desk('second-notices', 'Second Notices Desk'),
              desk('account-reconciliation', 'Account Reconciliation Desk'),
              desk('balance-inquiries', 'Balance Inquiries Desk'),
            ]
          ),
          section(
            'lien-preparation',
            'Lien Preparation Section',
            'Preparation, recording and release of revenue liens.',
            [
              desk('lien-recording', 'Lien Recording Desk'),
              desk('lien-releases', 'Lien Releases Desk'),
              desk('payoff-statements', 'Payoff Statements Desk'),
            ]
          ),
          section(
            'write-off-review',
            'Write-Off Review Section',
            'Uncollectible balances recommended for write-off.',
            [
              desk('write-off-recommendations', 'Write-Off Recommendations Desk'),
              desk('bankruptcy-claims', 'Bankruptcy Claims Desk'),
            ]
          ),
        ]
      ),
      office(
        'installment-agreements',
        'Office of Installment Agreements',
        'Payment plans and hardship deferrals.',
        [
          section(
            'hardship-review',
            'Hardship Review Section',
            'Deferral requests on documented hardship.',
            [
              desk('deferral-requests', 'Deferral Requests Desk'),
              desk('hardship-documentation', 'Hardship Documentation Desk'),
            ]
          ),
          section(
            'plan-monitoring',
            'Plan Monitoring Section',
            'Enrollment in payment plans, compliance checks and default notices.',
            [
              desk('plan-enrollment', 'Plan Enrollment Desk'),
              desk('plan-compliance', 'Plan Compliance Desk'),
              desk('default-notices', 'Default Notices Desk'),
            ]
          ),
        ]
      ),
    ]
  ),
  division(
    'records-and-disclosure',
    'Records and Disclosure Division',
    'Keeps the filing archive and the retention schedule, issues certified copies, publishes Bureau forms, and answers public records requests.',
    [
      office(
        'filing-archive',
        'Office of the Filing Archive',
        'Retention, retrieval and certified copies.',
        [
          section(
            'retention-schedules',
            'Retention Schedules Section',
            'Disposal authorities and litigation holds.',
            [
              desk('disposal-authorities', 'Disposal Authorities Desk'),
              desk('litigation-holds', 'Litigation Holds Desk'),
            ]
          ),
          section(
            'retrieval-services',
            'Retrieval Services Section',
            'Pulls from the Statehouse Plaza stacks and the microfilm library.',
            [
              desk('stack-retrieval', 'Stack Retrieval Desk'),
              desk('microfilm-library', 'Microfilm Library Desk'),
              desk('certified-copies', 'Certified Copies Desk'),
            ]
          ),
          section(
            'records-transfer',
            'Records Transfer Section',
            'Boxes transferred from the divisions to the records center.',
            [
              desk('transfer-scheduling', 'Transfer Scheduling Desk'),
              desk('box-indexing', 'Box Indexing Desk'),
            ]
          ),
        ]
      ),
      office(
        'disclosure-requests',
        'Office of Disclosure Requests',
        'Public records requests and redaction review.',
        [
          section(
            'request-triage',
            'Request Triage Section',
            'Routing, fee estimates and appeals for records requests.',
            [
              desk('request-intake', 'Request Intake Desk'),
              desk('fee-estimates', 'Fee Estimates Desk'),
              desk('denial-appeals', 'Denial Appeals Desk'),
            ]
          ),
          section(
            'redaction-review',
            'Redaction Review Section',
            'Exemption analysis before records are released.',
            [
              desk('exemption-review', 'Exemption Review Desk'),
              desk('release-scheduling', 'Release Scheduling Desk'),
              desk('third-party-notices', 'Third-Party Notices Desk'),
            ]
          ),
        ]
      ),
      office(
        'forms-control',
        'Office of Forms Control',
        'Form numbering, revision control, print orders and alternate formats.',
        [
          section(
            'revision-control',
            'Revision Control Section',
            'Form revision dates and supersession notices.',
            [
              desk('form-revisions', 'Form Revisions Desk'),
              desk('supersession-notices', 'Supersession Notices Desk'),
            ]
          ),
          section(
            'print-orders',
            'Print Orders Section',
            'Bulk print runs and the forms-by-mail stock.',
            [
              desk('bulk-printing', 'Bulk Printing Desk'),
              desk('forms-by-mail', 'Forms by Mail Desk'),
              desk('forms-stock', 'Forms Stock Desk'),
            ]
          ),
          section(
            'alternate-formats',
            'Alternate Formats Section',
            'Large print and audio cassette editions of Bureau forms.',
            [
              desk('large-print', 'Large Print Desk'),
              desk('audio-editions', 'Audio Editions Desk'),
            ]
          ),
        ]
      ),
    ]
  ),
];

const FILLER_HOURS = [
  'Mon - Fri 8:30 AM - 4:30 PM',
  'Mon &amp; Wed 10:00 AM - 2:00 PM',
  'Tue - Fri 8:00 AM - 3:00 PM',
  'Wed &amp; Fri 1:00 PM - 4:00 PM',
  'Mon - Thu 9:00 AM - 3:30 PM',
  'Thu only 10:30 AM - 2:30 PM',
];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const usedLines = new Set(RESERVED_LINES);
function lineFor(key) {
  let n = 100 + (hash(key) % 100);
  for (let tries = 0; usedLines.has(n); tries++) {
    if (tries === 100) throw new Error('the 555-0100 to 555-0199 block is exhausted');
    n = n === 199 ? 100 : n + 1;
  }
  usedLines.add(n);
  return `(${AREA}) 555-0${n}`;
}

// --- tree shape -------------------------------------------------------------

function place(node, parentPath) {
  node.path = [...parentPath, node.slug];
  const key = node.path.join('/');
  if (node.kind === 'desk') {
    const isTarget = key === [...TARGET.path, TARGET.desk].join('/');
    const isSibling = key === [...TARGET.path, SIBLING.desk].join('/');
    node.hours = isTarget ? TARGET.hours : FILLER_HOURS[hash(key) % FILLER_HOURS.length];
    node.phone = isTarget ? TARGET.phone : isSibling ? SIBLING.phone : lineFor(key);
    node.room = 100 + (hash('room' + key) % 380);
    node.stop = `MS ${10 + (hash('stop' + key) % 80)}`;
    return node;
  }
  for (const child of node.children) place(child, node.path);
  return node;
}

const ROOT = {
  kind: 'root',
  name: 'Department Directory',
  path: [],
  children: DIVISIONS.map((d) => place(d, [])),
};

// --- rendering --------------------------------------------------------------

const CHILD_WORDS = {
  root: 'divisions',
  division: 'offices',
  office: 'sections',
  section: 'public service desks',
};

function up(n) {
  return n === 0 ? './' : '../'.repeat(n);
}

// A desk page is a file inside its section directory, so it sits at the same
// directory depth as its section; `toRoot` is the relative path from a page to
// pages/gov/.
function toRoot(node) {
  const dirDepth = node.kind === 'desk' ? node.path.length - 1 : node.path.length;
  return '../'.repeat(dirDepth + 1);
}

function crumbs(node) {
  if (node.kind === 'root') return 'You are here: Directory';
  let cursor = ROOT;
  const parts = [];
  for (const slug of node.path) {
    cursor = cursor.children.find((c) => c.slug === slug);
    parts.push(cursor);
  }
  const dirDepth = node.kind === 'desk' ? node.path.length - 1 : node.path.length;
  const trail = [`<a href="${up(dirDepth)}">Directory</a>`];
  parts.forEach((p, i) => {
    if (p === node || p.kind === 'desk') {
      trail.push(shortName(p.name));
    } else {
      trail.push(`<a href="${up(dirDepth - (i + 1))}">${shortName(p.name)}</a>`);
    }
  });
  return `You are here: ${trail.join(' &gt; ')}`;
}

function shortName(name) {
  return name
    .replace(/^Office of the /, '')
    .replace(/^Office of /, '')
    .replace(/ (Division|Section|Desk)$/, '');
}

const REV = '03/25';

// Desk pages carry a page-view beacon: the second, same-session factor behind
// the dept-descent / breadcrumb-sibling gates. The server substitutes both
// placeholders per session, and __GOV_PAGE_TOKEN__ is bound to this page's path,
// so the beacon proves this page's own script ran for this session — the
// navigation record alone only proves the request was not an in-page fetch
// (`curl -H 'Sec-Fetch-Mode: navigate'` sets that header freely).
const VIEW_BEACON = `<script type="text/javascript">
(function () {
  var p = location.pathname;
  if (p.charAt(p.length - 1) === '/') p += 'index.html';
  try {
    fetch('/api/gov/page-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Nonce': '__SESSION_NONCE__' },
      body: JSON.stringify({ path: p, token: '__GOV_PAGE_TOKEN__', nonce: '__SESSION_NONCE__' }),
      keepalive: true,
    });
  } catch (e) {}
})();
</script>`;

function shell(title, node, body, tail = '') {
  const root = toRoot(node);
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<link rel="icon" type="image/svg+xml" href="${root}favicon.svg"><title>${title} - Bureau of Civic Revenue</title></head>
<body bgcolor="#FFFFFF" text="#000000" link="#0000CC" vlink="#551A8B">
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr bgcolor="#003366"><td><a href="${root}index.html" style="color:#FFFFFF;text-decoration:none"><font color="#FFFFFF" size="4" face="Times New Roman"><b>BUREAU OF CIVIC REVENUE</b></font></a><br>
<font color="#CCCCCC" size="1">DEPARTMENT DIRECTORY</font></td></tr>
</table>
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr><td>
<font size="1">${crumbs(node)}</font>
${body}
<hr>
<font size="1">Directory listings are maintained by the Records and Disclosure Division.
Rev. ${REV}. Report an incorrect listing to the webmaster through the Correspondence Unit.<br>
[ <a href="${root}index.html">Main Page</a> ] [ <a href="${root}contact.html">Contact the Bureau</a> ]
[ <a href="${root}privacy.html">Privacy Statement</a> ] [ <a href="${root}terms.html">Terms of Use</a> ]<br>
&copy; Bureau of Civic Revenue. An agency of the Commonwealth. Revenue Building, Statehouse Plaza.</font>
</td></tr>
</table>
${tail}</body>
</html>
`;
}

function renderBranch(node) {
  const intro =
    node.kind === 'root'
      ? `<p>The Bureau is organized into four divisions. Each division listing continues to its offices, sections and public service desks. Counter hours and direct telephone lines are published on the desk pages.</p>`
      : `<p>${node.blurb} The ${CHILD_WORDS[node.kind]} of this ${node.kind} are listed below.</p>`;
  const items = node.children
    .map((c) => {
      const href = c.kind === 'desk' ? `${c.slug}.html` : `${c.slug}/`;
      const label = c.kind === 'desk' ? '' : ` &mdash; ${c.blurb}`;
      return `<li><a href="${href}">${c.name}</a>${label}</li>`;
    })
    .join('\n');
  return shell(
    node.kind === 'root' ? 'Department Directory' : node.name,
    node,
    `<h2>${node.kind === 'root' ? 'Department Directory' : node.name}</h2>
<font size="2">
${intro}
<ul>
${items}
</ul>
</font>`
  );
}

// The fact table follows filing-status.html: bordered, khaki header cells,
// <font> inside every cell.
function renderDesk(node) {
  const row = (label, value, shade) =>
    `<tr${shade ? ' bgcolor="#EEEEEE"' : ''}><td bgcolor="#CCCC99" width="32%"><font size="2"><b>${label}</b></font></td>` +
    `<td><font size="2">${value}</font></td></tr>`;
  return shell(
    node.name,
    node,
    `<h2>${node.name}</h2>
<font size="2">
<table width="90%" border="1" cellspacing="0" cellpadding="3">
${row('Public counter hours', node.hours, false)}
${row('Telephone', node.phone, true)}
${row('Window', `Room ${node.room}, Revenue Building`, false)}
${row('Interoffice mail', node.stop, true)}
</table>
<p>Walk-in service is offered at the desk's window during the counter hours shown above.
General counter service for all form types is given at the Central Office, 1 Assessment
Plaza, 4th Floor. Outside counter hours the desk accepts filings through the lobby drop box
at the Revenue Building.</p>
<p>Telephone inquiries are answered on the direct line above. Please leave one message
only; duplicate messages are removed from the queue before calls are returned.</p>
</font>`,
    VIEW_BEACON + '\n'
  );
}

// --- write ------------------------------------------------------------------

const files = [];
const counts = { root: 0, division: 0, office: 0, section: 0, desk: 0 };
function collect(node) {
  counts[node.kind] += 1;
  if (node.kind === 'desk') {
    files.push([join(...node.path.slice(0, -1), `${node.slug}.html`), renderDesk(node)]);
    return;
  }
  files.push([join(...node.path, 'index.html'), renderBranch(node)]);
  for (const child of node.children) collect(child);
}
collect(ROOT);

function assertTargetsUnique() {
  const problems = [];
  const count = (needle) =>
    files.filter(([, html]) => html.includes(needle)).map(([f]) => f);
  const local = (phone) => phone.slice(-8);
  for (const needle of ['9:15', '12:45', local(TARGET.phone)]) {
    const hits = count(needle);
    const want = join(...TARGET.path, `${TARGET.desk}.html`);
    if (hits.length !== 1 || hits[0] !== want) {
      problems.push(`"${needle}" appears in ${hits.length} page(s): ${hits.join(', ')}`);
    }
  }
  const siblingHits = count(local(SIBLING.phone));
  const siblingWant = join(...TARGET.path, `${SIBLING.desk}.html`);
  if (siblingHits.length !== 1 || siblingHits[0] !== siblingWant) {
    problems.push(`"${local(SIBLING.phone)}" appears in ${siblingHits.length} page(s): ${siblingHits.join(', ')}`);
  }
  if (files.some(([, html]) => /<input|<form/.test(html))) {
    problems.push('a tree page carries a form or input; tree pages must have no search box');
  }
  // Every desk page must be able to prove its own script ran: without the
  // beacon and both placeholders, the graded gate loses its second factor.
  for (const [rel, html] of files) {
    const isDesk = !rel.endsWith('index.html');
    const wired =
      html.includes('/api/gov/page-view') &&
      html.includes('__GOV_PAGE_TOKEN__') &&
      html.includes('__SESSION_NONCE__');
    if (isDesk !== wired) {
      problems.push(
        isDesk
          ? `desk page ${rel} is missing the page-view beacon`
          : `listing page ${rel} carries the desk page-view beacon`
      );
    }
  }
  for (const [d, prefix] of Object.entries(DECOY_DESKS)) {
    const want = join(...DECOY_SECTION.split('/'), `${d}.html`);
    const page = files.find(([rel]) => rel === want);
    if (!page) {
      problems.push(`near-miss decoy desk missing: ${want}`);
    } else if (!page[1].includes(`<title>${prefix} `)) {
      problems.push(`near-miss decoy desk ${want} no longer has a name starting "${prefix}"`);
    }
  }
  const deskHours = files.filter(([rel]) => !rel.endsWith('index.html'));
  const targetPage = join(...TARGET.path, `${TARGET.desk}.html`);
  for (const [rel, html] of deskHours) {
    if (rel !== targetPage && /Tue[^<]*Thu/.test(html)) {
      problems.push(`filler desk ${rel} advertises Tue & Thu hours, muddying the target`);
    }
  }
  const slugs = new Set(files.map(([rel]) => rel));
  if (slugs.size !== files.length) problems.push('two tree nodes share a path');
  if (problems.length) throw new Error('generator invariant broken:\n  ' + problems.join('\n  '));
}
assertTargetsUnique();

await rm(OUT, { recursive: true, force: true });
for (const [rel, html] of files) {
  const abs = join(OUT, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, html);
}

console.log(`wrote ${files.length} pages to pages/gov/departments/`);
console.log(
  `  levels: ${counts.root} directory root, ${counts.division} divisions, ` +
    `${counts.office} offices, ${counts.section} sections, ${counts.desk} desks`
);
console.log('');
console.log('ANSWER KEY (maintainer only — never served):');
console.log(`  dept-descent      path: /gov/departments/${TARGET.path.join('/')}/${TARGET.desk}.html`);
console.log(`  dept-descent     hours: ${TARGET.hours.replace('&amp;', '&')}`);
console.log(`  breadcrumb-sibling path: /gov/departments/${TARGET.path.join('/')}/${SIBLING.desk}.html`);
console.log(`  breadcrumb-sibling phone: ${SIBLING.phone}  (start page's own decoy: ${TARGET.phone})`);
console.log(`  decoy desks: Subsurface Utility Notices, Surface Water Permits`);
console.log(`    under /gov/departments/${DECOY_SECTION}/`);
