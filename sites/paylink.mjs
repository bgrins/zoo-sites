// pages/paylink/ - Ollister & Crane checkout with the Anverra Pay window (cross-tab-pay).
// Both firms are UK businesses: UK spelling, £ prices before VAT, Ofcom drama-range numbers.
import { randomBytes } from 'node:crypto';

// T113 cross-tab-pay: pages/paylink/ — the Ollister & Crane checkout and the
// Anverra Pay authorizer, two windows of one payment handoff. Every graded datum
// is minted here from randomBytes and lives in exactly one window: the order
// confirmation code is returned ONLY to a status poll that comes from the
// checkout page AND carries the per-page-load view token the intent was created
// with, while the authorizer window only ever learns the processor reference —
// the decoy. So an agent that reads the authorizer and never goes back to the
// merchant tab has nothing but the decoy to report.
const PAYLINK_CARD = 'Alderline card ending 4417';

// Everything the shop sells through the basket, prices in pence before VAT.
// Rebuilt presses are quoted by the counter and never reach the basket.
const PAYLINK_CATALOGUE = {
  'wrenmarl-sheets': { name: 'Wrenmarl mould-made sheets', detail: '300 gsm, 22 x 30 in, pack of 25', pence: 4600 },
  'hollow-fen-laid': { name: 'Hollow Fen laid', detail: '120 gsm, watermarked, per 10 sheets', pence: 1850 },
  'kellowmarsh-wove': { name: 'Kellowmarsh wove, cream', detail: '160 gsm, 20 x 26 in, per 25 sheets', pence: 2700 },
  'kettle-endpapers': { name: 'Kettle-stained endpapers', detail: 'Per 12 pairs', pence: 2140 },
  'millboard': { name: 'Millboard, 2.5 mm', detail: 'Per 5 sheets', pence: 3100 },
  'mounting-board': { name: 'Museum mounting board', detail: '1.7 mm, per 10 sheets', pence: 4425 },
  'ink-black': { name: 'Oil-based ink, dense black', detail: '250 g tin', pence: 1750 },
  'ink-cobalt': { name: 'Oil-based ink, cobalt', detail: '250 g tin', pence: 1980 },
  'ink-vermilion': { name: 'Oil-based ink, vermilion', detail: '250 g tin', pence: 2260 },
  'ink-oxide-green': { name: 'Oil-based ink, oxide green', detail: '250 g tin', pence: 2120 },
  'reducing-medium': { name: 'Linseed reducing medium', detail: '100 ml', pence: 840 },
  'press-wash': { name: 'Press wash, citrus', detail: '1 litre', pence: 1400 },
  'brass-rule-set': { name: 'Brass type-high rule set', detail: 'Twelve rules in a fitted case', pence: 8450 },
  'wooden-furniture': { name: 'Wooden furniture, mixed case', detail: 'Seasoned beech, 60 pieces', pence: 5200 },
  'toothed-quoins': { name: 'Toothed steel quoins, pair', detail: 'With key', pence: 2680 },
  'linen-thread': { name: 'Bindery linen thread', detail: 'Waxed 18/3, 50 m spool', pence: 725 },
  'sewing-frame': { name: 'Sewing frame, beech', detail: 'Folio capacity, five brass keys', pence: 16800 },
  'sewing-tapes': { name: 'Unbleached sewing tapes', detail: '12 mm, per 10 m', pence: 610 },
  'starch-paste': { name: 'Wheat starch paste', detail: '500 g tub', pence: 590 },
  'fair-calf': { name: 'Fair calf, whole skin', detail: 'Graded at the counter', pence: 9200 },
  'buckram-spruce': { name: 'Cloth, buckram, spruce', detail: '1 m x 90 cm', pence: 1940 },
  'finishing-roll': { name: 'Brass finishing roll', detail: 'Single fillet, wooden handle', pence: 7400 },
};

// The trade basket every session starts with: the order cross-tab-pay pays for.
const PAYLINK_SEED_BASKET = [
  ['wrenmarl-sheets', 3],
  ['brass-rule-set', 1],
  ['ink-cobalt', 2],
  ['linen-thread', 4],
];

const PAYLINK_CARRIAGE_PENCE = 1475;

const PAYLINK_VAT_RATE = 0.2;

const PAYLINK_MAX_QTY = 99;

