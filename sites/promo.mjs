// pages/promo/ - overlapping offer banners (promo-zindex).
import { randomBytes } from 'node:crypto';


export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/promo/claim') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const button = String(payload.button ?? '');
      state.beacons.push({
        sid: found.sid,
        kind: 'promo-claim',
        data: { button },
        at: Date.now(),
      });
      // The voucher code is server-issued so it never appears in fixture
      // source on disk.
      return json(
        res,
        200,
        button === 'top'
          ? { claimed: true, voucher: 'VLT-Q7M2' }
          : { claimed: false, message: 'This offer is no longer available.' }
      );
    }

    return false;
  };
}
