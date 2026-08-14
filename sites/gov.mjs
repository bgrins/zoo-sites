// pages/gov/ - the Bureau: document search and page-view stamps. The legacy rv3 loop stays in server core (it is document serving).
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

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
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
    // records that the page's own script ran in the same session, which needs the
    // session cookie, the session nonce and the per-path token the server
    // substituted into that page's body. The path is claimed by the client but is
    // worthless without the token minted for it.
    if (req.method === 'POST' && pathname0 === '/api/gov/page-view') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const path = String(payload?.path ?? '');
      const want = found.session.govTokens?.[path];
      if (!want || want !== payload?.token) {
        return json(res, 403, { error: 'page token required' });
      }
      (found.session.govViews ??= []).push({ path, at: Date.now() });
      return json(res, 200, { ok: true });
    }

    return false;
  };
}
