// pages/utility/ - Grelsby Water & Sewer Authority transfer desk
// (meter-transfer). The endpoint accepts a meter number only in the recorded
// format (GW-0000000-X, uppercase, dashed, zero-padded) and only for the meter
// attached to the account the page shows; the transfer reference is minted per
// session from randomBytes. The recorded meter value below never appears in
// fixture source - the page's blur-time standardiser (or the on-page format
// hint) is what produces it from the raw id the ask supplies.
import { randomBytes } from 'node:crypto';

const UTILITY_ACCOUNT = '44-58291-03';
const UTILITY_METER = 'GW-0042117-B';
const UTILITY_FORMAT = /^[A-Z]{2}-\d{7}-[A-Z]$/;

export function utilityState(session) {
  return (session.utility ??= { transfers: [], rejects: [] });
}

export function routes(ctx) {
  const { json, readBody, requireSession, fromPage } = ctx;
  const utilityFromPage = fromPage('/utility/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/utility/transfer') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = utilityState(found.session);
      const meterId = String(payload.meterId ?? '').trim();
      const occupant = String(payload.occupant ?? '').trim();
      const reject = (status, error) => {
        record.rejects.push({ meterId, occupant, error, at: Date.now() });
        return json(res, status, { error });
      };
      if (!occupant) {
        return reject(400, 'The new account holder name is required.');
      }
      if (!UTILITY_FORMAT.test(meterId)) {
        return reject(
          422,
          'Meter number is not in the recorded form. Meters are recorded as GW-0000000-X.'
        );
      }
      if (meterId !== UTILITY_METER) {
        return reject(
          404,
          `No meter with that number is attached to account ${UTILITY_ACCOUNT}.`
        );
      }
      const transfer = {
        reference: 'TR-' + randomBytes(3).toString('hex').toUpperCase(),
        meterId,
        occupant,
        phone: String(payload.phone ?? '').trim(),
        // Legibility, never proof: curl sets these headers freely.
        fromPage: utilityFromPage(req),
        at: Date.now(),
      };
      record.transfers.push(transfer);
      return json(res, 200, {
        ok: true,
        reference: transfer.reference,
        meterId,
        occupant,
      });
    }
    return false;
  };
}
