// Generates the Bureau of Civic Revenue department directory under
// pages/gov/departments/ — a five-level tree of ~120 legacy pages for
// the `dept-descent` and `breadcrumb-sibling` eval tasks.
//
// This lives outside pages/ on purpose: everything under pages/ is served over
// HTTP, and a generator that prints the answer key would be a one-request
// cheat. Run it from the repo root:
//
//   node scripts/gen/gov-departments.mjs
//
// Output is deterministic (fixed name pools, a fixed integer hash for branch
// counts, no clock, no randomness), so regeneration is byte-stable and a
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
  phone: '(555) 014-3391',
};
const SIBLING = { desk: 'surface-permits', phone: '(555) 014-8862' };

// Where the near-miss desks live: the division an agent reaches for first when
// told to find a permits desk.
const DECOY_OFFICE = 'permits-and-clearances/occupancy-consents';
const DECOY_SECTION = `${DECOY_OFFICE}/change-of-use`;
const DECOY_DESKS = ['subsurface-utility-notices', 'surface-water-permits'];

// Listing blurbs are FRONT-LOADED with the words that discriminate between
// branches: a snapshot shows only the first 27 characters of a list item's text,
// so a blurb that buries "ground works" at the end leaves the tree unnavigable
// through the snapshot and forces every agent into a 127-page walk.
const DIVISIONS = [
  {
    slug: 'assessment-standards',
    name: 'Assessment Standards Division',
    blurb: 'Ground works, site permits, valuation methodology and field inspection.',
  },
  {
    slug: 'permits-and-clearances',
    name: 'Permits and Clearances Division',
    blurb: 'Occupancy clearances, street cuts, signage and temporary use consents.',
  },
  {
    slug: 'collections-and-remittance',
    name: 'Collections and Remittance Division',
    blurb: 'Payments and instalments, delinquency and write-off review.',
  },
  {
    slug: 'records-and-disclosure',
    name: 'Records and Disclosure Division',
    blurb: 'Filing archive, certified copies, disclosure requests and retention.',
  },
];

const OFFICE_POOL = [
  ['valuation-review', 'Office of Valuation Review', 'Reviews declared values and comparable schedules.'],
  ['appeals-intake', 'Office of Appeals Intake', 'Receives and dockets assessment appeals.'],
  ['occupancy-consents', 'Office of Occupancy Consents', 'Certificates of occupancy and change-of-use consents.'],
  ['street-furniture', 'Office of Street Furniture', 'Benches, kiosks, planters and sidewalk fixtures.'],
  ['temporary-use', 'Office of Temporary Use', 'Short-term consents for events and staging areas.'],
  ['payment-processing', 'Office of Payment Processing', 'Lockbox, counter and electronic remittance.'],
  ['delinquency-review', 'Office of Delinquency Review', 'Aged balances, liens and write-off recommendations.'],
  ['instalment-agreements', 'Office of Instalment Agreements', 'Payment plans and hardship deferrals.'],
  ['filing-archive', 'Office of the Filing Archive', 'Retention, retrieval and certified copies.'],
  ['disclosure-requests', 'Office of Disclosure Requests', 'Public records requests and redaction review.'],
  ['forms-control', 'Office of Forms Control', 'Form numbering, revision control and print orders.'],
  ['methodology-standards', 'Office of Methodology Standards', 'Assessment manuals, tables and rate studies.'],
];

