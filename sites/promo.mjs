// pages/promo/ - overlapping offer banners (promo-zindex).
import { randomBytes } from 'node:crypto';

const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/promo/claim') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
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
      if (button !== 'top') {
        return json(res, 200, { claimed: false, message: 'This offer is no longer available.' });
      }
      // The voucher is minted per session from randomBytes, so it never
      // appears in fixture source on disk and one run's code grades no other.
      const promo = (found.session.promo ??= {});
      promo.voucher ??=
        'VLT-' + [...randomBytes(4)].map((b) => VOUCHER_ALPHABET[b % 32]).join('');
      return json(res, 200, { claimed: true, voucher: promo.voucher });
    }

    return false;
  };
}
