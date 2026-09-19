// pages/gov/ - the Bureau: document search, page-view stamps and the retired RV-3 redirect loop.
import { randomBytes } from 'node:crypto';

// pages/gov/search.html — the Bureau's document index. The ranking is computed
// here rather than held in fixture source, so the misleading order cannot be
// read off disk: the amended form's instructions (RV-7A) outrank the original
// form's, because the index scores a more recently revised document higher and
// the RV-7A page's own text names Form RV-7. An agent that takes hit #1 reports
// the annex PO box instead of the Declarations Unit box.
const GOV_SEARCH_INDEX = [
  {
    title: 'Form RV-7A Instructions',
    path: '/gov/rv7a-instructions.html',
    score: 98,
    snippet:
      'Amended residential vehicle declarations, line by line, with the annex filing address.',
    terms: ['rv7a', 'rv7', 'amend', 'mail', 'address', 'file', 'filing', 'declaration',
      'instruction', 'vehicle', 'residential'],
  },
  {
    title: 'Schedule of Filing Fees',
    path: '/gov/fee-schedule.html',
    score: 84,
    snippet: 'Base filing fees by form number, with the late-filing surcharge footnotes.',
    terms: ['fee', 'surcharge', 'late', 'rv7', 'schedule', 'cost', 'charge'],
  },
  {
    title: 'Form RV-7 Instructions',
    path: '/gov/rv7-instructions.html',
    score: 71,
    snippet:
      'Who must file, computing the declared value, the penalty schedule and where to file.',
    terms: ['rv7', 'instruction', 'declared value', 'penalty', 'file', 'filing', 'address',
      'mail', 'declaration'],
  },
  {
    title: 'Form RV-7 Residential Vehicle Annual Declaration',
    path: '/gov/rv7.html',
    score: 66,
    snippet: 'Who must file the annual declaration, the June 12 deadline, and downloads.',
    terms: ['rv7', 'declaration', 'deadline', 'vehicle', 'residential', 'annual', 'form'],
  },
  {
    title: 'Forms and Publications',
    path: '/gov/forms.html',
    score: 52,
    snippet: 'Index of Bureau forms by number, with revision dates and download links.',
    terms: ['form', 'publication', 'index', 'download', 'rv7', 'rv3', 'pdf'],
  },
  {
    title: 'Filing Season Information',
    path: '/gov/deadlines.html',
    score: 41,
    snippet: 'Filing season opening and closing dates, holidays and extension policy.',
    terms: ['deadline', 'season', 'filing', 'date', 'extension', 'holiday'],
  },
  {
    title: 'Frequently Asked Questions',
    path: '/gov/faq.html',
    score: 33,
    snippet: 'Answers to common questions about declarations, confirmations and penalties.',
    terms: ['faq', 'question', 'confirmation', 'penalt', 'letter', 'file', 'mail'],
  },
];

// "RV-7", "rv 7" and "RV7" all collapse to rv7 so a form number matches however
// the agent types it; "RV-7A" collapses to rv7a and stays distinct.
function govSearchResults(q) {
  const normalized = String(q)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\brv\s+(\d)/g, 'rv$1')
    .trim();
  const matches = normalized
    ? GOV_SEARCH_INDEX.filter((e) => e.terms.some((t) => normalized.includes(t)))
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

// gov/forms.html links Form RV-3 to /gov/legacy/rv3, a retired address that
// bounces between two paths. The cap is 6 because Firefox aborts a redirect
// chain at 20 hops with its own error page (measured), and the interstitial has
// to arrive well before that; the archived copy is served only for ?v=2 and
// exists only here, never as a file under pages/.
const GOV_RV3_BOUNCE_CAP = 6;

function govLegacyPage(title, body) {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>${title} - Bureau of Civic Revenue</title></head>
<body bgcolor="#FFFFFF" text="#000000" link="#0000CC" vlink="#551A8B">
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr bgcolor="#003366"><td><font color="#FFFFFF" size="4" face="Times New Roman"><b>BUREAU OF CIVIC REVENUE</b></font><br>
<font color="#CCCCCC" size="1">DOCUMENT ARCHIVE</font></td></tr>
</table>
<table width="760" border="0" cellpadding="4" cellspacing="0" align="center">
<tr><td>
${body}
<hr>
<font size="1">Archived documents are provided for reference only and are not
accepted for filing. <a href="/gov/forms.html">Forms &amp; Publications</a><br>
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
<p>This address was retired when the archive moved and it now redirects in a loop.</p>
<p>Add ?v=2 to the address to open the archived copy.</p>
<p>Bookmarks to the retired address cannot be updated automatically. The Records and
Disclosure Division is retiring the old chain during the next maintenance window.</p>
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
<p>This copy is served only to requests that arrive from the retired archive address.</p>
<p>Open /gov/legacy/rv3 first and follow the notice it returns.</p>
<p>Direct requests for archived scans are not honoured. The Records and Disclosure
Division logs each attempt against the requesting session.</p>
</font>`
);

const GOV_RV3_ARCHIVE = govLegacyPage(
  'Form RV-3 (archived)',
  `<h2>Form RV-3 Residential Vehicle Declaration</h2>
<font size="2">
<p>Superseded by Form RV-7. Retained under the retention schedule.</p>
<p>Rev. 11/2019</p>
<p>This scan reproduces the last printed revision of Form RV-3, including the
schedule of declared-value bands that applied before the form was withdrawn.
Declarations on this form are no longer accepted at any office or by mail.</p>
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
    // /gov/legacy/rv3 and /gov/legacy/rv3-b. Bounces are counted per session, so
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
      headers.Location = pathname0 === '/gov/legacy/rv3' ? '/gov/legacy/rv3-b' : '/gov/legacy/rv3';
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
