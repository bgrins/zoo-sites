// pages/parcels/ - Corvane tracking lookups (rate-limited-lookups).

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
    lastScan: 'Tyburn depot 09:20' },
  'PX-4485': { status: 'Label Created', tone: 'pending', service: 'Express 24',
    lastScan: 'Not yet scanned' },
  'PX-5063': { status: 'Out for Delivery', tone: 'move', service: 'Express 24',
    lastScan: 'Sallow Cross 07:41' },
  'PX-6118': { status: 'Returned to Sender', tone: 'final', service: 'Ground Economy',
    lastScan: 'Marbeck hub 18:05' },
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

    return false;
  };
}