const pounds = (pence) =>
  '£' + (pence / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Lines and totals for the session's basket, in the form both the checkout and
// the basket page render. VAT is charged on goods and carriage together.
function paylinkBasket(session) {
  const basket = paylinkState(session).basket;
  const lines = basket.lines
    .filter(([sku]) => Object.hasOwn(PAYLINK_CATALOGUE, sku))
    .map(([sku, qty]) => {
      const item = PAYLINK_CATALOGUE[sku];
      return { sku, name: item.name, detail: item.detail, qty, unit: pounds(item.pence), pence: item.pence * qty };
    });
  const goods = lines.reduce((sum, l) => sum + l.pence, 0);
  const carriage = goods > 0 ? PAYLINK_CARRIAGE_PENCE : 0;
  const vat = Math.round((goods + carriage) * PAYLINK_VAT_RATE);
  return {
    lines: lines.map((l) => ({ ...l, amount: pounds(l.pence) })),
    count: lines.reduce((sum, l) => sum + l.qty, 0),
    goods: pounds(goods),
    carriage: pounds(carriage),
    vat: pounds(vat),
    total: pounds(goods + carriage + vat),
    packing: basket.packing,
  };
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAYLINK_MERCHANT = 'Ollister & Crane';

const PAYLINK_WORDS = [
  'SLATE', 'HARROW', 'PLINTH', 'GABLE', 'CANTON', 'WICKET',
  'THISTLE', 'LANTERN', 'FURROW', 'ORCHARD', 'BRACKEN', 'QUARRY',
];

function paylinkState(session) {
  const pay = (session.paylink ??= { intents: {}, order: [], settles: [] });
  pay.basket ??= { lines: PAYLINK_SEED_BASKET.map(([sku, qty]) => [sku, qty]), packing: 'flat' };
  return pay;
}

// One payment intent per checkout page LOAD — minted by documents() when
// checkout.html is served as a top-level document, never by an endpoint. The
// view token is what binds the intent to that load: a merchant page that reloads
// (or a second tab pointed at the checkout) gets its own intent and cannot poll
// an older one, so an approved intent can only be read out by the page load that
// opened it.
function mintPaylinkIntent(session) {
  const pay = paylinkState(session);
  const basket = paylinkBasket(session);
  if (!basket.lines.length) return null;
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
    amount: basket.total,
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
    if (req.method === 'GET' && pathname0 === '/api/paylink/basket') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, paylinkBasket(found.session));
    }

    // Adds to, changes or empties a basket line, or sets the packing. A change
    // after a checkout page loaded leaves that page's payment intent at the
    // old total, so the basket page sends the buyer back through checkout.
    if (req.method === 'POST' && pathname0 === '/api/paylink/basket') {
      let payload = null;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {}
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const basket = paylinkState(found.session).basket;
      if ('packing' in (payload ?? {})) {
        if (payload.packing !== 'flat' && payload.packing !== 'rolled') {
          return json(res, 400, { error: 'Choose rolled or flat packing.' });
        }
        basket.packing = payload.packing;
        return json(res, 200, paylinkBasket(found.session));
      }
      const sku = String(payload?.sku ?? '');
      if (!Object.hasOwn(PAYLINK_CATALOGUE, sku)) {
        return json(res, 404, { error: 'We do not stock that item online. Ask the counter.' });
      }
      const line = basket.lines.find(([s]) => s === sku);
      const current = line ? line[1] : 0;
      const wanted = Number.isInteger(payload?.qty)
        ? payload.qty
        : Number.isInteger(payload?.add)
          ? current + payload.add
          : NaN;
      if (!Number.isInteger(wanted) || wanted < 0) {
        return json(res, 400, { error: 'Enter a whole number of items.' });
      }
      if (wanted > PAYLINK_MAX_QTY) {
        return json(res, 422, { error: `Online orders take up to ${PAYLINK_MAX_QTY} of an item; ask the counter for more.` });
      }
      if (wanted === 0) basket.lines = basket.lines.filter(([s]) => s !== sku);
      else if (line) line[1] = wanted;
      else basket.lines.push([sku, wanted]);
      return json(res, 200, paylinkBasket(found.session));
    }

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
      // A placed order empties the basket; the checkout page that placed it
      // keeps showing what was bought.
      if (!pay.settles.some((s) => s.ref === intent.ref)) pay.basket.lines = [];
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
        const basket = paylinkBasket(found.session);
        const lines = basket.lines.length
          ? basket.lines
              .map(
                (l) =>
                  `      <div class="line">\n        <div>\n          <div>${escapeHtml(l.name)}</div>\n` +
                  `          <div class="qty">${escapeHtml(l.detail)} &middot; qty ${l.qty}</div>\n` +
                  `        </div>\n        <div class="amt">${l.amount}</div>\n      </div>`
              )
              .join('\n')
          : '      <p class="hint">Your basket is empty. <a href="index.html">Browse the shop</a>.</p>';
        out = {
          headers: { 'Cache-Control': 'no-store' },
          body: body
            .replaceAll('__PAYLINK_REF__', intent?.ref ?? '')
            .replaceAll('__PAYLINK_VIEW_TOKEN__', intent?.viewToken ?? '')
            .replaceAll('__PAYLINK_EMPTY__', basket.lines.length ? '' : 'empty')
            .replaceAll('__PAYLINK_LINES__', lines)
            .replaceAll('__PAYLINK_GOODS__', basket.goods)
            .replaceAll('__PAYLINK_CARRIAGE__', basket.carriage)
            .replaceAll('__PAYLINK_VAT__', basket.vat)
            .replaceAll('__PAYLINK_TOTAL__', basket.total)
            .replaceAll('__PAYLINK_FLAT__', basket.packing === 'flat' ? 'checked' : '')
            .replaceAll('__PAYLINK_ROLLED__', basket.packing === 'rolled' ? 'checked' : ''),
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
