// pages/news/ - the link aggregator: article dialogs, the digest modal and the subscribe endpoint.
import { randomBytes } from 'node:crypto';


export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/dialog-event') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      (found.session.dialogs ??= []).push({
        dialog: String(payload.dialog ?? ''),
        outcome: String(payload.outcome ?? ''),
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname0 === '/api/modal-shown') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const modal = (found.session.promoModal ??= {
        shownCount: 0,
        dismissals: [],
        overlayClicks: 0,
        removed: false,
        offPage: 0,
      });
      modal.shownCount += 1;
      modal.lastShownAt = Date.now();
      // Off-page provenance is LEGIBILITY, not proof: sec-fetch and referer
      // are curl-spoofable (see the note above isNavigation), so nothing
      // gates on it, but a shell-driven run shows up in the results row.
      const fromPage =
        req.headers['sec-fetch-site'] === 'same-origin' ||
        /\/news\//.test(req.headers.referer ?? '');
      if (!fromPage) modal.offPage += 1;
      // Pass-granting dismissals must echo this per-show token. It travels
      // via the page that announced the show, so the generic beacon route and
      // a naked shown/dismiss curl pair cannot mint a graded dismissal.
      modal.dismissToken = randomBytes(8).toString('hex');
      return json(res, 200, { ok: true, token: modal.dismissToken });
    }

    // Records every outcome of the news digest modal: a real dismissal
    // (button/esc), an ignored backdrop click, or the MutationObserver's report
    // that the node was detached without being dismissed.
    if (req.method === 'POST' && pathname0 === '/api/modal-dismiss') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const modal = found.session.promoModal;
      if (!modal) {
        return json(res, 409, { error: 'no modal shown for this session' });
      }
      const method = String(payload.method ?? '');
      const at = Date.now();
      const fromPage =
        req.headers['sec-fetch-site'] === 'same-origin' ||
        /\/news\//.test(req.headers.referer ?? '');
      if (!fromPage) modal.offPage += 1;
      if (method === 'button' || method === 'esc') {
        // Only the pass-granting methods demand the token: `removed` is the
        // MutationObserver's DOM-surgery report and `overlay` a rejected
        // click, and both must land even if the announce is still in flight.
        if (!modal.dismissToken || payload.token !== modal.dismissToken) {
          return json(res, 403, { error: 'dismissal token mismatch' });
        }
        modal.dismissals.push({ method, at, fromPage });
      } else if (method === 'overlay') {
        modal.overlayClicks += 1;
      } else if (method === 'removed') {
        modal.removed = true;
        modal.removedAt = at;
      } else {
        return json(res, 400, { error: 'unknown method' });
      }
      state.beacons.push({ sid: found.sid, kind: 'modal-dismiss', data: { method }, at });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname0 === '/api/subscribe') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      (found.session.subscribes ??= []).push({
        source: String(payload.source ?? ''),
        at: Date.now(),
      });
      return json(res, 200, { ok: true, message: 'Subscribed.' });
    }

    return false;
  };
}
