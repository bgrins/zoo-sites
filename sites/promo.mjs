// pages/promo/ - overlapping offer banners (promo-zindex) and the members club sign-in.
import { randomBytes } from 'node:crypto';

const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Members club online accounts. Till-issued cards never reach this server, so
// the only account a visitor can sign in to is one they joined online in the
// same session, and the club rules allow one membership per person. The fifth
// refused sign-in pauses sign-in for the rest of the session, as members.html
// says, and later attempts are not counted.
const SIGNIN_LIMIT = 5;
const PAUSED =
  'Online sign-in is paused after five attempts that did not match. Your card still ' +
  'works at every till. To sign in again, call the help desk on 0808 157 0412.';
const clubOf = (session) => (session.promoClub ??= { account: null, failures: 0, signedIn: false });
const memberOf = (club) =>
  club.signedIn ? { first: club.account.first, card: club.account.card, points: 0 } : null;

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/promo/member') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, { member: memberOf(clubOf(found.session)) });
    }

    if (req.method === 'POST' && ['/api/promo/join', '/api/promo/signin', '/api/promo/signout'].includes(pathname0)) {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const club = clubOf(found.session);

      if (pathname0 === '/api/promo/signout') {
        club.signedIn = false;
        return json(res, 200, { ok: true });
      }

      const password = String(payload.password ?? '');
      if (pathname0 === '/api/promo/join') {
        const first = String(payload.first ?? '').trim();
        const email = String(payload.email ?? '').trim();
        if (!first || first.length > 40) return json(res, 422, { ok: false, message: 'Enter your first name.' });
        if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json(res, 422, { ok: false, message: 'Enter an email address we can send your card number to.' });
        }
        if (password.length < 8 || password.length > 128) {
          return json(res, 422, { ok: false, message: 'Choose a password of at least 8 characters.' });
        }
        if (club.account) {
          return json(res, 409, {
            ok: false,
            message: `You are already a member. Sign in with card ending ${club.account.card.slice(-4)}.`,
          });
        }
        const card = '7' + [...randomBytes(11)].map((b) => b % 10).join('');
        club.account = { first, email, card, password };
        club.signedIn = true;
        return json(res, 200, { ok: true, member: memberOf(club) });
      }

      const card = String(payload.card ?? '').replace(/[\s-]/g, '');
      if (!/^\d{12}$/.test(card)) {
        return json(res, 422, { ok: false, message: 'Enter the 12-digit number printed under the barcode on your card.' });
      }
      if (!password) return json(res, 422, { ok: false, message: 'Enter your password.' });
      if (club.failures >= SIGNIN_LIMIT) return json(res, 423, { ok: false, message: PAUSED });
      if (club.account && club.account.card === card && club.account.password === password) {
        club.signedIn = true;
        club.failures = 0;
        return json(res, 200, { ok: true, member: memberOf(club) });
      }
      club.failures += 1;
      if (club.failures >= SIGNIN_LIMIT) return json(res, 423, { ok: false, message: PAUSED });
      return json(res, 401, {
        ok: false,
        message:
          'That card number and password do not match a members club account. Check the ' +
          'number under the barcode and your password. New to the club? Join online below.',
      });
    }

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