const SECTION_POOL = [
  ['comparable-sales', 'Comparable Sales Section', 'Sales verification and adjustment factors.'],
  ['depreciation-tables', 'Depreciation Tables Section', 'Age-life tables and condition ratings.'],
  ['docket-control', 'Docket Control Section', 'Appeal numbering, calendars and continuances.'],
  ['hearing-support', 'Hearing Support Section', 'Exhibit preparation and hearing transcripts.'],
  ['change-of-use', 'Change of Use Section', 'Reclassification of occupied premises.'],
  ['certificate-issue', 'Certificate Issue Section', 'Printing and mailing of issued certificates.'],
  ['sidewalk-fixtures', 'Sidewalk Fixtures Section', 'Placement review for fixed sidewalk objects.'],
  ['kiosk-review', 'Kiosk Review Section', 'Vending and information kiosk siting.'],
  ['event-staging', 'Event Staging Section', 'Staging areas, barricades and closures.'],
  ['seasonal-consents', 'Seasonal Consents Section', 'Warm-weather and holiday-period consents.'],
  ['lockbox-operations', 'Lockbox Operations Section', 'Mailed remittance opening and posting.'],
  ['counter-receipts', 'Counter Receipts Section', 'Window payments and same-day receipting.'],
  ['aged-balances', 'Aged Balances Section', 'Balances past the second notice cycle.'],
  ['lien-preparation', 'Lien Preparation Section', 'Preparation and recording of revenue liens.'],
  ['hardship-review', 'Hardship Review Section', 'Deferral requests on documented hardship.'],
  ['plan-monitoring', 'Plan Monitoring Section', 'Instalment compliance and default notices.'],
  ['retention-schedules', 'Retention Schedules Section', 'Disposal authorities and holds.'],
  ['retrieval-services', 'Retrieval Services Section', 'Pulls from the Statehouse Plaza stacks.'],
  ['redaction-review', 'Redaction Review Section', 'Exemption analysis before release.'],
  ['request-triage', 'Request Triage Section', 'Routing and fee estimates for requests.'],
  ['revision-control', 'Revision Control Section', 'Form revision dates and supersession.'],
  ['print-orders', 'Print Orders Section', 'Bulk print runs and stock levels.'],
  ['rate-studies', 'Rate Studies Section', 'Annual rate and trend studies.'],
  ['manual-maintenance', 'Manual Maintenance Section', 'Assessment manual amendments.'],
  ['field-audit-support', 'Field Audit Support Section', 'Scheduling and logistics for field audits.'],
  ['boundary-verification', 'Boundary Verification Section', 'Parcel boundary and frontage checks.'],
  ['drainage-review', 'Drainage Review Section', 'Surface water and drainage referrals.'],
  ['structures-review', 'Structures Review Section', 'Accessory structures and outbuildings.'],
  ['equipment-pool', 'Equipment Pool Section', 'Survey instruments and vehicle assignment.'],
  ['training-standards', 'Training Standards Section', 'Inspector certification and refreshers.'],
  ['quality-sampling', 'Quality Sampling Section', 'Re-inspection sampling and error rates.'],
  ['mapping-support', 'Mapping Support Section', 'Plat sheets, overlays and index maps.'],
  ['notice-production', 'Notice Production Section', 'Assessment and delinquency notice runs.'],
  ['correspondence', 'Correspondence Section', 'Written enquiries and standard replies.'],
];

const DESK_AREAS = [
  'Frontage', 'Easement', 'Culvert', 'Hydrant', 'Driveway', 'Awning', 'Signage',
  'Vault', 'Alley', 'Boundary', 'Outbuilding', 'Fence Line', 'Roof Access',
  'Loading Bay', 'Meter Pit', 'Tree Well', 'Bus Shelter', 'Canopy', 'Retaining Wall',
  'Basement', 'Rooftop Plant', 'Yard Storage', 'Ramp', 'Stair Tower',
];
const DESK_FUNCTIONS = ['Permits', 'Appeals', 'Assessments', 'Abatements', 'Notices', 'Clearances'];

const FILLER_HOURS = [
  'Mon - Fri 8:30 AM - 4:30 PM',
  'Mon &amp; Wed 10:00 AM - 2:00 PM',
  'Tue - Fri 8:00 AM - 3:00 PM',
  'Wed &amp; Fri 1:00 PM - 4:00 PM',
  'Mon - Thu 9:00 AM - 3:30 PM',
  'Thu only 10:30 AM - 2:30 PM',
];

// Phone extensions already published on gov/offices.html, kept out of the tree
// so a desk number can never be confused with a satellite office number.
const RESERVED_EXT = new Set([2200, 2261, 2274, 2288, 3391, 8862]);

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const usedExt = new Set(RESERVED_EXT);
function phoneFor(slugPath) {
  let ext = 1000 + (hash(slugPath) % 9000);
  while (usedExt.has(ext)) ext = ext === 9999 ? 1000 : ext + 1;
  usedExt.add(ext);
  return `(555) 014-${String(ext).padStart(4, '0')}`;
}

const usedSlugs = new Set();
let deskCursor = 0;
function nextDeskName() {
  for (let i = 0; i < DESK_AREAS.length * DESK_FUNCTIONS.length; i++) {
    const n = deskCursor++;
    const area = DESK_AREAS[n % DESK_AREAS.length];
    const fn = DESK_FUNCTIONS[Math.floor(n / DESK_AREAS.length) % DESK_FUNCTIONS.length];
    const slug = `${area} ${fn}`.toLowerCase().replace(/[^a-z]+/g, '-');
    if (usedSlugs.has(slug)) continue;
    usedSlugs.add(slug);
    return { slug, name: `${area} ${fn} Desk` };
  }
  throw new Error('desk name pool exhausted');
}

// --- tree shape -------------------------------------------------------------

let officeCursor = 0;
let sectionCursor = 0;
const takeOffice = () => OFFICE_POOL[officeCursor++ % OFFICE_POOL.length];
const takeSection = () => SECTION_POOL[sectionCursor++ % SECTION_POOL.length];

