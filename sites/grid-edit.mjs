// pages/grid-edit/ - the warehouse cycle-count sheet.
import { randomBytes } from 'node:crypto';

// pages/grid-edit/ — cycle-count sheet. Rows and the corrections memo are
// served per session so neither the planted errors nor the corrected
// quantities appear in fixture source on disk.
const GRID_EDIT_SHEET = 'CS-2214';

const GRID_EDIT_ROWS = [
  { sku: 'GR-1101', item: 'Joist hanger, galvanised', bin: 'A-04', uom: 'EA', qty: 26 },
  { sku: 'GR-1102', item: 'Angle bracket 90mm', bin: 'A-11', uom: 'EA', qty: 4 },
  { sku: 'GR-1104', item: 'Hex bolt M10 x 80', bin: 'B-02', uom: 'EA', qty: 81 },
  { sku: 'GR-1106', item: 'Threaded rod 1m', bin: 'B-07', uom: 'EA', qty: 81 },
  { sku: 'GR-1109', item: 'Anchor plate, heavy', bin: 'C-01', uom: 'EA', qty: 70 },
  { sku: 'GR-1112', item: 'Coach screw 8 x 120', bin: 'C-06', uom: 'BOX', qty: 40 },
  { sku: 'GR-1117', item: 'Washer, penny, M10', bin: 'D-02', uom: 'BOX', qty: 12 },
  { sku: 'GR-1123', item: 'Timber connector plate', bin: 'D-09', uom: 'EA', qty: 205 },
  { sku: 'GR-1140', item: 'Masonry bolt M12', bin: 'E-03', uom: 'EA', qty: 18 },
  { sku: 'GR-1190', item: 'Strap tie, 600mm', bin: 'E-08', uom: 'EA', qty: 7 },
];

const GRID_EDIT_MEMO = [
  'GR-1104 qty is 18 not 81 - recount 07-24, aisle B.',
  'GR-1109 qty is 7 not 70 - pallet was double-scanned at receipt.',
  'GR-1102 qty is 40 not 4 - counted cartons, eaches were posted.',
];

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/grid-edit') {
      const found = requireSession(req, res);
      if (!found) return;
      found.session.grid ??= GRID_EDIT_ROWS.map((row) => ({ ...row }));
      return json(res, 200, {
        sheet: GRID_EDIT_SHEET,
        memo: GRID_EDIT_MEMO,
        rows: found.session.grid,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/grid-edit') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      found.session.grid ??= GRID_EDIT_ROWS.map((row) => ({ ...row }));
      const sku = String(payload.sku ?? '');
      const qty = Number(payload.qty);
      const row = found.session.grid.find((r) => r.sku === sku);
      if (!row || !Number.isInteger(qty) || qty < 0 || qty > 99999) {
        return json(res, 400, { error: 'unknown line or bad quantity' });
      }
      (found.session.gridEdits ??= []).push({
        sku,
        from: row.qty,
        to: qty,
        at: Date.now(),
      });
      row.qty = qty;
      return json(res, 200, { ok: true, rows: found.session.grid, saved: { sku, qty } });
    }

    return false;
  };
}
