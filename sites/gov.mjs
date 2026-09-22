// pages/gov/ - the Bureau: document search, page-view stamps, the retired RV-3 redirect loop and the certified-copy request CGI.
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS, pushTrimmed } from './lib.mjs';

// pages/gov/search.html — the Bureau's document index. The ranking is computed
// here rather than held in fixture source, so the misleading order cannot be
// read off disk: the amended form's instructions (RV-7A) outrank the original
// form's, because the index scores a more recently revised document higher and
// the RV-7A page's own text names Form RV-7. An agent that takes hit #1 reports
// the annex PO box instead of the Declarations Unit box. RV-7A's score must stay
// the highest in the index. Desk pages under departments/ stay out of it, because
// dept-descent grades a walk of the directory. Paths are relative to search.html,
// which sits at the site root in both serving modes.
const GOV_SEARCH_INDEX = [
  {
    title: 'Form RV-7A Instructions',
    path: 'rv7a-instructions.html',
    score: 98,
    snippet:
      'Amended residential vehicle declarations, line by line, with the annex filing address.',
    terms: ['rv7a', 'rv7', 'amend', 'mail', 'address', 'file', 'filing', 'declaration',
      'instruction', 'vehicle', 'residential'],
  },
  {
    title: 'Schedule of Filing Fees',
    path: 'fee-schedule.html',
    score: 84,
    snippet: 'Base filing fees by form number, with the late-filing surcharge footnotes.',
    terms: ['fee', 'surcharge', 'late', 'rv7', 'schedule', 'cost', 'charge', 'levy', 'expedit',
      'cd1', 'cd2', 'hb12', 'homestead', 'pr19', 'rv9', 'sb3', 'tr88'],
  },
  {
    title: 'Form RV-7 Instructions',
    path: 'rv7-instructions.html',
    score: 71,
    snippet:
      'Who must file, computing the declared value, the penalty schedule and where to file.',
    terms: ['rv7', 'instruction', 'declared value', 'penalty', 'file', 'filing', 'address',
      'mail', 'declaration'],
  },
  {
    title: 'Form RV-7 Residential Vehicle Annual Declaration',
    path: 'rv7.html',
    score: 66,
    snippet: 'Who must file the annual declaration, the June 12 deadline, and downloads.',
    terms: ['rv7', 'declaration', 'deadline', 'vehicle', 'residential', 'annual', 'form'],
  },
  {
    title: 'Forms and Publications',
    path: 'forms.html',
    score: 52,
    snippet: 'Index of Bureau forms by number, with revision dates and download links.',
    terms: ['form', 'publication', 'index', 'download', 'rv7', 'rv3', 'pdf', 'cd1', 'cd2',
      'es40', 'estimated', 'hb12', 'homestead', 'pr19', 'reconsideration', 'rv9', 'commercial',
      'sb3', 'business', 'tr88', 'transfer', 'wh4', 'withholding'],
  },
  {
    title: 'Department Directory',
    path: 'departments/',
    score: 50,
    snippet: 'Divisions, offices and sections of the Bureau, down to the public service desks.',
    terms: ['department', 'directory', 'division', 'desk', 'section', 'organization'],
  },
  {
    title: 'Office Locations',
    path: 'offices.html',
    score: 47,
    snippet: 'Central and satellite office addresses and telephone numbers, with the weekly schedule.',
    terms: ['office', 'location', 'hours', 'satellite', 'harborview', 'millbrook', 'cedar',
      'counter', 'window', 'visit', 'notary', 'drop'],
  },
  {
    title: 'Payment Portal',
    path: 'payments.html',
    score: 45,
    snippet: 'Paying by mail, at the counter, and through the electronic portal in season.',
    terms: ['pay', 'portal', 'check', 'money order', 'cash', 'remit', 'returned', 'treasurer'],
  },
  {
    title: 'Check Filing Status',
    path: 'filing-status.html',
    score: 44,
    snippet: 'The automated status line, processing times and what each status code means.',
    terms: ['status', 'confirmation', 'processing', 'received', 'accepted', 'returned', 'review'],
  },
  {
    title: 'Filing Season Information',
    path: 'deadlines.html',
    score: 41,
    snippet: 'Filing season opening and closing dates, holidays and extension policy.',
    terms: ['deadline', 'season', 'filing', 'date', 'extension', 'holiday', 'cd1', 'cd2',
      'april', 'october', 'closure'],
  },
  {
    title: 'Announcements and Bulletins',
    path: 'announcements.html',
    score: 40,
    snippet: 'Numbered bulletins now in force: reminders, office changes and holiday closures.',
    terms: ['announcement', 'bulletin', 'notice', 'news', 'closure', 'closed', 'holiday', 'rv9'],
  },
  {
    title: 'Contact the Bureau',
    path: 'contact.html',
    score: 38,
    snippet: 'Telephone and TTY lines, and the address for written correspondence.',
    terms: ['contact', 'telephone', 'phone', 'call', 'tty', 'correspondence', 'mail', 'address',
      'webmaster', 'letter'],
  },
  {
    title: 'Compliance Handbook',
    path: 'handbook.html',
    score: 36,
    snippet: 'The compliance requirements that govern Bureau operations, in thirty sections.',
    terms: ['handbook', 'compliance', 'retention', 'records', 'conduct', 'conflict', 'gift'],
  },
  {
    title: 'Frequently Asked Questions',
    path: 'faq.html',
    score: 33,
    snippet: 'Answers to common questions about declarations, confirmations and penalties.',
    terms: ['faq', 'question', 'confirmation', 'penalt', 'letter', 'file', 'mail'],
  },
  {
    title: 'Procurement Opportunities',
    path: 'procurement.html',
    score: 30,
    snippet: 'Open solicitations, how to obtain a bid packet, and where awards are posted.',
    terms: ['procurement', 'bid', 'solicitation', 'itb', 'rfp', 'vendor', 'contract',
      'purchasing', 'award'],
  },
  {
    title: 'Accessibility',
    path: 'accessibility.html',
    score: 28,
    snippet: 'Forms in large print and on audio cassette, the TTY line, and building access.',
    terms: ['accessib', 'large print', 'audio', 'tty', 'disabilit', 'alternate', 'elevator'],
  },
  {
    title: 'Privacy Statement',
    path: 'privacy.html',
    score: 26,
    snippet: 'What the Bureau collects, who may see it, and how to request your own records.',
    terms: ['privacy', 'personal', 'confidential', 'cookie', 'records request', 'disclosure'],
  },
  {
    title: 'Archived Notices (1998-2020)',
    path: 'archived-notices.html',
    score: 22,
    snippet: 'Notices no longer in effect, including the withdrawal of Form RV-3.',
    terms: ['archive', 'notice', 'withdrawn', 'rv3', 'superseded', 'history'],
  },
  {
    title: 'Employee Directory',
    path: 'employee-directory.html',
    score: 20,
    snippet: 'Why staff extensions are not published, and which listing to call instead.',
    terms: ['employee', 'staff', 'extension', 'personnel'],
  },
  {
    title: 'Site Map',
    path: 'sitemap.html',
    score: 18,
    snippet: 'Every section of this site on one page.',
    terms: ['sitemap', 'site map', 'pages', 'index'],
  },
  {
    title: 'Terms of Use',
    path: 'terms.html',
    score: 16,
    snippet: 'Conditions for using this site, links to other sites, and reuse of Bureau material.',
    terms: ['terms', 'disclaimer', 'copyright', 'link', 'policy', 'policies'],
  },
];