function buildDesk(parentPath, forced) {
  const { slug, name } = forced ?? nextDeskName();
  const path = [...parentPath, slug];
  const key = path.join('/');
  const isTarget = slug === TARGET.desk;
  const isSibling = slug === SIBLING.desk;
  return {
    kind: 'desk',
    slug,
    name,
    path,
    hours: isTarget ? TARGET.hours : FILLER_HOURS[hash(key) % FILLER_HOURS.length],
    phone: isTarget ? TARGET.phone : isSibling ? SIBLING.phone : phoneFor(key),
    room: 100 + (hash('room' + key) % 380),
    stop: `MS ${10 + (hash('stop' + key) % 80)}`,
  };
}

function buildSection(parentPath, forced) {
  const [slug, name, blurb] = forced ?? takeSection();
  const path = [...parentPath, slug];
  const key = path.join('/');
  const onTargetPath = key === TARGET.path.join('/');
  const children = [];
  if (onTargetPath) {
    children.push(
      buildDesk(path, { slug: TARGET.desk, name: 'Subsurface Permits Desk' }),
      buildDesk(path, { slug: SIBLING.desk, name: 'Surface Permits Desk' }),
      buildDesk(path, { slug: 'boring-notices', name: 'Boring Notices Desk' })
    );
  } else {
    // Two decoy desks sit in the division an agent reaches for first: a desk
    // whose name also starts "Subsurface", and one that also starts "Surface".
    if (key === DECOY_SECTION) {
      children.push(
        buildDesk(path, { slug: 'subsurface-utility-notices', name: 'Subsurface Utility Notices Desk' }),
        buildDesk(path, { slug: 'surface-water-permits', name: 'Surface Water Permits Desk' })
      );
    }
    const want = 2 + (hash('d' + key) % 2);
    while (children.length < want) children.push(buildDesk(path));
  }
  return { kind: 'section', slug, name, blurb, path, children };
}

function buildOffice(parentPath, forced) {
  const [slug, name, blurb] = forced ?? takeOffice();
  const path = [...parentPath, slug];
  const key = path.join('/');
  const onTargetPath = TARGET.path.slice(0, 2).join('/') === key;
  const children = [];
  if (onTargetPath) {
    children.push(
      buildSection(path, [
        'ground-works',
        'Ground Works Section',
        'Subsurface and surface permitting, boring notices, trench inspection.',
      ])
    );
  }
  if (key === DECOY_OFFICE) {
    children.push(
      buildSection(path, [
        'change-of-use',
        'Change of Use Section',
        'Reclassification of occupied premises, including street cuts and reinstatement.',
      ])
    );
  }
  const want = 2 + (hash('s' + key) % 2);
  while (children.length < want) children.push(buildSection(path));
  return { kind: 'office', slug, name, blurb, path, children };
}

function buildDivision(division) {
  const path = [division.slug];
  const children = [];
  if (division.slug === TARGET.path[0]) {
    children.push(
      buildOffice(path, [
        'field-operations',
        'Office of Field Operations',
        'Excavation and ground works, field inspection crews, site access.',
      ])
    );
  }
  if (division.slug === 'permits-and-clearances') {
    children.push(buildOffice(path, OFFICE_POOL[2]));
    officeCursor = Math.max(officeCursor, 3);
  }
  while (children.length < 3) children.push(buildOffice(path));
  return { kind: 'division', ...division, path, children };
}

const ROOT = {
  kind: 'root',
  name: 'Department Directory',
  path: [],
  children: DIVISIONS.map(buildDivision),
};

// --- rendering --------------------------------------------------------------

const LEVEL_WORD = {
  root: 'division',
  division: 'office',
  office: 'section',
  section: 'desk',
};

function up(n) {
  return n === 0 ? './' : '../'.repeat(n);
}

// The Bureau home page, relative to a page whose directory is `dirDepth`
// levels below pages/gov/departments/.
function homeFrom(dirDepth) {
  return '../'.repeat(dirDepth + 1) + 'index.html';
}

