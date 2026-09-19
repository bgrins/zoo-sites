// pages/paylink/ - Ollister & Crane checkout with the Anverra Pay window (cross-tab-pay).
import { randomBytes } from 'node:crypto';

// T113 cross-tab-pay: pages/paylink/ — the Ollister & Crane checkout and the
// Anverra Pay authorizer, two windows of one payment handoff. Every graded datum
// is minted here from randomBytes and lives in exactly one window: the order
// confirmation code is returned ONLY to a status poll that comes from the
// checkout page AND carries the per-page-load view token the intent was created
// with, while the authorizer window only ever learns the processor reference —
// the decoy. So an agent that reads the authorizer and never goes back to the
// merchant tab has nothing but the decoy to report.
const PAYLINK_AMOUNT = '$329.14';

const PAYLINK_CARD = 'Alderline card ending 4417';

const PAYLINK_MERCHANT = 'Ollister & Crane';

const PAYLINK_WORDS = [
  'SLATE', 'HARROW', 'PLINTH', 'GABLE', 'CANTON', 'WICKET',
  'THISTLE', 'LANTERN', 'FURROW', 'ORCHARD', 'BRACKEN', 'QUARRY',
];

function paylinkState(session) {
  return (session.paylink ??= { intents: {}, order: [], settles: [] });
}

// One payment intent per checkout page LOAD — minted by documents() when
// checkout.html is served as a top-level document, never by an endpoint. The
// view token is what binds the intent to that load: a merchant page that reloads
// (or a second tab pointed at the checkout) gets its own intent and cannot poll
// an older one, so an approved intent can only be read out by the page load that
// opened it.
function mintPaylinkIntent(session) {
  const pay = paylinkState(session);
  const word =
    PAYLINK_WORDS[randomBytes(1)[0] % PAYLINK_WORDS.length] +
    '-' +
    (10 + (randomBytes(1)[0] % 90));
  const intent = {
    ref: 'PI-' + randomBytes(4).toString('hex').toUpperCase(),
    viewToken: randomBytes(16).toString('hex'),
    word,
    code: 'OC-' + randomBytes(3).toString('hex').toUpperCase(),
    processorRef: 'AVP-' + (10000000 + (randomBytes(4).readUInt32BE(0) % 90000000)),
    amount: PAYLINK_AMOUNT,
    card: PAYLINK_CARD,
    opens: 0,
    openedInWindow: false,
    openedAt: null,
    // Merchant-side status polls that arrived while the authorizer window was
    // open and not yet approved. A real second tab keeps polling throughout
    // (throttled to ~0.75/s in the background); a bfcache-frozen page or a
    // scripted one-tab rig posts none. Reported, not gated.
    pollsWhileOpen: 0,
    attempts: [],
    approved: false,
    approvedAt: null,
    codeReads: 0,
    createdAt: Date.now(),
  };
  pay.intents[intent.ref] = intent;
  pay.order.push(intent.ref);
  return intent;
}

