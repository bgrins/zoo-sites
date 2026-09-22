// pages/parcels/ - Corvane tracking lookups (rate-limited-lookups).
import { randomBytes } from 'node:crypto';
import { DAY_MS, SESSION_ROWS, dayText, utcDay } from './lib.mjs';

// pages/parcels/ — Corvane tracking lookups. Shipment statuses exist only here,
// never in fixture source, and the endpoint accepts one lookup per session per
// PARCEL_COOLDOWN_MS.
const PARCEL_COOLDOWN_MS = 5000;

// Each shipment's scans, newest first, are history minted from the session's
// opening (hard rule 9): `on` counts working days back from the day the
// history ends, with `at` the UTC time on that day. The history ends on the
// session's UTC day, or on the day before it when the session opened ahead of
// the newest scan. Every `at` is before 23:00 UTC, so the UK day a scan prints
// is its UTC day. The delivery line is dated `eta.on` working days after the
// session's day, or `eta.days` after the day of scan `eta.from`, printing that
// scan's time too when `eta.time` is set.
const PARCEL_SHIPMENTS = {
  'PX-1041': {
    status: 'In Transit', tone: 'move', service: 'Ground Economy',
    eta: { label: 'Expected delivery', on: 1 },
    scans: [
      { on: -1, at: '05:12', place: 'Marbeck hub', what: 'Network scan, sorted for Brackwold depot' },
      { on: -2, at: '22:36', place: 'Marbeck hub', what: 'Network scan, arrived on the evening trunk' },
      { on: -2, at: '15:55', place: 'Hollinmere depot', what: 'Network scan, collected parcel scanned in' },
      { on: -2, at: '13:20', place: 'Hollinmere', what: 'Collected from sender' },
    ],
  },
  'PX-2210': {
    status: 'Delivered', tone: 'final', service: 'Express 24',
    eta: { label: 'Delivered', from: 0, days: 0, time: true },
    scans: [
      { on: -1, at: '13:52', place: 'Denhollow', what: 'Final scan, delivered to the front door' },
      { on: -1, at: '06:05', place: 'Halston depot', what: 'Out for delivery on the Denhollow round' },
      { on: -1, at: '02:48', place: 'Marbeck hub', what: 'Network scan, sorted for Halston depot' },
      { on: -2, at: '16:10', place: 'Seddon Vale depot', what: 'Network scan, collected parcel scanned in' },
      { on: -2, at: '15:02', place: 'Seddon Vale', what: 'Collected from sender' },
    ],
  },
  'PX-3327': {
    status: 'Held at Depot', tone: 'hold', service: 'Ground Economy',
    eta: { label: 'Held until', from: 1, days: 7 },
    scans: [
      { on: -1, at: '08:20', place: 'Tarnwick depot', what: 'Depot hold, the address needs a flat number from the receiver' },
      { on: -1, at: '03:40', place: 'Tarnwick depot', what: 'Network scan, arrived from Marbeck' },
      { on: -2, at: '21:15', place: 'Marbeck hub', what: 'Network scan, sorted for Tarnwick depot' },
      { on: -3, at: '16:30', place: 'Halston depot', what: 'Network scan, collected parcel scanned in' },
      { on: -3, at: '14:05', place: 'Halston', what: 'Collected from sender' },
    ],
  },
  'PX-4485': {
    status: 'Label Created', tone: 'pending', service: 'Express 24',
    eta: { label: 'Expected delivery', note: 'confirmed at the first network scan' },
    scans: [
      { on: -1, at: '15:03', place: 'Online', what: 'Pre-advice, shipment registered by the sender' },
    ],
  },
  'PX-5063': {
    status: 'Out for Delivery', tone: 'move', service: 'Express 24',
    eta: { label: 'Expected delivery', on: 0 },
    scans: [
      { on: 0, at: '06:40', place: 'Halston depot', what: 'Out for delivery on the Sallow Cross round' },
      { on: 0, at: '03:25', place: 'Halston depot', what: 'Network scan, arrived from Marbeck' },
      { on: -1, at: '18:40', place: 'Marbeck hub', what: 'Network scan, arrived on the evening trunk' },
      { on: -1, at: '15:20', place: 'Brackwold depot', what: 'Network scan, collected parcel scanned in' },
      { on: -1, at: '14:10', place: 'Brackwold', what: 'Collected from sender' },
    ],
  },
  'PX-6118': {
    status: 'Returned to Sender', tone: 'final', service: 'Ground Economy',
    eta: { label: 'Returned', from: 0, days: 0 },
    scans: [
      { on: -1, at: '17:05', place: 'Marbeck hub', what: 'Final scan, returned to sender' },
      { on: -3, at: '11:40', place: 'Denhollow', what: 'Delivery attempted, no one in (third attempt)' },
      { on: -4, at: '10:55', place: 'Denhollow', what: 'Delivery attempted, no one in' },
      { on: -5, at: '12:20', place: 'Denhollow', what: 'Delivery attempted, no one in' },
      { on: -6, at: '03:30', place: 'Halston depot', what: 'Network scan, arrived from Marbeck' },
      { on: -7, at: '15:45', place: 'Tarnwick depot', what: 'Collected from sender' },
    ],
  },
};

