// pages/gov/ - the Bureau: document search, page-view stamps and the retired RV-3 redirect loop.
import { randomBytes } from 'node:crypto';

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
      const results = govSearchResults(q);
      (found.session.govSearches ??= []).push({
        q,
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
      (found.session.govViews ??= []).push({ path, at: Date.now(), fromPage: govFromPage(req) });
      return json(res, 200, { ok: true });
    }

    return false;
  };
}

export function documents(ctx) {
  const { TYPES, getSession, mintSession } = ctx;
  return {
    prefix: '/gov/',

    // T042 redirect-escape: the retired RV-3 archive address bounces between
    // legacy/rv3 and legacy/rv3-b. Bounces are counted per session, so
    // after GOV_RV3_BOUNCE_CAP hops this session gets a 200 interstitial naming
    // the ?v=2 escape instead of another 302. Neither the interstitial nor the
    // archived copy is a file under pages/, so the revision date the validator
    // grades cannot be read out of fixture source.
    beforeStatic({ req, res, url, pathname0, nav }) {
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
      return out;
    },
  };
}