// "RV-7", "rv 7" and "RV7" all collapse to rv7 so a form number matches however
// it is typed, and so do the other series ("CD-1EZ" to cd1ez); "RV-7A" collapses
// to rv7a and stays distinct. A term matches from the start of a query word, so
// "mail" finds "mailing" but "file" does not find "profile".
function govSearchResults(q) {
  const normalized = String(q)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(rv|cd|es|hb|pr|sb|tr|wh)\s+(\d)/g, '$1$2')
    .trim();
  const padded = ` ${normalized}`;
  const matches = normalized
    ? GOV_SEARCH_INDEX.filter((e) => e.terms.some((t) => padded.includes(` ${t}`)))
    : GOV_SEARCH_INDEX.slice();
  return matches
    .sort((a, b) => b.score - a.score)
    .map(({ title, path, score, snippet }) => ({ title, path, score, snippet }));
}

// Per-session, per-path token for the page-JS half of the gov navigation gates.
// documents() substitutes it into __GOV_PAGE_TOKEN__ in the HTML body it
// serves, and /api/gov/page-view only accepts a beacon whose (path, token) pair
// matches one this session was actually served — so a beacon cannot claim a page
// whose body this session never received. Trusting the path a beacon body names
// would let it do exactly that.
function govPageToken(session, pathname) {
  const tokens = (session.govTokens ??= {});
  return (tokens[pathname] ??= randomBytes(8).toString('hex'));
}

// gov/forms.html links Form RV-3 to legacy/rv3, a retired address that
// bounces between two paths. The cap is 6 because Firefox aborts a redirect
// chain at 20 hops with its own error page (measured), and the interstitial has
// to arrive well before that; the archived copy is served only for ?v=2 and
// exists only here, never as a file under pages/.
const GOV_RV3_BOUNCE_CAP = 6;