// The n-th Monday-to-Friday day after (n > 0) or before (n < 0) a UTC day.
function workingDay(day, n) {
  let at = day;
  for (let left = Math.abs(n); left > 0; ) {
    at += Math.sign(n) * DAY_MS;
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return at;
}

// Scan times read as UK clock time, where the network runs.
const PARCEL_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function scanClock(ms) {
  const p = Object.fromEntries(PARCEL_CLOCK.formatToParts(ms).map(({ type, value }) => [type, value]));
  return { day: `${p.weekday} ${p.day} ${p.month.slice(0, 3)}`, time: `${p.hour}:${p.minute}` };
}

function trackingResult(num, shipment, openedAt) {
  const { scans: spec, eta, ...rest } = shipment;
  const today = utcDay(openedAt);
  const history = (end) => spec.map(({ on, at }) => workingDay(end, on) + Date.parse(`1970-01-01T${at}Z`));
  let times = history(today);
  if (times[0] > openedAt) times = history(today - DAY_MS);
  const scans = spec.map(({ place, what }, i) => ({
    at: new Date(times[i]).toISOString(), ...scanClock(times[i]), place, what,
  }));
  const latest = scans.find((scan) => scan.place !== 'Online');
  let due = null;
  if (eta.on !== undefined) due = workingDay(today, eta.on);
  else if (eta.from !== undefined) due = utcDay(Date.parse(scans[eta.from].at)) + eta.days * DAY_MS;
  return {
    num,
    ...rest,
    lastScan: latest ? `${latest.place}, ${latest.day} ${latest.time}` : 'Not yet scanned',
    eta: due === null
      ? { label: eta.label, note: eta.note }
      : {
          label: eta.label,
          iso: new Date(due).toISOString().slice(0, 10),
          day: dayText(due, { year: false }),
          time: eta.time ? scans[eta.from].time : null,
        },
    scans,
  };
}

const PARCEL_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const { state, json, readBody, readJson, getSession, requireSession, fromPage, refererPath } = ctx;
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
      return json(res, 200, { ...trackingResult(num, shipment, found.session.createdAt), nextInMs: PARCEL_COOLDOWN_MS });
    }

    // Sign-in and password reset (signin.html). Ungraded: no Corvane account
    // exists, so every sign-in is refused, and a reset answers alike for every
    // address so the form never says which addresses hold an account.
    if (req.method === 'POST' && (pathname0 === '/api/parcels/signin' || pathname0 === '/api/parcels/reset')) {
      let payload = await readJson(req, res, { error: 'Malformed request body.' });
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const email = String(payload.email ?? '').trim().slice(0, 254);
      if (!PARCEL_EMAIL.test(email)) {
        return json(res, 422, { error: 'That does not look like a valid email address.' });
      }
      const account = (found.session.parcelsAccount ??= { signIns: 0, resets: 0 });
      if (pathname0 === '/api/parcels/reset') {
        account.resets = Math.min(account.resets + 1, SESSION_ROWS);
        return json(res, 200, {
          ok: true,
          message: `If an account uses ${email}, a reset link is on its way. It works for one hour.`,
        });
      }
      if (!String(payload.password ?? '')) return json(res, 422, { error: 'Enter your password.' });
      account.signIns = Math.min(account.signIns + 1, SESSION_ROWS);
      return json(res, 401, {
        error: 'We could not match those details to an account. Check the address and password, or reset the password below.',
      });
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
      if (!PARCEL_EMAIL.test(contact)) {
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
