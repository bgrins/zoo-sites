// pages/bistro/ - The Brindle Fig, a neighbourhood bistro with an order-ahead
// counter (order-modifiers). Menu prices, the large-size upcharges and every
// extra's surcharge live only here - no fixture page or client script carries
// them - and the order code is minted from randomBytes, so a reported code and
// total are checkable only against what this session actually built and was
// charged.
import { randomBytes } from 'node:crypto';
import { round2 } from './lib.mjs';

const BISTRO_MENU = {
  'beet-flatbread': {
    name: 'Charred Beet Flatbread',
    course: 'Flatbreads',
    blurb: 'Wood-oven flatbread, charred beets over whipped ricotta.',
    base: 11.75,
    largeUpcharge: 3.25,
    comesWith: {
      'red-onion': 'Red onion',
      'whipped-ricotta': 'Whipped ricotta',
      arugula: 'Arugula',
    },
    extras: {
      feta: { label: 'Feta', price: 1.6 },
      basil: { label: 'Fresh basil', price: 0.9 },
      'hot-honey': { label: 'Hot honey', price: 1.1 },
      olives: { label: 'Castelvetrano olives', price: 1.35 },
    },
  },
  'grain-bowl': {
    name: 'Harvest Grain Bowl',
    course: 'Bowls',
    blurb: 'Farro and barley, roast squash, herbs from the yard.',
    base: 10.9,
    largeUpcharge: 2.75,
    comesWith: {
      'pickled-carrot': 'Pickled carrot',
      kale: 'Shredded kale',
      tahini: 'Tahini dressing',
    },
    extras: {
      'smoked-almonds': { label: 'Smoked almonds', price: 1.45 },
      halloumi: { label: 'Grilled halloumi', price: 2.4 },
      avocado: { label: 'Avocado', price: 2.1 },
    },
  },
  'tomato-bisque': {
    name: 'Smoked Tomato Bisque',
    course: 'Soups',
    blurb: 'Slow-smoked tomatoes, finished at the pass.',
    base: 6.9,
    largeUpcharge: 1.9,
    comesWith: {
      croutons: 'Rye croutons',
      'chive-oil': 'Chive oil',
    },
    extras: {
      'gruyere-toast': { label: 'Gruyere toast', price: 2.5 },
      'creme-fraiche': { label: 'Creme fraiche', price: 1.2 },
    },
  },
  'chicken-baguette': {
    name: 'Roast Chicken Baguette',
    course: 'Sandwiches',
    blurb: 'Half baguette, Sunday-roast chicken, served warm.',
    base: 12.4,
    largeUpcharge: 3.1,
    comesWith: {
      aioli: 'Garlic aioli',
      pickles: 'House pickles',
      frisee: 'Frisee',
    },
    extras: {
      bacon: { label: 'Smoked bacon', price: 2.2 },
      gruyere: { label: 'Gruyere', price: 1.6 },
    },
  },
};

const BISTRO_SIZES = ['medium', 'large'];

function bistroState(session) {
  return (session.bistro ??= { cart: [], orders: [], rejects: [] });
}

function bistroResolveItem(key) {
  const raw = String(key ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (Object.hasOwn(BISTRO_MENU, raw)) return { id: raw, item: BISTRO_MENU[raw] };
  const byName = Object.entries(BISTRO_MENU).find(
    ([, item]) => item.name.toLowerCase() === raw
  );
  return byName ? { id: byName[0], item: byName[1] } : null;
}

function bistroSubtotal(record) {
  return round2(record.cart.reduce((sum, line) => sum + line.price, 0));
}

function bistroCartPayload(record) {
  return {
    lines: record.cart.map((line, index) => ({ index, ...line })),
    count: record.cart.length,
    subtotal: bistroSubtotal(record),
  };
}

export function routes(ctx) {
  const { json, readJson, requireSession } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/bistro/menu') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, {
        menu: Object.entries(BISTRO_MENU).map(([id, item]) => ({
          id,
          name: item.name,
          course: item.course,
          blurb: item.blurb,
          base: item.base,
          largeUpcharge: item.largeUpcharge,
          comesWith: Object.entries(item.comesWith).map(([mid, label]) => ({
            id: mid,
            label,
          })),
          extras: Object.entries(item.extras).map(([mid, extra]) => ({
            id: mid,
            label: extra.label,
            price: extra.price,
          })),
        })),
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/bistro/cart') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, bistroCartPayload(bistroState(found.session)));
    }

    if (req.method === 'POST' && pathname0 === '/api/bistro/cart') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = bistroState(found.session);
      const resolved = bistroResolveItem(payload.item);
      if (!resolved) {
        record.rejects.push({ item: String(payload.item ?? ''), at: Date.now() });
        return json(res, 404, {
          error: `Nothing on the menu matches "${String(payload.item ?? '')}".`,
        });
      }
      const { id, item } = resolved;
      const size = String(payload.size ?? 'medium').trim().toLowerCase();
      if (!BISTRO_SIZES.includes(size)) {
        return json(res, 400, { error: 'Size must be medium or large.' });
      }
      const norm = (list) => [
        ...new Set(
          (Array.isArray(list) ? list : []).map((v) =>
            String(v).trim().toLowerCase()
          )
        ),
      ];
      const added = norm(payload.added);
      const removed = norm(payload.removed);
      const badAdd = added.find((mid) => !Object.hasOwn(item.extras, mid));
      if (badAdd !== undefined) {
        return json(res, 400, {
          error: `"${badAdd}" is not offered as an extra on the ${item.name}.`,
        });
      }
      const badRemove = removed.find((mid) => !Object.hasOwn(item.comesWith, mid));
      if (badRemove !== undefined) {
        return json(res, 400, {
          error: `"${badRemove}" does not come on the ${item.name}, so it cannot be left off.`,
        });
      }
      const price = round2(
        item.base +
          (size === 'large' ? item.largeUpcharge : 0) +
          added.reduce((sum, mid) => sum + item.extras[mid].price, 0)
      );
      const line = { item: id, name: item.name, size, added, removed, price, at: Date.now() };
      record.cart.push(line);
      return json(res, 200, { ok: true, line, ...bistroCartPayload(record) });
    }

    if (req.method === 'POST' && pathname0 === '/api/bistro/cart/remove') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = bistroState(found.session);
      const index = Math.trunc(Number(payload.index));
      if (!Number.isInteger(index) || index < 0 || index >= record.cart.length) {
        return json(res, 404, { error: 'That line is not on your ticket.' });
      }
      record.cart.splice(index, 1);
      return json(res, 200, { ok: true, ...bistroCartPayload(record) });
    }

    if (req.method === 'POST' && pathname0 === '/api/bistro/order') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = bistroState(found.session);
      if (!record.cart.length) {
        return json(res, 409, {
          error: 'Your ticket is empty. Build at least one item before placing the order.',
        });
      }
      const order = {
        code: 'BF-' + randomBytes(3).toString('hex').toUpperCase(),
        total: bistroSubtotal(record),
        lines: record.cart,
        placedAt: Date.now(),
      };
      record.orders.push(order);
      record.cart = [];
      return json(res, 200, {
        ok: true,
        code: order.code,
        total: order.total,
        lines: order.lines,
        message: 'Ready at the counter in about 15 minutes.',
      });
    }

    return false;
  };
}
