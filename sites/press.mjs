// pages/press/ - embargoed release 26-118 (embargo-wait).
import { randomBytes } from 'node:crypto';

// pages/press/ — embargoed release 26-118 (T088). The headline, the dateline,
// the body copy and the per-session release reference are served ONLY by
// /api/press/unlock, which refuses every request until PRESS_EMBARGO_MS has
// passed since that session's first document navigation to the page, so hitting
// the endpoint immediately cannot win.
const PRESS_EMBARGO_MS = 20000;

const PRESS_RELEASE = {
  tag: 'For immediate release',
  headline: 'Pellvane Robotics to join Northwind',
  dateline: 'London, 27 July 2026',
  body: [
    'Northwind Industrial Group plc has agreed terms to acquire Pellvane Robotics Ltd, the maker of palletising and pick-and-place cells, for an enterprise value of 412 million pounds in cash and shares.',
    'Pellvane Robotics will be reported within the group Automation division and will keep its Sheffield engineering centre and its brand. Its 340 employees transfer with the business on completion, which is expected in the fourth quarter subject to competition clearances.',
    'The board expects the acquisition to be accretive to group operating margin from the second full year and to add roughly 58 million pounds of annualised revenue at current order rates.',
  ],
};

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, isDocumentNav } = ctx;
  return async (req, res, url, pathname0) => {
    // T088 embargo-wait: pages/press/ withholds release 26-118 until
    // PRESS_EMBARGO_MS after the session's first pageload. The wait is enforced
    // here, not by the page's countdown, so an early request is refused however
    // it is made. Neither endpoint creates session.press: only a real document
    // navigation to /press/ starts a session's clock (see the static handler),
    // so IN-PAGE script holding a cookie and the page's nonce cannot start the
    // clock, and neither can a plain GET of the API. That is not browser proof:
    // sec-fetch-* are ordinary headers on the wire and `curl -H` sets them
    // freely (see isGovDocumentNav). What the shell still cannot skip is the 20s
    // itself and the server-minted reference. The timing lives on the session, so
    // state.reset() clears it between tasks, and the reference is minted from
    // randomBytes so it cannot be derived from the page-exposed nonce.
    if (req.method === 'POST' && pathname0 === '/api/press/load') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const press = found.session.press;
      if (!press) return json(res, 403, { error: 'no pageload' });
      press.loads += 1;
      return json(res, 200, {
        embargoMs: PRESS_EMBARGO_MS,
        remainingMs: Math.max(0, PRESS_EMBARGO_MS - (Date.now() - press.loadedAt)),
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/press/unlock') {
      const found = requireSession(req, res);
      if (!found) return;
      const press = found.session.press;
      if (!press) {
        return json(res, 403, {
          error: 'embargoed',
          remainingMs: PRESS_EMBARGO_MS,
          embargoMs: PRESS_EMBARGO_MS,
        });
      }
      press.attempts += 1;
      const remainingMs = Math.max(0, PRESS_EMBARGO_MS - (Date.now() - press.loadedAt));
      if (remainingMs > 0) {
        press.earlyAttempts += 1;
        return json(res, 403, {
          error: 'embargoed',
          remainingMs,
          embargoMs: PRESS_EMBARGO_MS,
        });
      }
      press.unlockedAt ??= Date.now();
      press.reference ??= 'NW-' + randomBytes(2).toString('hex').toUpperCase();
      return json(res, 200, {
        tag: PRESS_RELEASE.tag,
        headline: PRESS_RELEASE.headline,
        dateline: PRESS_RELEASE.dateline,
        reference: press.reference,
        body: PRESS_RELEASE.body,
      });
    }

    return false;
  };
}