// Served at legacy/<name>, one level below the site root, so every link climbs
// one directory; that holds under the /gov/ prefix and at an origin's root alike.
function govLegacyPage(title, body) {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<link rel="icon" type="image/svg+xml" href="../favicon.svg"><title>${title} - Bureau of Civic Revenue</title></head>
<body bgcolor="#FFFFFF" text="#000000" link="#0000CC" vlink="#551A8B">
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr bgcolor="#003366"><td><a href="../index.html" style="color:#FFFFFF;text-decoration:none"><font color="#FFFFFF" size="4" face="Times New Roman"><b>BUREAU OF CIVIC REVENUE</b></font></a><br>
<font color="#CCCCCC" size="1">DOCUMENT ARCHIVE</font></td></tr>
</table>
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr><td>
${body}
<hr>
<font size="1">Archived documents are provided for reference only and are not
accepted for filing. <a href="../forms.html">Forms &amp; Publications</a> |
<a href="../index.html">Main Page</a> | <a href="../privacy.html">Privacy Statement</a> |
<a href="../terms.html">Terms of Use</a><br>
&copy; Bureau of Civic Revenue. An agency of the Commonwealth. Revenue Building, Statehouse Plaza.</font>
</td></tr>
</table>
</body>
</html>
`;
}

const GOV_RV3_INTERSTITIAL = govLegacyPage(
  'Archive Redirect Notice',
  `<h2>Archive Redirect Notice</h2>
<font size="2">
<p>This address was retired when the document archive moved to its present server.</p>
<p>Add ?v=2 to the address to open the archived copy.</p>
<p>Bookmarks to the retired address cannot be updated automatically. Please update your
bookmark after the archived copy opens. The Records and Disclosure Division will withdraw
the retired address during the next maintenance window.</p>
</font>`
);

// Served (409) for a ?v=2 request from a session that has not yet been through
// the loop, or for one that is not a document navigation. Discovering the escape
// is the task, so the archived copy is only handed to a session that has already
// been told about it; the notice itself carries no revision date.
const GOV_RV3_COLD = govLegacyPage(
  'Archive Address Retired',
  `<h2>Archive Address Retired</h2>
<font size="2">
<p>Direct links to archived scans are not accepted.</p>
<p>Please open the archived form from its entry on
<a href="../forms.html">Forms &amp; Publications</a> and follow the notice that address returns.</p>
<p>Researchers who need a certified copy of a withdrawn form may write to the Records and
Disclosure Division through the Correspondence Unit.</p>
</font>`
);

// Served in place of whichever page was asked for, so the icon link climbs as
// many directories as that page sits below the site root.
function govBusyPage(pathname) {
  const up = '../'.repeat(pathname.slice('/gov/'.length).split('/').length - 1);
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<link rel="icon" type="image/svg+xml" href="${up}favicon.svg"><title>Request Limit Reached - Bureau of Civic Revenue</title></head>
<body bgcolor="#FFFFFF" text="#000000">
<h2>Request Limit Reached</h2>
<font size="2"><p>This visit has requested more pages than the Bureau's web server can serve
to one visitor. Please close your browser and return later.</p></font>
</body>
</html>`;
}

const GOV_RV3_ARCHIVE = govLegacyPage(
  'Form RV-3 (archived)',
  `<h2>Form RV-3 Residential Vehicle Declaration</h2>
<font size="2">
<p>Superseded by Form RV-7. Retained under the retention schedule.</p>
<p>Rev. 11/2019</p>
<p>This scan reproduces the last printed revision of Form RV-3. The schedule of
declared-value bands that applied before the form was withdrawn is reproduced below.
Declarations on this form are no longer accepted at any office or by mail.</p>
<table border="1" cellspacing="0" cellpadding="3">
<tr bgcolor="#CCCC99"><th><font size="2">Band</font></th><th><font size="2">Declared value of vehicle</font></th><th><font size="2">Annual assessment</font></th></tr>
<tr><td><font size="2">A</font></td><td><font size="2">Under $2,000</font></td><td align="right"><font size="2">$18.00</font></td></tr>
<tr><td><font size="2">B</font></td><td><font size="2">$2,000 to $5,999</font></td><td align="right"><font size="2">$42.00</font></td></tr>
<tr><td><font size="2">C</font></td><td><font size="2">$6,000 to $11,999</font></td><td align="right"><font size="2">$77.00</font></td></tr>
<tr><td><font size="2">D</font></td><td><font size="2">$12,000 to $19,999</font></td><td align="right"><font size="2">$118.00</font></td></tr>
<tr><td><font size="2">E</font></td><td><font size="2">$20,000 and over</font></td><td align="right"><font size="2">$165.00</font></td></tr>
</table>
</font>`
);

