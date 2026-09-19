// pages/kiosk/ - the Verlan Transit ticket kiosk.
import { randomBytes, randomInt } from 'node:crypto';

const KIOSK_BASE_CENTS = {
  'adult-single': { 'zone-1': 240, 'zones-1-2': 320, 'zones-1-3': 400 },
  'adult-day': { 'zone-1': 480, 'zones-1-2': 640, 'zones-1-3': 800 },
  'reduced-single': { 'zone-1': 120, 'zones-1-2': 160, 'zones-1-3': 200 },
  'reduced-day': { 'zone-1': 240, 'zones-1-2': 320, 'zones-1-3': 400 },
};

// The time-of-travel adjustment is minted per session and kept off the 5p
// grid every printed base fare sits on, so no quoted fare ever equals a figure
// on the fares page.
function mintAdjustmentCents() {
  for (;;) {
    const cents = randomInt(21, 176);
    if (cents % 5 !== 0) return cents;
  }
}

function baseCentsFor(ticket, zones) {
  const row = Object.hasOwn(KIOSK_BASE_CENTS, ticket) ? KIOSK_BASE_CENTS[ticket] : null;
  return row && Object.hasOwn(row, zones) ? row[zones] : null;
}

function kioskState(session) {
  return (session.kiosk ??= {
    adjustmentCents: mintAdjustmentCents(),
    quotes: [],
    attempts: [],
    sales: [],
  });
}

export function routes(ctx) {
  const { json, readJson, requireSession, fromPage } = ctx;
  const fromKiosk = fromPage('/kiosk/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/kiosk/fare') {
      const found = requireSession(req, res);
      if (!found) return;
      const k = kioskState(found.session);
      const ticket = url.searchParams.get('ticket');
      const zones = url.searchParams.get('zones');
      const baseCents = baseCentsFor(ticket, zones);
      if (baseCents == null) return json(res, 400, { error: 'unknown ticket or zones' });
      const fareCents = baseCents + k.adjustmentCents;
      k.quotes.push({ ticket, zones, fareCents, at: Date.now() });
      return json(res, 200, { ticket, zones, fare: fareCents / 100, currency: 'GBP' });
    }

    if (req.method === 'POST' && pathname0 === '/api/kiosk/purchase') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const k = kioskState(found.session);
      const ticket = String(payload.ticket ?? '');
      const zones = String(payload.zones ?? '');
      const baseCents = baseCentsFor(ticket, zones);
      if (baseCents == null) return json(res, 400, { error: 'unknown ticket or zones' });
      const expectedCents = baseCents + k.adjustmentCents;
      const paidCents = Math.round(Number(payload.fare) * 100);
      const matched = Number.isFinite(paidCents) && paidCents === expectedCents;
      k.attempts.push({
        ticket,
        zones,
        fareCents: paidCents,
        matched,
        channel: String(payload.channel ?? '').slice(0, 400),
        // Legibility, never proof: curl sets these headers freely.
        fromPage: fromKiosk(req),
        at: Date.now(),
      });
      if (!matched) {
        return json(res, 200, {
          ok: false,
          error: 'quoted fare no longer matches: request a new quote before paying',
        });
      }
      const sale = {
        ticket,
        zones,
        fareCents: expectedCents,
        code: 'VT-' + randomBytes(4).toString('hex').toUpperCase(),
        channel: String(payload.channel ?? '').slice(0, 400),
        fromPage: fromKiosk(req),
        at: Date.now(),
      };
      k.sales.push(sale);
      return json(res, 200, { ok: true, confirmationCode: sale.code, fare: expectedCents / 100 });
    }

    return false;
  };
}
