// pages/ledger/ - the 7-folio transaction ledger and its CSV export.
import { randomBytes } from 'node:crypto';
import { LEDGER_ROWS } from './ledger-rows.mjs';


export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/ledger/export') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      // The CSV token is minted here, so the export URL cannot be derived
      // from page source (the page's nonce is not enough).
      found.session.ledgerToken ??= randomBytes(8).toString('hex');
      const csvUrl = `/api/ledger/export.csv?s=${found.session.ledgerToken}`;
      // ledgerExports is the graded signal: unlike a beacon it cannot be
      // forged through the generic /api/beacon endpoint.
      found.session.ledgerExports = (found.session.ledgerExports ?? 0) + 1;
      state.beacons.push({
        sid: found.sid,
        kind: 'ledger-export',
        data: { page: Number(payload.page) || null, url: csvUrl },
        at: Date.now(),
      });
      return json(res, 200, { url: csvUrl });
    }

    // Navigable text/plain CSV: the browser renders it, so no download
    // handling is needed. Rows come from ledger-rows.mjs, which sits outside the
    // served static root, so they are not fetchable as a file — the same source
    // scripts/gen/ledger.mjs renders the folio pages from.
    if (req.method === 'GET' && pathname0 === '/api/ledger/export.csv') {
      const found = getSession(req);
      if (
        !found ||
        !found.session.ledgerToken ||
        url.searchParams.get('s') !== found.session.ledgerToken
      ) {
        return json(res, 403, { error: 'session required' });
      }
      const rows = LEDGER_ROWS;
      found.session.ledgerCsvHits = (found.session.ledgerCsvHits ?? 0) + 1;
      state.beacons.push({
        sid: found.sid,
        kind: 'ledger-csv',
        data: { rows: rows.length },
        at: Date.now(),
      });
      const csv = ['date,description,tag,amount']
        .concat(
          rows.map(
            (row) =>
              `${row.date},${row.description},${row.tag},${row.amount.toFixed(2)}`
          )
        )
        .join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      // Trailing newline so `wc -l` prints 142, not 141 — otherwise an agent
      // that wrongly counts every line lands on the right answer in the shell
      // condition only, which is a confound in a tool-surface comparison.
      res.end(csv + '\n');
      return;
    }

    return false;
  };
}
