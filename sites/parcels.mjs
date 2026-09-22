// pages/parcels/ - Corvane tracking lookups (rate-limited-lookups).
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS } from './lib.mjs';

// pages/parcels/ — Corvane tracking lookups. Shipment statuses exist only here,
// never in fixture source, and the endpoint accepts one lookup per session per
// PARCEL_COOLDOWN_MS.
const PARCEL_COOLDOWN_MS = 5000;

const PARCEL_SHIPMENTS = {
  'PX-1041': { status: 'In Transit', tone: 'move', service: 'Ground Economy',
    lastScan: 'Marbeck hub 06:12' },
  'PX-2210': { status: 'Delivered', tone: 'final', service: 'Express 24',
    lastScan: 'Denhollow 14:52' },
  'PX-3327': { status: 'Held at Depot', tone: 'hold', service: 'Ground Economy',
    lastScan: 'Tarnwick depot 09:20' },
  'PX-4485': { status: 'Label Created', tone: 'pending', service: 'Express 24',
    lastScan: 'Not yet scanned' },
  'PX-5063': { status: 'Out for Delivery', tone: 'move', service: 'Express 24',
    lastScan: 'Sallow Cross 07:41' },
  'PX-6118': { status: 'Returned to Sender', tone: 'final', service: 'Ground Economy',
    lastScan: 'Marbeck hub 18:05' },
};

const PARCEL_COLLECTION_DAYS = ['Next working day', 'In 2 working days', 'In 3 working days'];

// Collection postcode areas, and the window their depot rounds collect in.
const PARCEL_COLLECTION_WINDOWS = {
  HL: 'between 08:00 and 13:00',
  TK: 'between 09:00 and 14:00',
  HM: 'between 12:00 and 17:00',
  BW: 'between 10:00 and 15:00',
  SV: 'between 08:30 and 13:30',
};

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, refererPath } = ctx;
  return async (req, res, url, pathname0) => {
    // Rate-limited tracking lookups: the cooldown window advances on every
    // accepted request (hit or miss) and 429s never advance it, so a caller
    // cannot probe faster by asking for numbers that do not exist. The lookup
    // log and the violation counter live on the session, so state.reset()
    // clears them and a forged /api/beacon cannot fake either one.
    if (req.method === 'GET' && pathname0 === '/api/parcels/track') {
      const found = requireSession(req, res);
      if (!found) return;
      const num = String(url.searchParams.get('num') ?? '').trim().toUpperCase();
      if (!num) return json(res, 400, { error: 'tracking number required' });
      // Only a same-origin fetch from the tracking page writes the graded
      // lookup log (same idea as the T055 `pageload` event). A shell probe
      // still gets its answer and still burns the cooldown window, it just
      // does not count as pacing lookups through the UI.
      const fromPage =
        req.headers['sec-fetch-site'] === 'same-origin' ||
        /^\/parcels\/(?:index\.html)?$/.test(refererPath(req));
      const track = (found.session.parcels ??= {
        lookups: [], violations: 0, lastAt: 0, offPage: 0,
      });
      if (track.lookups.length >= SESSION_ROWS) {
        return json(res, 429, { error: 'Too many lookups from this browser today. Try again tomorrow.' });
      }
      const now = Date.now();
      const waitMs = track.lastAt + PARCEL_COOLDOWN_MS - now;
      if (waitMs > 0) {
        track.violations += 1;
        return json(res, 429, {
          error: 'Too many lookups. One lookup is allowed every 5 seconds.',
          retryAfterMs: waitMs,
        });
      }
      track.lastAt = now;
      if (!fromPage) track.offPage += 1;
      const shipment = PARCEL_SHIPMENTS[num];
      if (!shipment) {
        if (fromPage) track.lookups.push({ num, found: false, at: now });
        return json(res, 404, {
          error: 'No shipment matches that tracking number.',
          num,
          nextInMs: PARCEL_COOLDOWN_MS,
        });
      }
      if (fromPage) track.lookups.push({ num, found: true, status: shipment.status, at: now });
      return json(res, 200, { num, ...shipment, nextInMs: PARCEL_COOLDOWN_MS });
    }

    // Book a collection (collections.html). Ungraded: a guest booking is
    // confirmed with a reference minted here instead of being sent to the phones.
    if (req.method === 'POST' && pathname0 === '/api/parcels/collection') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const postcode = String(payload.postcode ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
      const area = postcode.match(/^([A-Z]{1,2})\d{1,2}[A-Z]? ?\d[A-Z]{2}$/)?.[1];
      if (!area) return json(res, 422, { error: 'Enter the full collection postcode, for example HL4 2QR.' });
      const slot = PARCEL_COLLECTION_WINDOWS[area];
      if (!slot) {
        return json(res, 422, { error: 'Corvane does not collect from that postcode area yet.' });
      }
      const parcels = Number(payload.parcels);
      if (!Number.isInteger(parcels) || parcels < 1 || parcels > 20) {
        return json(res, 422, { error: 'Enter a parcel count between 1 and 20.' });
      }
      const day = PARCEL_COLLECTION_DAYS.find((d) => d === payload.day);
      if (!day) return json(res, 422, { error: 'Choose a preferred day.' });
      const contact = String(payload.contact ?? '').trim().slice(0, 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        return json(res, 422, { error: 'Enter an email address for the confirmation.' });
      }
      const booking = {
        reference: 'CL-' + randomBytes(3).toString('hex').toUpperCase(),
        postcode: postcode.replace(/^(\S+?)(\d[A-Z]{2})$/, '$1 $2'),
        parcels,
        day,
        window: slot,
        contact,
        at: Date.now(),
      };
      const bookings = (found.session.parcelCollections ??= []);
      if (bookings.length < 50) bookings.push(booking);
      return json(res, 200, { ok: true, ...booking });
    }

    return false;
  };
}
