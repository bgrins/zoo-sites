// pages/biglist/ - the 5,000-row virtualized directory.

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  const fromBiglist = fromPage('/biglist/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/biglist/rows') {
      const found = requireSession(req, res);
      if (!found) return;
      const TOTAL = 5000;
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '250') || 250, 250);
      if (!Number.isInteger(offset) || offset < 0 || offset >= TOTAL || limit < 1) {
        return json(res, 400, { error: 'bad range' });
      }
      const FIRST = ['Ansel', 'Beatrix', 'Cormac', 'Delia', 'Emmett', 'Freya',
        'Gideon', 'Harriet', 'Ivo', 'June', 'Kasper', 'Lorna', 'Milo', 'Nadia',
        'Oscar', 'Petra', 'Quentin', 'Rosalind', 'Stellan', 'Tamsin', 'Ulric',
        'Vera', 'Wendell', 'Xenia', 'Yusuf', 'Zelda'];
      const LAST = ['Abernathy', 'Bricker', 'Calloway', 'Dunmore', 'Eastwick',
        'Fenwick', 'Garrity', 'Holloway', 'Ivens', 'Jessop', 'Kirkwood',
        'Lindqvist', 'Mercer', 'Norwood', 'Ostrander', 'Pemberton', 'Quill',
        'Ravenel', 'Sablewood', 'Thackeray', 'Underhill', 'Vantassel',
        'Whitlock', 'Yardley', 'Zeller'];
      const DEPT = ['Accounting', 'Facilities', 'Legal', 'Logistics', 'Marketing',
        'Operations', 'Procurement', 'Research', 'Sales', 'Support'];
      const PREFIX = ['AV', 'BR', 'CT', 'DK', 'EM', 'FN', 'GL', 'HW', 'JP', 'KR',
        'LM', 'NS', 'PD', 'RT', 'SB', 'TW'];
      // Deterministic per-index hash: same rows for every request and session.
      const mix = (i) => {
        let h = (i + 0x9e3779b9) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
        h = (h ^ (h >>> 15)) >>> 0;
        h = Math.imul(h ^ (h >>> 7), 0x735a2d97);
        return (h ^ (h >>> 15)) >>> 0;
      };
      // The needle lives only here, never in fixture files on disk.
      const rowFor = (i) => {
        if (i === 3417) {
          return { id: i + 1, badge: 'QX-4417', name: 'Ingrid Halvorsen', dept: 'Research', floor: 14 };
        }
        const h = mix(i);
        return {
          id: i + 1,
          badge: PREFIX[h % PREFIX.length] + '-' + (1000 + ((h >>> 4) % 9000)),
          name: FIRST[(h >>> 8) % FIRST.length] + ' ' + LAST[(h >>> 13) % LAST.length],
          dept: DEPT[(h >>> 18) % DEPT.length],
          floor: 1 + ((h >>> 22) % 22),
        };
      };
      const rows = [];
      for (let i = offset; i < Math.min(offset + limit, TOTAL); i++) {
        rows.push(rowFor(i));
      }
      // Graded route signal: a per-session counter this endpoint owns. The
      // `biglist-fetch` beacon below stays for the detail line only — POST
      // /api/beacon accepts an arbitrary kind, so a beacon row is forgeable
      // with nothing but the page nonce. A shell sweep of this endpoint does
      // produce genuine fetches; that is derivation, not forgery, so it is made
      // legible through offPage rather than prohibited.
      const bl = (found.session.biglist ??= { fetches: 0, rows: 0, offsets: [], offPage: 0 });
      // Legibility, never proof: curl sets these headers freely.
      const fromPage = fromBiglist(req);
      bl.fetches += 1;
      bl.rows += rows.length;
      if (!bl.offsets.includes(offset)) bl.offsets.push(offset);
      if (!fromPage) bl.offPage += 1;
      state.beacons.push({
        sid: found.sid,
        kind: 'biglist-fetch',
        data: { offset, fromPage },
        at: Date.now(),
      });
      return json(res, 200, { total: TOTAL, offset, rows });
    }

    return false;
  };
}