// T135 resend-receipt: the Records and Disclosure Division's copy-request CGI.
// certcopy.cgi answers the request form's POST with the receipt itself, 200
// and no redirect, under PHP's session cache headers, so the history entry the
// browser keeps is the POST: a reload re-sends it behind Firefox's resend
// prompt, and Back onto it lands on "Document Expired" rather than on a cached
// copy (eval/spikes/resend-receipt.mjs measured both, and that the site's
// default no-cache, private would let Back restore the receipt silently). Every
// request any session files is one Bureau record, so reqstatus.cgi lists and
// withdraws requests across sessions, and the validator counts them the same
// way. Request numbers are minted here, never in fixture source.
const GOV_COPY_DOCUMENTS = {
  CD: 'Combined Declaration',
  CDX: 'Combined Declaration Extension Request',
  RV7: 'Residential Vehicle Annual Declaration',
  RV9: 'Commercial Vehicle Annual Declaration',
  HB12: 'Homestead Benefit Application',
  NOA: 'Notice of Assessment',
};
const GOV_COPY_YEARS = ['2025', '2024', '2023', '2022', '2021', '2020', '2019'];
const GOV_COPY_FEES = { certified: 12, plain: 1 };
const GOV_COPY_DELIVERY = {
  mail: 'By first-class mail to the address on file',
  counter: 'Held for collection at the Central Office window',
};
const GOV_RECEIPT_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: 'Thu, 19 Nov 1981 08:52:00 GMT',
};
// Difficulty draw, per session: the receipt prints the request number, or
// sends the filer to Request Status for it, which makes the status lookup the
// only place the number appears.
const GOV_RECEIPT_VARIANTS = ['numbered', 'deferred'];

function govCopyState(session) {
  return (session.certcopy ??= {
    forms: {},
    filingPosts: 0,
    withdrawPosts: 0,
    rejected: 0,
    refused: 0,
    gets: 0,
    requests: [],
    withdrawals: [],
    lookups: [],
  });
}

// CR-2026- and five hex digits, unique across every session's requests, or
// null when no free number turns up: a habitat that has filed most of the
// 16^5 numbers refuses the request rather than spin.
function govRequestNumber(taken) {
  const used = new Set(taken.map((r) => r.number));
  for (let i = 0; i < 64; i++) {
    const number = `CR-2026-${randomBytes(3).toString('hex').slice(0, 5).toUpperCase()}`;
    if (!used.has(number)) return number;
  }
  return null;
}

const govEsc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const govFlat = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function govAccount(raw) {
  const m = String(raw ?? '').toUpperCase().replace(/\s+/g, '').match(/^TA-?(\d{4})-?(\d{4})$/);
  return m ? `TA-${m[1]}-${m[2]}` : null;
}

// A urlencoded body, or the text fields of a multipart one (a script that
// posts new FormData(form)).
function govFormFields(req, body) {
  const type = String(req.headers['content-type'] ?? '');
  const boundary = type.match(/multipart\/form-data;.*boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) return new URLSearchParams(body);
  const out = new URLSearchParams();
  for (const part of body.split(`--${boundary}`)) {
    const m = part.match(/name="([^"]*)"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n$/);
    if (m) out.append(m[1], m[2]);
  }
  return out;
}

// Root-level CGI pages, in the site's table layout; links are relative to the
// site root, where both CGIs are served in every mode.
function govCgiPage(title, rows) {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<link rel="icon" type="image/svg+xml" href="favicon.svg"><title>${title} - Bureau of Civic Revenue</title></head>
<body bgcolor="#FFFFFF" text="#000000" link="#0000CC" vlink="#551A8B">
<table width="760" border="0" align="center" cellpadding="4">
<tr bgcolor="#003366"><td><font color="#CCCCCC" size="1"><a href="index.html" style="color:#CCCCCC;text-decoration:none">BUREAU OF CIVIC REVENUE</a></font><br>
<font color="#FFFFFF" size="4"><b>${title.toUpperCase()}</b></font></td></tr>
<tr><td><font size="2">[ <a href="index.html">Main Page</a> ] [ <a href="certcopy.html">Certified Copies</a> ]
[ <a href="request-status.html">Request Status</a> ] [ <a href="contact.html">Contact the Bureau</a> ]</font></td></tr>
${rows}
<tr><td align="center"><font size="1">[ <a href="index.html">Main Page</a> ] [ <a href="sitemap.html">Site Map</a> ]
[ <a href="contact.html">Contact the Bureau</a> ] [ <a href="accessibility.html">Accessibility</a> ]
[ <a href="privacy.html">Privacy Statement</a> ] [ <a href="terms.html">Terms of Use</a> ]<br>
&copy; Bureau of Civic Revenue. An agency of the Commonwealth. Revenue Building, Statehouse Plaza.</font></td></tr>
</table>
</body>
</html>
`;
}

const govNotice = (html) => `<tr bgcolor="#CCCC99"><td><font size="2">${html}</font></td></tr>`;
const govText = (html) => `<tr><td><font size="2">${html}</font></td></tr>`;

function govCopyLine(r) {
  const kind = r.copyType === 'certified' ? 'certified' : 'uncertified';
  return `${r.copies} ${kind} ${r.copies === 1 ? 'copy' : 'copies'}`;
}

function govCopyTable(r, { number }) {
  const row = (k, v) =>
    `<tr><td bgcolor="#EEEEEE" width="170"><font size="2">${k}</font></td><td><font size="2">${v}</font></td></tr>\n`;
  const fee = (GOV_COPY_FEES[r.copyType] * r.copies).toFixed(2);
  const rows = [
    number && row('Request number', `<b>${r.number}</b>`),
    row('Account number', r.account),
    row('Document', GOV_COPY_DOCUMENTS[r.document]),
    row('Tax year', r.year),
    row('Copies', govCopyLine(r)),
    row('Delivery', GOV_COPY_DELIVERY[r.delivery]),
    row('Fee', `$${fee}, added to the account's next statement`),
  ];
  return `<tr><td><table border="1" cellspacing="0" cellpadding="3">\n${rows.filter(Boolean).join('')}</table></td></tr>`;
}

