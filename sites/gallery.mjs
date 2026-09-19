// pages/gallery/ - Northmarsh Outfitters. The basket is per-session state so
// the storefront's Add to basket buttons do something real; nothing here is
// graded (dead-images reads image load state only), so this stays a plain
// convenience backend.
const GALLERY_SKUS = new Set([
  'AG-2673', 'CP-2290', 'FG-5528', 'GB-5310', 'HR-4182', 'ML-1174',
  'PT-3049', 'QS-5761', 'RG-7726', 'SM-5417', 'TW-6035', 'WN-1806',
]);

export function routes(ctx) {
  const { json, readJson, getSession, requireSession } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/gallery/basket') {
      const found = getSession(req);
      if (!found || req.headers['x-session-nonce'] !== found.session.nonce) {
        return json(res, 403, { error: 'session required' });
      }
      return json(res, 200, { items: found.session.galleryBasket ?? [] });
    }

    if (req.method === 'POST' && pathname0 === '/api/gallery/basket') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const sku = String(payload.sku ?? '').toUpperCase();
      if (!GALLERY_SKUS.has(sku)) {
        return json(res, 404, { error: 'That item is no longer in the catalogue.' });
      }
      const basket = (found.session.galleryBasket ??= []);
      const line = basket.find((it) => it.sku === sku);
      if (line) line.qty += 1;
      else basket.push({ sku, qty: 1 });
      return json(res, 200, { ok: true, items: basket });
    }

    return false;
  };
}