export function routes(ctx) {
  const { json, readBody, requireSession, refererPath } = ctx;
  // Which of the two pages a fetch() came from. This is NOT a security boundary:
  // fetch()'s `referrer` init member accepts any same-origin URL, so page script in
  // either window can claim to be the other one (measured in Firefox, not assumed),
  // and `curl -e` sets Referer freely like every other Referer gate in this file.
  // What actually keeps the two halves apart is the view token, which is minted
  // into the checkout document body by documents() and therefore only ever
  // reaches a real top-level load of checkout.html. The Referer test stays as the
  // ordinary "which page is calling" routing it looks like, and the settle record
  // keeps the request's Sec-Fetch-Site and User-Agent for the validator to report.
  // refererPath() puts the Referer in /paylink/ form, which in origin mode it
  // does not arrive in.
  const paylinkFrom = (req, file) => refererPath(req) === `/paylink/${file}`;
  return async (req, res, url, pathname0) => {
    // T113 cross-tab-pay: the merchant tab's poll. The verification word appears
    // only after the authorizer has been opened as its own window (stamped by
    // documents() below), and the confirmation code only after the approval, so
    // both graded strings exist for this session only once the handoff really
    // happened. The gate that matters is the intent's view token, which
    // documents() mints into a top-level checkout document and nowhere else —
    // the authorizer window has no way to obtain one. There is deliberately no
    // endpoint that hands a view token out: fetch({referrer}) would let the
    // authorizer window claim a checkout Referer and mint itself one.
    if (req.method === 'POST' && pathname0 === '/api/paylink/status') {
      let payload = null;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {}
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (!paylinkFrom(req, 'checkout.html')) {
        return json(res, 403, { error: 'This status belongs to the checkout page.' });
      }
      const intents = found.session.paylink?.intents;
      const intent =
        intents && Object.hasOwn(intents, String(payload?.ref ?? '')) ? intents[payload.ref] : null;
      if (!intent || intent.viewToken !== payload?.viewToken) {
        return json(res, 409, { error: 'This checkout session is no longer current.' });
      }
      if (intent.approved) {
        intent.codeReads += 1;
        return json(res, 200, { state: 'approved', code: intent.code });
      }
      // An approval that landed on a DIFFERENT intent of this session: the agent
      // reloaded the merchant tab while an authorizer window for the previous
      // intent was still open, approved that one, and would otherwise sit here
      // forever with no code and no explanation. Say so instead.
      const superseded = Object.values(found.session.paylink.intents).some(
        (other) => other !== intent && other.approved
      );
      if (intent.openedInWindow) {
        intent.pollsWhileOpen += 1;
        return json(res, 200, { state: 'awaiting-word', word: intent.word, superseded });
      }
      return json(res, 200, { state: 'awaiting-open', superseded });
    }

    // What the authorizer window renders: amount, merchant, card, and whether it
    // was opened as a real window. It never learns the verification word or the
    // confirmation code, and the processor reference it shows on completion is a
    // different string from the merchant's code.
    if (req.method === 'POST' && pathname0 === '/api/paylink/authorizer-view') {
      let payload = null;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {}
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (!paylinkFrom(req, 'authorize.html')) {
        return json(res, 403, { error: 'Open this authorisation from the merchant.' });
      }
      const intents = found.session.paylink?.intents;
      const intent =
        intents && Object.hasOwn(intents, String(payload?.ref ?? '')) ? intents[payload.ref] : null;
      if (!intent) {
        return json(res, 404, { error: 'This payment request is no longer open.' });
      }
      return json(res, 200, {
        ref: intent.ref,
        amount: intent.amount,
        card: intent.card,
        merchant: PAYLINK_MERCHANT,
        openedInWindow: intent.openedInWindow,
        approved: intent.approved,
        processorRef: intent.approved ? intent.processorRef : null,
      });
    }

    // The approval, which can only be posted from the authorizer window and only
    // for an intent that was opened as a window, carrying the word the merchant
    // tab is displaying. A wrong word is a plain decline that can be retried, so
    // a misread costs turns rather than the task.
    if (req.method === 'POST' && pathname0 === '/api/paylink/approve') {
      let payload = null;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {}
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (!paylinkFrom(req, 'authorize.html')) {
        return json(res, 403, { error: 'Approve in the Anverra Pay window.' });
      }
      const intents = found.session.paylink?.intents;
      const intent =
        intents && Object.hasOwn(intents, String(payload?.ref ?? '')) ? intents[payload.ref] : null;
      if (!intent) {
        return json(res, 404, { error: 'This payment request is no longer open.' });
      }
      if (!intent.openedInWindow) {
        return json(res, 409, { error: 'Open this authorisation in its own window first.' });
      }
      const raw = String(payload?.word ?? '');
      const normalize = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const ok = normalize(raw) !== '' && normalize(raw) === normalize(intent.word);
      intent.attempts.push({ word: raw.slice(0, 40), ok, at: Date.now() });
      if (!normalize(raw)) {
        return json(res, 400, { error: 'Enter the verification word from the merchant page.' });
      }
      if (!ok) {
        return json(res, 400, {
          error: 'That verification word does not match. Check the merchant page.',
        });
      }
      if (!intent.approved) {
        intent.approved = true;
        intent.approvedAt = Date.now();
      }
      return json(res, 200, { ok: true, processorRef: intent.processorRef });
    }

    // The graded record: the merchant page confirms it rendered the code it was
    // handed, for an intent that really was approved. Per-session, so
    // state.reset() clears it, and it is the only paylink fact the validator
    // trusts — /api/beacon takes an arbitrary kind and would be forgeable. One
    // record per placed order, so a second order in the same session leaves
    // the first order's code standing.
    if (req.method === 'POST' && pathname0 === '/api/paylink/settle') {
      let payload = null;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {}
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (!paylinkFrom(req, 'checkout.html')) {
        return json(res, 403, { error: 'The order is placed from the checkout page.' });
      }
      const pay = found.session.paylink;
      const intent =
        pay?.intents && Object.hasOwn(pay.intents, String(payload?.ref ?? ''))
          ? pay.intents[payload.ref]
          : null;
      if (!intent || intent.viewToken !== payload?.viewToken) {
        return json(res, 409, { error: 'This checkout session is no longer current.' });
      }
      if (!intent.approved) {
        return json(res, 409, { error: 'The payment is not authorised yet.' });
      }
      if (String(payload?.code ?? '') !== intent.code) {
        return json(res, 400, { error: 'That code was not issued for this order.' });
      }
      (pay.settles ??= []).push({
        ref: intent.ref,
        code: intent.code,
        word: intent.word,
        processorRef: intent.processorRef,
        attempts: intent.attempts.length,
        opens: intent.opens,
        codeReads: intent.codeReads,
        pollsWhileOpen: intent.pollsWhileOpen,
        // Provenance hints for the results row, not gates: a page fetch() sends
        // Sec-Fetch-Site and a browser User-Agent, a bare curl replay sends
        // neither unless it is told to.
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        ua: req.headers['user-agent'] ?? '',
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }

    return false;
  };
}

export function documents() {
  return {
    prefix: '/paylink/',

    onHtml({ url, pathname, found, nav, body }) {
      // T113 cross-tab-pay: the payment intent for a checkout page load is
      // minted HERE and its ref and view token are substituted into the body,
      // like the __SESSION_NONCE__ substitution the static handler makes on
      // every page. There is no endpoint that hands a view token out, because
      // there could not be a safe one: fetch()'s `referrer` init member lets
      // page script claim any same-origin Referer, so a "mint from the checkout
      // page" endpoint would let the authorizer window bootstrap the merchant
      // half of the flow in a single tab. Sec-Fetch-Dest is a forbidden header
      // name, so only a real navigation to checkout.html learns a view token —
      // a fetch() of the same URL gets a body with the placeholders blanked.
      // Framed navigations count, like the other framed nav stamps, so the
      // preview contact sheet still renders a live checkout; a frame only
      // ever mints its OWN intent, and that intent still needs a top-level
      // authorizer load before anything can be approved. `no-store` keeps a
      // back-navigation or an HTTP cache from re-serving one body — and so one
      // view token — to two page loads.
      let out;
      if (body.includes('__PAYLINK_REF__')) {
        const intent = nav.document || nav.framed ? mintPaylinkIntent(found.session) : null;
        out = {
          headers: { 'Cache-Control': 'no-store' },
          body: body
            .replaceAll('__PAYLINK_REF__', intent?.ref ?? '')
            .replaceAll('__PAYLINK_VIEW_TOKEN__', intent?.viewToken ?? ''),
        };
      }

      // The Anverra Pay authorizer counts as "opened" only when it is loaded as
      // a top-level document naming a payment intent. An iframe load
      // (Sec-Fetch-Dest: iframe) and a fetch() of the same URL do not qualify,
      // so a one-tab rig that embeds the authorizer instead of opening it can
      // neither unlock the merchant's verification word nor approve. Stamping
      // this from /api/paylink/authorizer-view instead would let a single
      // fetch() claim a window that never existed.
      if (pathname === '/paylink/authorize.html' && nav.document) {
        const intents = found.session.paylink?.intents;
        const ref = url.searchParams.get('ref') ?? '';
        const intent = intents && Object.hasOwn(intents, ref) ? intents[ref] : null;
        if (intent) {
          intent.opens += 1;
          intent.openedInWindow = true;
          intent.openedAt ??= Date.now();
        }
      }
      return out;
    },
  };
}