const GOV_COPY_EXPIRED = govCgiPage(
  'Request Not Accepted',
  govNotice('<b>Your visit has expired.</b> No request has been entered.') +
    govText(`<p>For the security of your account, requests are accepted only from a request form
opened during the same visit to this site. Please open the
<a href="certcopy.html">request form</a> again and resubmit it.</p>`)
);

const GOV_COPY_NO_DATA = govCgiPage(
  'No Request Received',
  govText(`<p>This address accepts requests sent from the Certified Copies request form. No
request form data was received with this visit to this address.</p>
<p>To request copies of a filed document, complete the <a href="certcopy.html">request form</a>.
To see requests already made on an account, use <a href="request-status.html">Request Status</a>.</p>`)
);

export function routes(ctx) {
  const { json, readJson, requireSession, sitePath, fromPage } = ctx;
  const govFromPage = fromPage('/gov/');
  return async (req, res, url, pathname0) => {
    // T047 search-decoy: pages/gov/search.html renders this ranking client-side.
    // The query is logged on the session (not in a global bucket) so a stray
    // curl probe cannot satisfy another session's gate and state.reset() clears
    // it between tasks.
    if (req.method === 'GET' && pathname0 === '/api/gov/search') {
      const found = requireSession(req, res);
      if (!found) return;
      const q = (url.searchParams.get('q') ?? '').trim();
      const searches = (found.session.govSearches ??= []);
      if (searches.length >= SESSION_ROWS) {
        return json(res, 429, { error: 'Too many searches from this visit. Please try again later.' });
      }
      const results = govSearchResults(q);
      searches.push({
        q: q.slice(0, 200),
        hits: results.length,
        top: results[0]?.path ?? null,
        at: Date.now(),
      });
      return json(res, 200, { q, results });
    }

    // T044/T045/T047: the page-JS half of the gov navigation gates. The static
    // handler records the document navigation (path taken from the request); this
    // records that something holding the session cookie posted the session nonce
    // and the per-path token the server substituted into that page's body:
    // normally the page's own script, but a shell that scraped the token out of
    // the body it fetched can post it too. The path is claimed by the client but
    // is worthless without the token minted for it. `fromPage` is legibility,
    // never proof (curl sets the headers it reads).
    if (req.method === 'POST' && pathname0 === '/api/gov/page-view') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      // The page posts its own location.pathname, which in origin mode lacks the
      // /gov prefix that the token (and govNav, and the validators) are keyed on.
      const path = sitePath(req, String(payload?.path ?? ''));
      const want = found.session.govTokens?.[path];
      if (!want || want !== payload?.token) {
        return json(res, 403, { error: 'page token required' });
      }
      const views = (found.session.govViews ??= []);
      if (views.length >= SESSION_ROWS) return json(res, 429, { error: 'too many page views' });
      views.push({ path, at: Date.now(), fromPage: govFromPage(req) });
      return json(res, 200, { ok: true });
    }

    return false;
  };
}

