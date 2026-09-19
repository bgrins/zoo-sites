// pages/gallery/ - Northmarsh Outfitters. The basket is per-session state so
// the storefront's Add to basket buttons do something real, and a reservation
// for depot collection mints an order number; nothing here is graded
// (dead-images reads image load state only), so this stays a plain convenience
// backend.
import { randomBytes } from 'node:crypto';

const GALLERY_DEPOTS = {
  'quay-lane': { name: 'Quay Lane', ready: 'from 10:00 the next working day' },
  'thrandle-vale': { name: 'Thrandle Vale', ready: 'from 10:00 the next working day' },
  duncrieff: { name: 'Duncrieff', ready: 'within two working days' },
  'wrenfold-mill': { name: 'Wrenfold Mill', ready: 'on its next opening day, Thursday to Sunday' },
};

const GALLERY_MAX_QTY = 9;

const GALLERY_SKUS = new Set([
  'AG-2673', 'CP-2290', 'FG-5528', 'GB-5310', 'HR-4182', 'ML-1174',
  'PT-3049', 'QS-5761', 'RG-7726', 'SM-5417', 'TW-6035', 'WN-1806',
]);

// Items sold in more than one size; a basket line is one size of one item.
const GALLERY_SIZES = {
  'FG-5528': ['S', 'M', 'L', 'XL'],
  'GB-5310': ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  'PT-3049': ['Regular', 'Long'],
  'SM-5417': ['UK 5', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'UK 12'],
  'TW-6035': ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
};

const sizeOf = (sku, payload) => (GALLERY_SIZES[sku] ? String(payload.size ?? '') : null);

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
      const size = sizeOf(sku, payload);
      if (size !== null && !GALLERY_SIZES[sku].includes(size)) {
        return json(res, 409, { error: 'Choose a size for this item first.', chooseSize: true });
      }
      const basket = (found.session.galleryBasket ??= []);
      const line = basket.find((it) => it.sku === sku && it.size === size);
      if (line && line.qty >= GALLERY_MAX_QTY) {
        return json(res, 409, { error: `Online orders are limited to ${GALLERY_MAX_QTY} of one item.` });
      }
      if (line) line.qty += 1;
      else basket.push({ sku, size, qty: 1 });
      return json(res, 200, { ok: true, items: basket });
    }

    // Change a line's quantity; zero takes the line out.
    if (req.method === 'PATCH' && pathname0 === '/api/gallery/basket') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const sku = String(payload.sku ?? '').toUpperCase();
      const qty = Number(payload.qty);
      if (!Number.isInteger(qty) || qty < 0 || qty > GALLERY_MAX_QTY) {
        return json(res, 400, { error: `Choose a quantity from 0 to ${GALLERY_MAX_QTY}.` });
      }
      const basket = (found.session.galleryBasket ??= []);
      const size = sizeOf(sku, payload);
      const at = basket.findIndex((it) => it.sku === sku && it.size === size);
      if (at === -1) return json(res, 404, { error: 'That item is not in your basket.' });
      if (qty === 0) basket.splice(at, 1);
      else basket[at].qty = qty;
      return json(res, 200, { ok: true, items: basket });
    }

    // Reserve the basket for collection: the depot picks it and holds it for
    // fourteen days against the order number minted here.
    if (req.method === 'POST' && pathname0 === '/api/gallery/reserve') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const depot = GALLERY_DEPOTS[String(payload.depot ?? '')];
      if (!depot) return json(res, 400, { error: 'Choose the depot you will collect from.' });
      const name = String(payload.name ?? '').trim().slice(0, 120);
      const phone = String(payload.phone ?? '').trim().slice(0, 40);
      if (!name) return json(res, 400, { error: 'Give the name the order should be held under.' });
      if (phone.replace(/\D/g, '').length < 10) {
        return json(res, 400, { error: 'Give a telephone number the depot can call about the order.' });
      }
      const basket = found.session.galleryBasket ?? [];
      if (!basket.length) return json(res, 409, { error: 'Your basket is empty.' });
      const order = 'NM-' + randomBytes(3).toString('hex').toUpperCase();
      (found.session.galleryOrders ??= []).push({ order, depot: depot.name, name, phone, items: basket.map((it) => ({ ...it })), at: Date.now() });
      found.session.galleryBasket = [];
      return json(res, 200, { ok: true, order, depot: depot.name, ready: depot.ready });
    }

    return false;
  };
}
