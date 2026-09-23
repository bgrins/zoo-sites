// pages/news/ - the link aggregator: article dialogs, the digest modal, the subscribe endpoint, sign-in and registration.
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { SESSION_ROWS, pushTrimmed } from './lib.mjs';

const USERNAME = /^[a-z0-9_]{2,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  const fromNews = fromPage('/news/');
  // Every byline on the stream or in a thread, archived ones included, is a
  // taken username.
  let taken = null;
  const takenNames = async () => {
    if (taken) return taken;
    const read = async (...path) => JSON.parse(await ctx.readFile(ctx.join(ctx.root, 'news', ...path), 'utf8'));
    const threads = (await readdir(ctx.join(ctx.root, 'news', 'threads'))).filter((f) => f.endsWith('.json'));
    const docs = await Promise.all([read('items.json'), read('items2.json'), ...threads.map((f) => read('threads', f))]);
    const names = new Set();
    const walk = (list) => {
      for (const entry of list) {
        if (entry.author) names.add(entry.author);
        walk(entry.replies ?? []);
      }
    };
    for (const doc of docs) walk(Array.isArray(doc) ? doc : [doc, ...doc.comments]);
    taken = names;
    return taken;
  };
  return async (req, res, url, pathname0) => {
    // Sign-in and registration. No account on the stream can be signed into
    // from here, so a sign-in with both fields filled is always refused, and a
    // registration waits on an emailed confirmation. Both are reported, never
    // graded.
    if (req.method === 'POST' && pathname0 === '/api/news/signin') {
      const payload = await readJson(req, res);
      if (payload === undefined) return;
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const user = String(payload?.user ?? '').trim();
      if (!user || !String(payload?.pass ?? '')) {
        return json(res, 400, { ok: false, error: 'Enter both a username and a password.' });
      }
      pushTrimmed((found.session.newsSignins ??= []), { user: user.slice(0, 80), at: Date.now() });
      return json(res, 401, { ok: false, error: 'No account matches that username and password.' });
    }

    if (req.method === 'POST' && pathname0 === '/api/news/register') {
      const payload = await readJson(req, res);
      if (payload === undefined) return;
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const user = String(payload?.user ?? '').trim().toLowerCase();
      const email = String(payload?.email ?? '').trim().slice(0, 254);
      if (!USERNAME.test(user)) {
        return json(res, 422, {
          ok: false,
          error: 'Usernames are 2 to 20 characters: lowercase letters, digits and underscores.',
        });
      }
      if ((await takenNames()).has(user)) return json(res, 422, { ok: false, error: 'That username is taken.' });
      if (!EMAIL.test(email)) return json(res, 422, { ok: false, error: 'That email address is not complete.' });
      if (String(payload?.pass ?? '').length < 8) {
        return json(res, 422, { ok: false, error: 'Passwords need at least 8 characters.' });
      }
      pushTrimmed((found.session.newsRegistrations ??= []), { user, email, at: Date.now() });
      return json(res, 202, { ok: true, user, email });
    }

    // pages/news/article.html raises its three prompts on timers of their own,
    // not in answer to one another, so all three appear however the reader
    // responds to the first; the overlays stack, and closing the top one
    // uncovers the next.
    if (req.method === 'POST' && pathname0 === '/api/dialog-event') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const dialogs = (found.session.dialogs ??= []);
      if (dialogs.length >= SESSION_ROWS) return json(res, 429, { error: 'too many events' });
      dialogs.push({
        dialog: String(payload.dialog ?? ''),
        outcome: String(payload.outcome ?? ''),
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname0 === '/api/modal-shown') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
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
      // are curl-spoofable, so nothing gates on it, but a shell-driven run
      // shows up in the results row.
      const fromPage = fromNews(req);
      if (!fromPage) modal.offPage += 1;
      // Pass-granting dismissals must echo this per-show token, so the generic
      // beacon route and a dismissal replayed without reading this response
      // cannot mint a graded dismissal. Anything that does read it can: a shell
      // pair that echoes the token (legible as offPage), and script in the page,
      // which is indistinguishable from the page's own close.
      modal.dismissToken = randomBytes(8).toString('hex');
      return json(res, 200, { ok: true, token: modal.dismissToken });
    }

    // Records every outcome of the news digest modal: a real dismissal
    // (button/esc), an ignored backdrop click, or the MutationObserver's report
    // that the node was detached without being dismissed.
    if (req.method === 'POST' && pathname0 === '/api/modal-dismiss') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      // The page announces the modal before drawing it, so its own dismissal
      // never arrives ahead of the show; one that does is refused here.
      const modal = found.session.promoModal;
      if (!modal) {
        return json(res, 409, { error: 'no modal shown for this session' });
      }
      const method = String(payload.method ?? '');
      const at = Date.now();
      // Legibility, never proof: curl sets these headers freely.
      const fromPage = fromNews(req);
      if (!fromPage) modal.offPage += 1;
      if (method === 'button' || method === 'esc') {
        // Only the pass-granting methods demand the token: `removed` is the
        // MutationObserver's DOM-surgery report and `overlay` a rejected
        // click, and both must land even if the announce is still in flight.
        if (!modal.dismissToken || payload.token !== modal.dismissToken) {
          return json(res, 403, { error: 'dismissal token mismatch' });
        }
        if (modal.dismissals.length >= SESSION_ROWS) return json(res, 429, { error: 'too many events' });
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
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const subscribes = (found.session.subscribes ??= []);
      if (subscribes.length >= SESSION_ROWS) {
        return json(res, 429, { error: 'Too many sign-ups from this browser. Try again tomorrow.' });
      }
      subscribes.push({
        source: String(payload.source ?? '').slice(0, 80),
        at: Date.now(),
      });
      return json(res, 200, { ok: true, message: 'Subscribed.' });
    }

    return false;
  };
}