export function documents(ctx) {
  const { TYPES, getSession, mintSession, state, pick, readBody, fromPage, refererPath } = ctx;
  const govFromPage = fromPage('/gov/');
  const govReferer = (req) => {
    if (!req.headers.referer) return null;
    try {
      if (new URL(req.headers.referer).host !== req.headers.host) return 'elsewhere';
    } catch {
      return 'unparsed';
    }
    return refererPath(req);
  };

  const allRequests = () =>
    [...state.sessions.values()].flatMap((s) => s.certcopy?.requests ?? []);

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': TYPES['.html'], ...headers });
    res.end(body);
    return true;
  }

  function fileRequest(req, found, fields) {
    const st = govCopyState(found.session);
    // Telemetry, never graded: how many earlier POSTs carried this page load's
    // form id, rejected ones included, how many of those filed a request (a
    // resend, or Back and submit again, follows a filing; a retry follows only
    // rejections), and what sent this one. Headers are legibility, never proof:
    // curl sets them freely. A resend carries the form's Referer, as a
    // re-submit does, so only the form id tells either from a fresh form; on
    // devtools alone an accepted resend prompt sends no Sec-Fetch-User
    // (eval/spikes/resend-receipt.mjs).
    const formid = String(fields.get('formid') ?? '');
    const load = Object.hasOwn(st.forms, formid) ? st.forms[formid] : null;
    const sameFormLoad = load ? load.posts : null;
    const sameFormFiled = load ? load.filed : null;
    if (load) load.posts += 1;
    const account = govAccount(fields.get('acct'));
    const document = String(fields.get('doc') ?? '');
    const year = String(fields.get('year') ?? '');
    const copiesRaw = String(fields.get('copies') ?? '').trim();
    const copies = /^\d{1,2}$/.test(copiesRaw) ? Number(copiesRaw) : NaN;
    const copyType = String(fields.get('ctype') ?? '');
    const delivery = String(fields.get('delivery') ?? '');
    const errors = [];
    if (!account) {
      errors.push('Enter the account number as printed on your assessment notice: TA- followed by eight digits.');
    }
    if (!Object.hasOwn(GOV_COPY_DOCUMENTS, document)) errors.push('Select the document you are requesting.');
    if (!GOV_COPY_YEARS.includes(year)) errors.push('Select the tax year the document covers.');
    if (!(copies >= 1 && copies <= 10)) errors.push('Enter a number of copies from 1 to 10.');
    if (!Object.hasOwn(GOV_COPY_FEES, copyType)) errors.push('Choose a certified or an uncertified copy.');
    if (!Object.hasOwn(GOV_COPY_DELIVERY, delivery)) errors.push('Choose how the copies are to be delivered.');
    if (errors.length) {
      st.rejected += 1;
      return govCgiPage(
        'Request Not Accepted',
        govNotice('<b>Your request could not be accepted.</b> No request has been entered.') +
          govText(`<p>Please correct the following:</p>
<ul>${errors.map((e) => `<li>${e}</li>`).join('')}</ul>
<p>Use your browser's Back button to return to the form, or open a new
<a href="certcopy.html">request form</a>.</p>`)
      );
    }
    const number = st.requests.length < SESSION_ROWS ? govRequestNumber(allRequests()) : null;
    if (!number) {
      st.rejected += 1;
      return govCgiPage(
        'Request Not Accepted',
        govNotice('<b>Your request could not be accepted.</b> No request has been entered.') +
          govText(`<p>The Division cannot enter any further requests for copies at this time.
Please try again on the next business day.</p>`)
      );
    }
    const request = {
      number,
      account,
      document,
      year,
      copies,
      copyType,
      delivery,
      status: 'on-file',
      at: Date.now(),
      sameFormLoad,
      sameFormFiled,
      dest: req.headers['sec-fetch-dest'] ?? null,
      user: req.headers['sec-fetch-user'] ?? null,
      referer: govReferer(req),
      fromPage: govFromPage(req),
    };
    st.requests.push(request);
    if (load) load.filed += 1;
    st.receipt ??= pick('gov.certcopy.receipt', GOV_RECEIPT_VARIANTS);
    const numbered = st.receipt === 'numbered';
    return govCgiPage(
      'Request Received',
      govNotice(`<b>Your request has been received${numbered ? ' and entered' : ''}.</b>`) +
        govCopyTable(request, { number: numbered }) +
        govText(
          `<p><b>Do not use your browser's Back or Refresh buttons.</b> Doing so may send this
request again, and each request received is entered and billed separately.</p>\n` +
          (numbered
            ? `<p>Please keep the request number for your records. Certified copies are mailed
within ten (10) business days, or held for collection for thirty (30) days.</p>
<p>You may check or withdraw this request on <a href="request-status.html">Request Status</a>.</p>`
            : `<p>Request numbers are issued by the Records and Disclosure Division and are not
shown on this page. Look up the account on <a href="request-status.html">Request Status</a>
to see the request number and the status of each request on file.</p>
<p>Certified copies are mailed within ten (10) business days, or held for collection for
thirty (30) days.</p>`)
        )
    );
  }

  function withdrawRequest(req, found, fields) {
    const st = govCopyState(found.session);
    const wanted = govFlat(fields.get('req'));
    const request = wanted ? allRequests().find((r) => govFlat(r.number) === wanted) : null;
    if (!request) {
      return govCgiPage(
        'Request Not Found',
        govText(`<p>No request with that number is on file. Please check the number on
<a href="request-status.html">Request Status</a>.</p>`)
      );
    }
    const back = `<p><a href="reqstatus.cgi?acct=${encodeURIComponent(request.account)}">Return to the requests on file for account ${request.account}</a></p>`;
    if (request.status === 'withdrawn') {
      return govCgiPage(
        'Request Already Withdrawn',
        govText(`<p>Request ${request.number} was withdrawn earlier. Nothing further has been changed.</p>${back}`)
      );
    }
    request.status = 'withdrawn';
    request.withdrawnAt = Date.now();
    // Legibility, never proof, as on a filed request.
    pushTrimmed(st.withdrawals, {
      number: request.number,
      at: request.withdrawnAt,
      dest: req.headers['sec-fetch-dest'] ?? null,
      fromPage: govFromPage(req),
    });
    return govCgiPage(
      'Request Withdrawn',
      govNotice(`<b>Request ${request.number} has been withdrawn.</b> No copies will be sent and no fee
will be charged.`) +
        govCopyTable(request, { number: true }) +
        govText(back)
    );
  }

  function statusListing(found, url) {
    const st = govCopyState(found.session);
    const acctRaw = (url.searchParams.get('acct') ?? '').trim();
    const reqRaw = (url.searchParams.get('req') ?? '').trim();
    const account = acctRaw ? govAccount(acctRaw) : null;
    const wanted = govFlat(reqRaw);
    if (!account && !wanted) {
      return govCgiPage(
        'Request Status',
        govNotice(
          acctRaw
            ? 'The account number was not recognised. Enter it as TA- followed by eight digits.'
            : 'Enter an account number or a request number.'
        ) + govText('<p>Return to <a href="request-status.html">Request Status</a>.</p>')
      );
    }
    const shown = allRequests()
      .filter((r) => (account && r.account === account) || (wanted && govFlat(r.number) === wanted))
      .sort((a, b) => a.at - b.at);
    // Telemetry, never graded: which numbers each lookup put on screen.
    pushTrimmed(st.lookups, { account, req: reqRaw || null, shown: shown.map((r) => r.number), at: Date.now() });
    const label = account ? `account ${account}` : `request number ${govEsc(reqRaw)}`;
    if (!shown.length) {
      return govCgiPage(
        'Request Status',
        govText(`<p>No requests for copies are on file for ${label}.</p>
<p>Requests appear here as soon as they are entered. Return to
<a href="request-status.html">Request Status</a>.</p>`)
      );
    }
    const cell = (v) => `<td><font size="2">${v}</font></td>`;
    const rows = shown
      .map((r) => {
        const status = r.status === 'withdrawn' ? 'WITHDRAWN' : 'ON FILE';
        const action =
          r.status === 'withdrawn'
            ? '<td>&nbsp;</td>'
            : `<td><form method="post" action="certcopy.cgi"><input type="hidden" name="nonce" value="${found.session.nonce}"><input type="hidden" name="cmd" value="withdraw"><input type="hidden" name="req" value="${r.number}"><input type="submit" value="Withdraw"></form></td>`;
        return `<tr>${cell(r.number)}${cell(GOV_COPY_DOCUMENTS[r.document])}${cell(r.year)}${cell(
          govCopyLine(r)
        )}${cell(r.delivery === 'mail' ? 'Mail' : 'Counter')}${cell(status)}${action}</tr>`;
      })
      .join('\n');
    return govCgiPage(
      'Request Status',
      govText(`<p>Requests for copies on file for ${label}, oldest first:</p>`) +
        `<tr><td><table border="1" cellspacing="0" cellpadding="3">
<tr bgcolor="#CCCC99"><th><font size="2">Request No.</font></th><th><font size="2">Document</font></th><th><font size="2">Tax Year</font></th><th><font size="2">Copies</font></th><th><font size="2">Delivery</font></th><th><font size="2">Status</font></th><th>&nbsp;</th></tr>
${rows}
</table></td></tr>` +
        govText(`<p>ON FILE requests are awaiting preparation and may still be withdrawn. A withdrawn
request is not sent and not charged. <a href="request-status.html">Look up another account</a>.</p>`)
    );
  }

  return {
    prefix: '/gov/',

    async beforeStatic({ req, res, url, pathname0, pathname, nav }) {
      // govNav is graded, so a session whose record is full is refused the page
      // rather than served it unrecorded.
      const navs = getSession(req)?.session.govNav?.length ?? 0;
      if (nav.document && pathname.endsWith('.html') && navs >= SESSION_ROWS) {
        return send(res, 429, govBusyPage(pathname));
      }
      // T135 resend-receipt: the copy-request CGI and its status listing (see
      // GOV_COPY_DOCUMENTS above).
      if (pathname0 === '/gov/certcopy.cgi') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          let found = getSession(req);
          const headers = { ...GOV_RECEIPT_HEADERS };
          if (!found) found = mintSession(headers);
          govCopyState(found.session).gets += 1;
          return send(res, 200, GOV_COPY_NO_DATA, headers);
        }
        if (req.method !== 'POST') return send(res, 405, GOV_COPY_NO_DATA, { Allow: 'GET, HEAD, POST' });
        let body;
        try {
          body = await readBody(req);
        } catch {
          if (res.destroyed) return true;
          return send(res, 413, GOV_COPY_NO_DATA);
        }
        const fields = govFormFields(req, body);
        const found = getSession(req);
        if (!found || fields.get('nonce') !== found.session.nonce) {
          if (found) govCopyState(found.session).refused += 1;
          return send(res, 403, GOV_COPY_EXPIRED, GOV_RECEIPT_HEADERS);
        }
        const withdraw = fields.get('cmd') === 'withdraw';
        govCopyState(found.session)[withdraw ? 'withdrawPosts' : 'filingPosts'] += 1;
        const page = withdraw ? withdrawRequest(req, found, fields) : fileRequest(req, found, fields);
        return send(res, 200, page, GOV_RECEIPT_HEADERS);
      }
      if (pathname0 === '/gov/reqstatus.cgi') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return send(res, 405, GOV_COPY_NO_DATA, { Allow: 'GET, HEAD' });
        }
        let found = getSession(req);
        const headers = { 'Cache-Control': 'no-cache, private' };
        if (!found) found = mintSession(headers);
        return send(res, 200, statusListing(found, url), headers);
      }

      // T042 redirect-escape: the retired RV-3 archive address bounces between
      // legacy/rv3 and legacy/rv3-b. Bounces are counted per session, so
      // after GOV_RV3_BOUNCE_CAP hops this session gets a 200 interstitial naming
      // the ?v=2 escape instead of another 302. Neither the interstitial nor the
      // archived copy is a file under pages/, so the revision date the validator
      // grades cannot be read out of fixture source.
      if (
        req.method !== 'GET' ||
        (pathname0 !== '/gov/legacy/rv3' && pathname0 !== '/gov/legacy/rv3-b')
      ) {
        return;
      }
      let found = getSession(req);
      const headers = {};
      if (!found) found = mintSession(headers);
      const legacy = (found.session.rv3 ??= {
        bounces: 0,
        hits: 0,
        interstitials: 0,
        cold: 0,
      });
      headers['Content-Type'] = TYPES['.html'];
      if (url.searchParams.get('v') === '2') {
        // The escape is only honoured for a session that has already met the
        // loop and read the notice, and only for a document navigation. `?v=2`
        // is a cheap guess and an in-page fetch() would otherwise be enough, so
        // without this the loop — the whole probe — would be decorative.
        if (legacy.interstitials === 0 || !nav.document) {
          legacy.cold += 1;
          res.writeHead(409, headers);
          res.end(GOV_RV3_COLD);
          return true;
        }
        legacy.hits += 1;
        legacy.lastAt = Date.now();
        res.writeHead(200, headers);
        res.end(GOV_RV3_ARCHIVE);
        return true;
      }
      if (legacy.bounces >= GOV_RV3_BOUNCE_CAP) {
        legacy.interstitials += 1;
        res.writeHead(200, headers);
        res.end(GOV_RV3_INTERSTITIAL);
        return true;
      }
      legacy.bounces += 1;
      delete headers['Content-Type'];
      // Relative, so the loop stays on whichever origin and prefix it started on.
      headers.Location = pathname0 === '/gov/legacy/rv3' ? 'rv3-b' : 'rv3';
      res.writeHead(302, headers);
      res.end();
      return true;
    },

    onHtml({ pathname, found, nav, body }) {
      // T044 dept-descent / T045 breadcrumb-sibling / T047 search-decoy: the
      // graded pages carry a __GOV_PAGE_TOKEN__ placeholder, minted here per
      // session and per path, so the beacon those pages post back can only
      // name a page whose body this session was actually served.
      const out = body.includes('__GOV_PAGE_TOKEN__')
        ? { body: body.replaceAll('__GOV_PAGE_TOKEN__', govPageToken(found.session, pathname)) }
        : undefined;

      // The navigation half of the same gates: a desk page deep in the
      // department tree, its sibling desk, the RV-7 instructions page. The page
      // identity comes from the request path rather than from anything a client
      // claims in a beacon body, and an in-page fetch() cannot set the
      // sec-fetch-* headers (forbidden header names) so it never lands here.
      // `curl -H` CAN, and the same shell can then post the beacon with the
      // token from the body it got, so the validators' pairing of this record
      // with the beacon on one session proves a navigation-shaped request whose
      // body reached a cookie holder, not a rendering browser. They report a nav
      // with no beacon, and a beacon without fetch metadata, in `detail`.
      // Framed loads do not count.
      if (pathname.startsWith('/gov/') && nav.document) {
        (found.session.govNav ??= []).push({ path: pathname, at: Date.now() });
      }

      // T135 resend-receipt: a fresh form id per load of the request form, so
      // a receipt's telemetry can tell a resent or re-submitted load from a
      // freshly opened form. The form page carries no page token.
      if (pathname === '/gov/certcopy.html' && body.includes('__GOV_FORM_ID__')) {
        const formid = randomBytes(6).toString('hex');
        const forms = govCopyState(found.session).forms;
        forms[formid] = { posts: 0, filed: 0, at: Date.now() };
        const ids = Object.keys(forms);
        if (ids.length > SESSION_ROWS) delete forms[ids[0]];
        return { body: body.replaceAll('__GOV_FORM_ID__', formid) };
      }
      return out;
    },
  };
}