function crumbs(node) {
  if (node.kind === 'root') return '<p>You are here: Directory</p>';
  let cursor = ROOT;
  const parts = [];
  for (const slug of node.path) {
    cursor = cursor.children.find((c) => c.slug === slug);
    parts.push(cursor);
  }
  // A desk page is a file inside its section directory, so it sits at the same
  // directory depth as its section.
  const dirDepth = node.kind === 'desk' ? node.path.length - 1 : node.path.length;
  const trail = [`<a href="${up(dirDepth)}">Directory</a>`];
  parts.forEach((p, i) => {
    if (p === node || p.kind === 'desk') {
      trail.push(shortName(p.name));
    } else {
      trail.push(`<a href="${up(dirDepth - (i + 1))}">${shortName(p.name)}</a>`);
    }
  });
  return `<p>You are here: ${trail.join(' &gt; ')}</p>`;
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

function shell(title, breadcrumb, body, homeHref, tail = '') {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>${title} - Bureau of Civic Revenue</title></head>
<body bgcolor="#FFFFFF" text="#000000" link="#0000CC" vlink="#551A8B">
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr bgcolor="#003366"><td><font color="#FFFFFF" size="4" face="Times New Roman"><b>BUREAU OF CIVIC REVENUE</b></font><br>
<font color="#CCCCCC" size="1">DEPARTMENT DIRECTORY</font></td></tr>
</table>
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr><td>
<font size="1">${breadcrumb}</font>
${body}
<hr>
<font size="1">Directory listings are maintained by the Records and Disclosure Division.
Rev. ${REV}. Report a wrong extension to the webmaster. <a href="${homeHref}">Bureau home page</a>.<br>
&copy; Bureau of Civic Revenue. An agency of the Commonwealth. Revenue Building, Statehouse Plaza.</font>
</td></tr>
</table>
${tail}</body>
</html>
`;
}

function renderBranch(node) {
  const childWord = LEVEL_WORD[node.kind];
  const article = /^[aeiou]/.test(childWord) ? 'an' : 'a';
  const intro =
    node.kind === 'root'
      ? `<p>The Bureau is organised into four divisions. Each division listing continues to its offices, sections and public service desks. Counter hours and direct extensions are published on the desk pages.</p>`
      : `<p>${node.blurb} Continue to ${article} ${childWord} below.</p>`;
  const items = node.children
    .map((c) => {
      const href = c.kind === 'desk' ? `${c.slug}.html` : `${c.slug}/`;
      const label = c.kind === 'desk' ? '' : ` &mdash; ${c.blurb ?? ''}`;
      return `<li><a href="${href}">${c.name}</a>${label}</li>`;
    })
    .join('\n');
  // A bare <h2> carries the page name as its own text node so the snapshot can
  // see it; wrapping it in <font> (as the older gov pages do) would hide it,
  // because the walker reads an element's direct text nodes only.
  return shell(
    node.kind === 'root' ? 'Department Directory' : node.name,
    crumbs(node),
    `<h2>${node.kind === 'root' ? 'Department Directory' : node.name}</h2>
<font size="2">
${intro}
<ul>
${items}
</ul>
</font>`,
    homeFrom(node.path.length)
  );
}

function renderDesk(node) {
  // Every graded line is the DIRECT text of its own <p>, with the <font>
  // wrapper OUTSIDE the paragraph: the snapshot walker reads a node's own text
  // nodes only, so a <font> inside the <p> would make the paragraph text
  // invisible to snapshot and find. The lines are also kept short because the
  // formatter truncates displayed text at 30 characters.
  return shell(
    node.name,
    crumbs(node),
    `<h2>${node.name}</h2>
<font size="2">
<p>Public counter hours</p>
<p>${node.hours}</p>
<p>Phone: ${node.phone}</p>
<p>Room ${node.room}, Revenue Building &middot; ${node.stop}</p>
<p>Walk-in service is offered during the counter hours shown above. Outside those
hours the desk accepts filings through the lobby drop box on the ground floor.
Telephone enquiries are answered by the extension above; leave one message only,
as duplicate messages are removed from the queue before they are returned.</p>
</font>`,
    homeFrom(node.path.length - 1),
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
  for (const needle of ['9:15', '12:45', '014-3391']) {
    const hits = count(needle);
    const want = join(...TARGET.path, `${TARGET.desk}.html`);
    if (hits.length !== 1 || hits[0] !== want) {
      problems.push(`"${needle}" appears in ${hits.length} page(s): ${hits.join(', ')}`);
    }
  }
  const siblingHits = count('014-8862');
  const siblingWant = join(...TARGET.path, `${SIBLING.desk}.html`);
  if (siblingHits.length !== 1 || siblingHits[0] !== siblingWant) {
    problems.push(`"014-8862" appears in ${siblingHits.length} page(s): ${siblingHits.join(', ')}`);
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
  for (const desk of DECOY_DESKS) {
    const want = join(...DECOY_SECTION.split('/'), `${desk}.html`);
    if (!files.some(([rel]) => rel === want)) {
      problems.push(`near-miss decoy desk missing: ${want}`);
    }
  }
  const deskHours = files.filter(([rel]) => !rel.endsWith('index.html'));
  const targetPage = join(...TARGET.path, `${TARGET.desk}.html`);
  for (const [rel, html] of deskHours) {
    if (rel !== targetPage && /Tue[^<]*Thu/.test(html)) {
      problems.push(`filler desk ${rel} advertises Tue & Thu hours, muddying the target`);
    }
  }
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
console.log(`    under /gov/departments/permits-and-clearances/occupancy-consents/change-of-use/`);
