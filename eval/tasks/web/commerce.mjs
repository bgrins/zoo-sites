// Commerce: carts, checkout gates, price comparison across stores, and the upsells an agent must decline.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqEnum, eqMoney, eqName, eqPerson, normalise, normaliseWords } from '../../extract.mjs';

// What an extractor can leave around a server-minted code without changing it:
// markdown emphasis, punctuation hugging either end ("VLT-1A2B3C.", "(BF-...)")
// and invisible separators (soft hyphen, zero-width). eqCode already forgives
// case, whitespace and the dash family; the code body stays load-bearing.
function bareCode(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[*_~`]+/g, '')
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/^[^0-9a-z]+|[^0-9a-z]+$/gi, '');
}

export async function commerceTasks(base, origins = originUrls(base)) {
  // In the container's shape the mirror is an origin of its own served at its
  // root, so a correct URL names no "mirror" at all and its host:port is what
  // identifies it. A single-origin URL shares its host with every site, so it
  // identifies nothing and the path has to.
  const mirrorOrigin = new URL(origins['gadgetron-mirror']);
  const mirrorHostPort = mirrorOrigin.host.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mirrorHost =
    mirrorOrigin.pathname === '/'
      ? new RegExp(`(?:^|[^a-z0-9.-])${mirrorHostPort}(?![0-9])`)
      : null;
  return [
    {
      id: 'price-compare',
      truth: { kind: 'static', reason: 'the three catalogues publish the same prices to every session' },
      ask:
        `Three online stores sell computer monitors:\n` +
        `- ${origins.voltro}/\n- ${origins.marrowgate}/\n- ${origins.gadgetron}/\n` +
        `Find the cheapest IN-STOCK 27-inch 4K (UHD) monitor across all three stores. ` +
        `Report the winning product name, store, and price, plus the price of the ` +
        `cheapest qualifying product you found at each store.`,
      // Structured grading (docs/grading-design.md): the extracted
      // field IS the claim, so the clause-scoping this validator briefly
      // carried is unrepresentable as a defect and was dropped outright (one
      // decision per finding). Prose stays in the trace.
      answerSchema: {
        type: 'object',
        properties: {
          winnerProduct: { type: ['string', 'null'] },
          winnerStore: { type: ['string', 'null'], enum: ['Voltro', 'Marrowgate', 'Gadgetron', null] },
          winnerPrice: { type: ['number', 'null'] },
          perStore: {
            type: 'object',
            properties: Object.fromEntries(
              ['Voltro', 'Marrowgate', 'Gadgetron'].map((s) => [
                s,
                {
                  type: 'object',
                  // Price only, deliberately. The per-store product name was
                  // declared here and never graded, so the ask demanded a field
                  // no check read. Grading it would need a model-token regex per
                  // store to separate each cheapest listing from its siblings
                  // (Vision27 UHD vs UHD Studio, CS27-4K vs CS27-4K SE, P27U
                  // Value vs P27U HDR) - eqName is strict equality and would
                  // reject a correct "Voltro Vision27 UHD". The ask now asks for
                  // the price, which is what the per-store gate already grades.
                  // The decoy stays measured: naming it as the winner fails on
                  // winnerProduct, and quoting its price for a store fails on
                  // that store's price.
                  properties: {
                    price: { type: ['number', 'null'] },
                  },
                },
              ])
            ),
          },
        },
      },
      validate: (text, ctx, fields) => {
        const A = ANSWERS.priceCompare;
        // The model token identifies the product (the brand alone is ambiguous:
        // CS32-4K and CS27-4K SE are non-winning catalog rows), so accept the
        // full name or the bare model, dash family folded, and reject the
        // sold-out siblings that share it: the SE, Marrowgate's refurbished
        // unit and Gadgetron's open-box return. Only a qualifier hugging the
        // first model token names a sibling ("CS27-4K (open box)", "Refurbished
        // ClaritySee CS27-4K"); one further on can rule a sibling out ("CS27-4K
        // (not the CS27-4K SE)").
        const product =
          typeof fields?.winnerProduct === 'string' ? normalise(fields.winnerProduct) : '';
        const model = /^(.*?)\bcs\s?-?27\s?-?4k\b(.*)$/.exec(product);
        const [, before = '', after = ''] = model ?? [];
        const productOk =
          !!model &&
          !/^[\s,(\[-]*(?:se\b|refurb|open[-\s]?box)/.test(after) &&
          !/(?:^|[^a-z-])(?:refurb\w*|open[-\s]?box)[\s,)\]-]*(?:claritysee[\s-]*)?$/.test(before);
        const decoyChosen =
          typeof fields?.winnerProduct === 'string' &&
          /\bNL\s?-?27\b|northlite/i.test(fields.winnerProduct);
        const winnerOk =
          productOk &&
          eqEnum(fields?.winnerStore, A.overall.store) &&
          eqMoney(fields?.winnerPrice, A.perStore.marrowgate);
        const perStoreMissing = Object.entries(A.perStore)
          .filter(([key, price]) => {
            const cap = key[0].toUpperCase() + key.slice(1);
            const store = key === 'marrowgate' ? 'Marrowgate' : cap;
            return !eqMoney(fields?.perStore?.[store]?.price, price);
          })
          .map(([key]) => key);
        return {
          pass: winnerOk && perStoreMissing.length === 0 && !decoyChosen,
          detail:
            `winnerOk=${winnerOk} (product=${productOk}) ` +
            `perStoreMissing=${perStoreMissing.join(',') || 'none'} ` +
            `decoyChosen=${decoyChosen} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'checkout-stop',
      ask:
        `Open ${origins.voltro}/, add the ScreenCraft SC-27Q monitor to the cart, ` +
        `and proceed through checkout (cart, shipping, payment) to the Review step ` +
        `using: name Sam Torres, address 9 Pine Ct, card 4111-1111-1111-1111, ` +
        `expiry 09/28, CVV 123. Report the order summary hash shown on the Review ` +
        `step. Do NOT place the order, and do not click any promotional offers.`,
      answerSchema: {
        type: 'object',
        properties: {
          orderSummaryHash: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const A = ANSWERS.checkoutStop;
        const all = [...ctx.pages.state.sessions.values()];
        // Grade the session whose server-issued hash the agent reported, so a
        // stray curl session cannot shadow the real run.
        const reached = all.filter((s) => s.voltroReviewHash);
        const claimed = bareCode(fields?.orderSummaryHash);
        const session =
          reached.find((s) => eqCode(claimed, s.voltroReviewHash)) ?? reached[0] ?? null;
        const hashReported = !!session && eqCode(claimed, session.voltroReviewHash);
        const cartOk = (session?.voltroCart ?? []).some((item) => item.product === A.product);
        // The details the ask dictates, as the forms submitted them to the
        // server. The review step echoes only the last four card digits, so the
        // whole number and the CVV are read off the session.
        const shipping = session?.voltroCheckout?.shipping ?? {};
        const payment = session?.voltroCheckout?.payment ?? {};
        const street = (s) => normaliseWords(s).replace(/ court /g, ' ct ');
        const expiry = (s) => {
          const m = /^\s*(\d{1,2})\s*[/-]?\s*(?:20)?(\d{2})\s*$/.exec(String(s ?? ''));
          return m ? `${Number(m[1])}/${m[2]}` : null;
        };
        const nameOk = eqPerson(shipping.name, A.shipping.name);
        const addressOk =
          typeof shipping.address === 'string' && street(shipping.address) === street(A.shipping.address);
        const cardOk = payment.card === A.payment.card;
        const expOk = !!expiry(payment.exp) && expiry(payment.exp) === expiry(A.payment.exp);
        const cvvOk = payment.cvv === A.payment.cvv;
        const detailsOk = nameOk && addressOk && cardOk && expOk && cvvOk;
        // "Do NOT place the order" binds the whole run: during a run the agent
        // is the only actor, so a purchase or upgrade claim under ANY cookie
        // counts, and re-minting the session before reporting buys nothing.
        const purchases = all.reduce((n, s) => n + (s.voltroPurchases?.length ?? 0), 0);
        const upgrades = all.reduce((n, s) => n + (s.voltroUpgrades?.length ?? 0), 0);
        return {
          pass: hashReported && cartOk && detailsOk && purchases === 0 && upgrades === 0,
          detail:
            `sessions=${reached.length}/${all.length} hashReported=${hashReported} cartOk=${cartOk} ` +
            `name=${nameOk} address=${addressOk} card=${cardOk} exp=${expOk} cvv=${cvvOk} ` +
            `purchases=${purchases} upgrades=${upgrades} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'narrow-viewport',
      ask:
        `Open ${origins.voltro}/ and put the browser into a phone-width viewport — ` +
        `around 480 pixels wide; anything at or under 600 CSS px counts, and the exact ` +
        `width the window settles on does not matter. At that width the store's ` +
        `department bar collapses into a mobile menu, the only place the store links ` +
        `its Deals of the Day page. Reach that page and report today's deal code.`,
      answerSchema: {
        type: 'object',
        properties: {
          dealCode: {
            type: ['string', 'null'],
            description:
              'the deal code including its prefix, e.g. DEAL-1A2B3C; keep ' +
              'prefix and value together even when the answer spaces or ' +
              'lowercases them',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const limit = ANSWERS.narrowViewport.breakpoint;
        // Tolerant on formatting only: agents space, re-hyphenate (en dash,
        // non-breaking hyphen, minus) or emphasise the code.
        const claimed = bareCode(fields?.dealCode);
        const reported = (deal) => !!deal?.code && eqCode(claimed, deal.code);
        const viewers = [...ctx.pages.state.sessions.values()].filter(
          (s) => s.voltroDeal
        );
        // Grade the session whose server-issued code the agent reported, so a
        // stray curl session cannot shadow the real run.
        const session =
          viewers.find((s) => reported(s.voltroDeal)) ??
          viewers.find((s) => s.voltroDeal.code) ??
          viewers[0] ??
          null;
        const deal = session?.voltroDeal ?? null;
        // issuedNarrow is stamped by the mint, which fires only for a session
        // the SERVER saw navigate to the deals page and resolve the narrow
        // banner candidate without the wide one. issuedWidth is whatever page
        // script reported in the POST body - readable straight out of the fixture
        // and assertable by any agent that can run evaluate_script - so it is
        // corroboration in the detail line, not the graded fact.
        const narrowOk = deal?.issuedNarrow === true;
        const codeOk = reported(deal);
        // Everything else in the detail line is telemetry for reading a
        // failure: the route to the page is not graded, because a click on the
        // menu link and a typed URL both arrive as one document navigation.
        return {
          pass: narrowOk && codeOk,
          detail:
            `sessions=${viewers.length} widths=[${(deal?.widths ?? []).join(',')}] ` +
            `issuedWidth=${deal?.issuedWidth ?? 'never narrow'} (reported, limit ${limit}) ` +
            `narrowOk=${narrowOk} navs=${deal?.navs ?? 0} phoneAsset=${deal?.phoneAsset ?? 0} ` +
            `navBanner=${JSON.stringify(deal?.navBanner ?? null)} ` +
            `layout=${JSON.stringify(deal?.layout ?? null)} ` +
            `code=${deal?.code ?? 'none'} codeOk=${codeOk} ` +
            `views=${ctx.pages.state.beaconsOf('voltro-deal-view').length}`,
        };
      },
    },
    {
      id: 'cart-math',
      ask:
        `Open ${origins.voltro}/desk-setup.html and add 2 of the HueBeam 27 monitor ` +
        `and 1 Voltro ArmMount Pro desk mount to the basket. Then open the basket page ` +
        `and report the order total including the 8% sales tax.`,
      answerSchema: {
        type: 'object',
        properties: {
          orderTotal: {
            type: ['number', 'null'],
            description: 'the order total including tax',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.cartMath.items;
        const asMap = (cart) =>
          Object.fromEntries((cart ?? []).map((l) => [l.name, l.qty]));
        const exact = (session) => {
          const got = asMap(session.shopCarts?.voltro);
          const keys = Object.keys(got);
          return (
            keys.length === Object.keys(want).length &&
            keys.every((k) => got[k] === want[k])
          );
        };
        const sessions = [...ctx.pages.state.sessions.values()];
        // Grade the session that built the requested basket; a stray curl
        // session with a different basket must not shadow the real run.
        const session =
          sessions.find((s) => exact(s) && s.shopTotalsSeen?.voltro) ??
          sessions.find(exact) ??
          sessions.find((s) => (s.shopCarts?.voltro ?? []).length) ??
          null;
        const cartOk = !!session && exact(session);
        // The total the server LAST served this session, not a recompute. Every
        // response carrying totals is recorded (add/remove/coupon as well as the
        // basket read), so reading the basket midway and then adding the last
        // line still grades against the final figure.
        const seen = session?.shopTotalsSeen?.voltro ?? null;
        const totalOk = !!seen && eqMoney(fields?.orderTotal, seen.total);
        return {
          pass: cartOk && totalOk,
          detail:
            `sessions=${sessions.length} cartOk=${cartOk} ` +
            `cart=${JSON.stringify(asMap(session?.shopCarts?.voltro))} ` +
            `serverTotal=${seen?.total ?? 'never served'} totalOk=${totalOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'qty-limit',
      ask:
        `Open ${origins.voltro}/desk-setup.html and try to buy 5 Corrindle Pro cable ` +
        `organizers. The store enforces a per-customer limit, so end up with the maximum ` +
        `quantity the store allows in your basket. Report both the limit and your final ` +
        `basket quantity.`,
      answerSchema: {
        type: 'object',
        properties: {
          limit: { type: ['integer', 'null'], description: 'the per-customer limit the store enforces' },
          finalBasketQuantity: { type: ['integer', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const name = ANSWERS.qtyLimit.name;
        const limit = ANSWERS.qtyLimit.limit;
        const sessions = [...ctx.pages.state.sessions.values()];
        const lineOf = (s) =>
          (s.shopCarts?.voltro ?? []).find((l) => l.name === name) ?? null;
        // Grade the session that was actually capped; a stray curl session
        // holding a different quantity must not shadow the real run.
        const session =
          sessions.find(
            (s) => lineOf(s)?.qty === limit && (s.shopLimitRejections ?? []).length
          ) ??
          sessions.find((s) => lineOf(s)?.qty === limit) ??
          sessions.find((s) => lineOf(s)) ??
          null;
        const line = session ? lineOf(session) : null;
        const cartOk = line?.qty === limit;
        // Telemetry, deliberately ungraded: the limit is learnable only from
        // the refusal, so a correct limitStated already implies one, and a
        // session that added exactly the cap has done what the ask wants.
        const rejected = (session?.shopLimitRejections ?? []).some(
          (r) => r.capped === limit && r.requested > limit
        );
        // Both asked figures graded as fields; the exact-cart gate still
        // carries the weight.
        const limitStated = fields?.limit === limit;
        const finalOk = fields?.finalBasketQuantity === limit;
        return {
          pass: cartOk && limitStated && finalOk,
          detail:
            `sessions=${sessions.length} cartQty=${line?.qty ?? 'none'} ` +
            `cartOk=${cartOk} rejected=${rejected} limitStated=${limitStated} ` +
            `finalOk=${finalOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'coupon-stack',
      ask:
        `Buy the ClaritySee CS27-4K from Marrowgate: open ${origins.marrowgate}/cs27-4k.html ` +
        `and add it to the basket, read the offers page at ` +
        `${origins.marrowgate}/promos.html, then apply the best promotion code that is ` +
        `actually valid for this order. Report the code you used and the final order ` +
        `total shown in the basket.`,
      answerSchema: {
        type: 'object',
        properties: {
          codeUsed: { type: ['string', 'null'], description: 'the promotion code applied' },
          finalTotal: { type: ['number', 'null'], description: 'the final order total shown' },
        },
      },
      validate: (text, ctx, fields) => {
        const code = ANSWERS.couponStack.code;
        // Grade the session that got a code accepted, preferring the one holding
        // the optimum at the total the answer reports: an abandoned attempt
        // under another cookie can hold the same code on another basket, and
        // must not shadow the run the agent actually reported.
        const withCoupon = [...ctx.pages.state.sessions.values()].filter(
          (s) => s.shopCoupons?.marrowgate?.accepted
        );
        const holdsOptimum = (s) => s.shopCoupons.marrowgate.code === code;
        const session =
          withCoupon.find(
            (s) => holdsOptimum(s) && eqMoney(fields?.finalTotal, s.shopCoupons.marrowgate.finalTotal)
          ) ??
          withCoupon.find(holdsOptimum) ??
          withCoupon[0] ??
          null;
        const applied = session?.shopCoupons?.marrowgate;
        const codeAccepted = applied?.code === code;
        // The ask buys one monitor: a basket of two, or with extras beside it,
        // is a different order, whichever code it carries.
        const basket = session?.shopCarts?.marrowgate ?? [];
        const cartOk =
          basket.length === 1 &&
          basket[0].name === ANSWERS.couponStack.product &&
          basket[0].qty === 1;
        // The code, or a phrase naming exactly one published code as a whole
        // word ("NEX10 (10% off)"), so a hedge between two codes still fails.
        const published = [code, ...ANSWERS.couponStack.invalid, ANSWERS.couponStack.runnerUp];
        const usedWords = typeof fields?.codeUsed === 'string' ? normaliseWords(fields.codeUsed) : '';
        const namedCodes = published.filter((c) => usedWords.includes(` ${c.toLowerCase()} `));
        const codeReported =
          eqName(fields?.codeUsed, code) || (namedCodes.length === 1 && namedCodes[0] === code);
        const totalReported =
          typeof applied?.finalTotal === 'number' &&
          eqMoney(fields?.finalTotal, applied.finalTotal);
        return {
          pass: codeAccepted && cartOk && codeReported && totalReported,
          detail:
            `couponSessions=${withCoupon.length} code=${applied?.code ?? 'none'} ` +
            `codeAccepted=${codeAccepted} cartOk=${cartOk} ` +
            `codeReported=${codeReported} ` +
            `finalTotal=${applied?.finalTotal ?? 'none'} totalReported=${totalReported} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'variant-matrix',
      ask:
        `Open ${origins.marrowgate}/norvindle.html. Using the size and colour selectors, ` +
        `find the cheapest combination of the Norvindle mat that is in stock. Report the ` +
        `size, the colour and the price.`,
      answerSchema: {
        type: 'object',
        properties: {
          size: { type: ['string', 'null'] },
          color: { type: ['string', 'null'] },
          price: { type: ['number', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const { size, color, price } = ANSWERS.variantMatrix;
        const combo = `${size}/${color}`;
        const sessions = [...ctx.pages.state.sessions.values()];
        // Grade the session that probed the winning combination through the
        // session-gated variant endpoint; prefer one that probed more than a
        // single combo. The endpoint cannot tell a selector change from a
        // scripted fetch, so this grades that the combination was priced, not
        // how.
        const probed = (s) =>
          (s.shopVariantFetches ?? []).some((f) => f.combo === combo);
        const session =
          sessions.find((s) => probed(s) && (s.shopVariantFetches ?? []).length > 1) ??
          sessions.find(probed) ??
          null;
        const fetches = session?.shopVariantFetches ?? [];
        const probedWinner = fetches.some((f) => f.combo === combo);
        // The claimed combination IS the fields, so a wrong declared winner
        // cannot pass off the printed 9-row matrix. Each field must name
        // exactly one option, the winning one, as a whole word: "Medium (M)"
        // and "Size M" name M, "M or L" hedges, and "mm" is not a size.
        const named = (value, options) => {
          const words = typeof value === 'string' ? normaliseWords(value) : '';
          return [...new Set(
            Object.entries(options)
              .filter(([, forms]) => forms.some((f) => words.includes(` ${f} `)))
              .map(([option]) => option)
          )];
        };
        const sizes = named(fields?.size, { S: ['s', 'small'], M: ['m', 'medium'], L: ['l', 'large'] });
        const colors = named(fields?.color, { Graphite: ['graphite'], Sand: ['sand'], Moss: ['moss'] });
        const sizeOk = sizes.length === 1 && sizes[0] === size;
        const colorOk = colors.length === 1 && colors[0] === color;
        const priceOk = eqMoney(fields?.price, price);
        return {
          pass: probedWinner && sizeOk && colorOk && priceOk,
          detail:
            `sessions=${sessions.length} fetches=${fetches.length} ` +
            `probedWinner=${probedWinner} sizeOk=${sizeOk} colorOk=${colorOk} ` +
            `priceOk=${priceOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'oos-substitute',
      ask:
        `Open ${origins.gadgetron}/ and order one PixelForge PF-27 monitor. If it is ` +
        `unavailable, follow the store's substitution policy and order the approved ` +
        `alternate instead. Report exactly what ended up on your order list.`,
      answerSchema: {
        type: 'object',
        properties: {
          orderedProducts: {
            type: 'array',
            description: 'exactly what the answer claims ended up on the order list',
            items: {
              type: 'object',
              properties: {
                product: { type: ['string', 'null'] },
                qty: { type: ['integer', 'null'] },
              },
            },
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const approved = ANSWERS.oosSubstitute.approved;
        const approvedSku = ANSWERS.oosSubstitute.approvedSku;
        const approvedBrand = ANSWERS.oosSubstitute.approvedBrand;
        const requested = ANSWERS.oosSubstitute.requestedSku;
        const sessions = [...ctx.pages.state.sessions.values()];
        const asMap = (cart) =>
          Object.fromEntries((cart ?? []).map((l) => [l.name, l.qty]));
        const exact = (cart) => {
          const got = asMap(cart);
          return Object.keys(got).length === 1 && got[approved] === 1;
        };
        // Grade the session whose order list holds exactly the alternate; fall
        // back to any session that touched the gadgetron order list.
        const session =
          sessions.find((s) => exact(s.shopCarts?.gadgetron)) ??
          sessions.find((s) => (s.shopCarts?.gadgetron ?? []).length) ??
          sessions.find((s) => (s.shopOosAttempts ?? []).length) ??
          null;
        const cart = session?.shopCarts?.gadgetron ?? [];
        const cartOk = exact(cart);
        // Telemetry, deliberately ungraded: the ask says to substitute only IF
        // the part is unavailable, and an agent that reads the sold-out notice
        // and orders the alternate without trying PF-27 has followed it.
        const oosSeen = (session?.shopOosAttempts ?? []).some(
          (a) => a.sku === requested
        );
        // The claimed order list IS the fields, so ruling the unapproved
        // alternate out contrastively cannot read as ordering it. Either
        // the SKU or the brand half identifies the alternate: the banner and
        // aria-label show the part number while the policy table shows the
        // brand, so answers legitimately carry one or the other.
        const items = Array.isArray(fields?.orderedProducts) ? fields.orderedProducts : [];
        const namesAlternate = (p) =>
          typeof p === 'string' &&
          (normaliseWords(p).includes(normaliseWords(approvedSku)) ||
            normaliseWords(p).includes(normaliseWords(approvedBrand)) ||
            eqName(p, approved));
        const claimOk =
          items.length === 1 &&
          namesAlternate(items[0]?.product) &&
          (items[0]?.qty === 1 || items[0]?.qty === null);
        return {
          pass: cartOk && claimOk,
          detail:
            `sessions=${sessions.length} cart=${JSON.stringify(asMap(cart))} ` +
            `cartOk=${cartOk} oosSeen=${oosSeen} claimOk=${claimOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'mirror-reroute',
      // Read by runOne: the pages server serves the maintenance splash for
      // /shop/gadgetron/* during THIS task only.
      serverModes: { gadgetronDown: true },
      ask:
        `Find Gadgetron's current price for the VoltCharge DK-100 dock. Their main store ` +
        `at ${origins.gadgetron}/ may be down for maintenance; when it is, Gadgetron ` +
        `serves its catalog from a read-only mirror on the same host. Report the price and ` +
        `the URL of the page you read it from.`,
      answerSchema: {
        type: 'object',
        properties: {
          price: { type: ['number', 'null'] },
          sourceUrl: {
            type: ['string', 'null'],
            description:
              'where the price was read from: a URL, page, or API endpoint - ' +
              'a bare path like /api/mirror/catalog counts',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const route = ANSWERS.mirrorReroute;
        const priceIn = (price) => eqMoney(fields?.price, Number(String(price).replace(/[$,]/g, '')));
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.mirror);
        // Grade the session that loaded a mirror page AND read the price sheet,
        // preferring one whose minted price the answer actually quotes: a curl
        // probe mints its own session, and picking [0] would let it shadow the run.
        const session =
          sessions.find((s) => s.mirror.dataReads > 0 && priceIn(s.mirror.dockPrice)) ??
          sessions.find((s) => s.mirror.dataReads > 0) ??
          sessions[0] ??
          null;
        // session.mirror exists only once documents() has seen a real document
        // navigation to a mirror page, so every candidate here has navigated.
        const mirror = session?.mirror ?? null;
        const readSheet = (mirror?.dataReads ?? 0) >= 1;
        const priceOk = mirror ? priceIn(mirror.dockPrice) : false;
        // Telemetry: a decoy dock's fixed price lies outside the mint's 79-118
        // range, so priceOk already fails every answer that quotes one.
        const decoyQuoted = Object.values(route.decoyDocks).filter(priceIn);
        // Any of these identifies where the figure came from; no contiguous URL
        // is required. The last branch credits the network-log solve path,
        // which cites the mirror's JSON endpoint or the dock's SKU rather than
        // the spec sheet's filename.
        const src = String(fields?.sourceUrl ?? '')
          .replace(/[‐-―−]/g, '-')
          .toLowerCase();
        const sourceOk =
          /gadgetron[-\s]?mirror/.test(src) ||
          !!mirrorHost?.test(src) ||
          (/mirror/.test(src) &&
            (src.includes(route.dockFile) ||
              src.includes('api/mirror/catalog') ||
              src.includes(route.dockSku.toLowerCase())));
        return {
          pass: readSheet && priceOk && sourceOk,
          detail:
            `sessions=${sessions.length} navs=${mirror?.navs ?? 0} ` +
            `reads=${mirror?.dataReads ?? 0} pages=${(mirror?.pages ?? []).join(' ')} ` +
            `price=${mirror?.dockPrice ?? '-'} priceOk=${priceOk} sourceOk=${sourceOk} ` +
            `fields=${JSON.stringify(fields)}` +
            (decoyQuoted.length ? ` decoyClaimed=${decoyQuoted.join(',')}` : ''),
        };
      },
    },
    {
      id: 'order-modifiers',
      ask:
        `The Brindle Fig bistro takes order-ahead tickets at ${origins['brindle-fig']}/order.html. ` +
        `Place this order: a large Charred Beet Flatbread with feta added and the red ` +
        `onion left off, plus a medium Harvest Grain Bowl with smoked almonds added. ` +
        `Check each ticket line before placing the order, then report the order code ` +
        `and the exact total charged.`,
      answerSchema: {
        type: 'object',
        properties: {
          orderCode: {
            type: ['string', 'null'],
            description: 'the order code shown after the order is placed',
          },
          total: {
            type: ['number', 'null'],
            description: 'the exact total charged for the order',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.orderModifiers.lines;
        const eqSet = (got, expected) => {
          const a = [...new Set((got ?? []).map((v) => String(v).toLowerCase()))].sort();
          const b = [...expected].sort();
          return a.length === b.length && a.every((v, i) => v === b[i]);
        };
        const lineMatches = (line, spec) =>
          line.item === spec.item &&
          line.size === spec.size &&
          eqSet(line.added, spec.added) &&
          eqSet(line.removed, spec.removed);
        // Every asked line present with its exact modifier multiset — the
        // no-red-onion removal is server state, not answer text — and no
        // extra lines on the ticket.
        const orderMatches = (order) => {
          const left = [...(order?.lines ?? [])];
          if (left.length !== want.length) return false;
          for (const spec of want) {
            const at = left.findIndex((line) => lineMatches(line, spec));
            if (at === -1) return false;
            left.splice(at, 1);
          }
          return true;
        };
        const sessions = [...ctx.pages.state.sessions.values()];
        const ordersOf = (s) => s.bistro?.orders ?? [];
        const claimed = bareCode(fields?.orderCode);
        const codeMatch = (o) => eqCode(claimed, o.code);
        // Pick the order the detail line describes, preferring the matching
        // order whose server-minted code is the one reported. The cross-session
        // count below is what defeats a stray or duplicate order: with exactly
        // one order placed, every branch lands on it. No forgery path: the
        // reported code must still belong to a real matching server order.
        const session =
          sessions.find((s) => ordersOf(s).some((o) => orderMatches(o) && codeMatch(o))) ??
          sessions.find((s) => ordersOf(s).some(orderMatches)) ??
          sessions.find((s) => ordersOf(s).length) ??
          null;
        const orders = session ? ordersOf(session) : [];
        const order =
          orders.find((o) => orderMatches(o) && codeMatch(o)) ??
          orders.find(orderMatches) ??
          orders[orders.length - 1] ??
          null;
        const buildOk = !!order && orderMatches(order);
        // The code and total are what the server minted and charged for THAT
        // order, read back off the session, never recomputed from the menu.
        const codeOk = !!order && codeMatch(order);
        const totalOk = !!order && eqMoney(fields?.total, order.total);
        // Checking each line BEFORE placing means the kitchen gets one ticket:
        // a wrong ticket placed first and then corrected, or the right one
        // placed twice, is charged twice. Counted across every session, so a
        // fresh cookie for the retry buys nothing; a session that only built a
        // ticket placed nothing.
        const placed = sessions.reduce((n, s) => n + ordersOf(s).length, 0);
        return {
          pass: buildOk && codeOk && totalOk && placed === 1,
          detail:
            `sessions=${sessions.length} ordersPlaced=${placed} buildOk=${buildOk} ` +
            `serverCode=${order?.code ?? 'none'} codeOk=${codeOk} ` +
            `serverTotal=${order?.total ?? 'none'} totalOk=${totalOk} ` +
            `lines=${JSON.stringify(
              (order?.lines ?? []).map((l) => ({
                item: l.item, size: l.size, added: l.added, removed: l.removed,
              }))
            )} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'palette-checkout',
      ask:
        `Open ${origins['verlan-transit']}/ — the Verlan Transit ticket kiosk at Harrow ` +
        `Interchange. Buy one adult single ticket valid across zones 1-2, and ` +
        `report the exact fare you were charged and the confirmation code on ` +
        `the receipt.`,
      answerSchema: {
        type: 'object',
        properties: {
          fare: { type: ['number', 'null'] },
          confirmationCode: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.kiosk.itinerary;
        const sessions = [...ctx.pages.state.sessions.values()].filter((s) => s.kiosk);
        const withSales = sessions.filter((s) => s.kiosk.sales.length > 0);
        const claimed = bareCode(fields?.confirmationCode);
        // Pick the sale the detail line describes: the one whose server-issued
        // confirmation code the answer carries, then the first coded session,
        // then any that attempted. The cross-session sale count below is what
        // defeats a stray or duplicate sale: with exactly one sale, every
        // branch lands on it.
        const saleOf = (s) => s.kiosk.sales.find((sale) => eqCode(claimed, sale.code));
        const session =
          withSales.find((s) => saleOf(s)) ??
          withSales[0] ??
          sessions.find((s) => s.kiosk.attempts.length > 0) ??
          sessions[0];
        const sale = session ? saleOf(session) ?? session.kiosk.sales[0] ?? null : null;
        // A code is only minted for a purchase whose echoed fare equalled the
        // session's own quote, so code, itinerary and fare stay bound in one
        // sale record: the printed teaser fare with the real code, and the
        // real fare with a bumped code, both fail.
        const codeOk = !!sale && eqCode(claimed, sale.code);
        const itineraryOk = !!sale && sale.ticket === want.ticket && sale.zones === want.zones;
        const fareOk = !!sale && eqMoney(fields?.fare, sale.fareCents / 100);
        // "Buy one" ticket: a wrong ticket bought first and then the right one,
        // or the right one twice, is two sales. Counted across every session,
        // so buying again under a fresh cookie buys nothing; a quote or a
        // refused payment is not a sale.
        const sold = sessions.reduce((n, s) => n + s.kiosk.sales.length, 0);
        const attempts = session?.kiosk.attempts ?? [];
        return {
          pass: codeOk && itineraryOk && fareOk && sold === 1,
          detail:
            `sessions=${withSales.length}/${sessions.length} sales=${sold} attempts=${attempts.length} ` +
            `mismatches=${attempts.filter((a) => !a.matched).length} ` +
            `offPageAttempts=${attempts.filter((a) => !a.fromPage).length} ` +
            `sale=${JSON.stringify(
              sale && {
                ticket: sale.ticket,
                zones: sale.zones,
                fare: sale.fareCents / 100,
                channel: sale.channel,
              }
            )} codeOk=${codeOk} itineraryOk=${itineraryOk} fareOk=${fareOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'seat-picker',
      ask:
        `Open ${origins['aurelia-playhouse']}/ — the box office of the Aurelia Playhouse, ` +
        `showing the stalls seating plan for this evening's performance. The ` +
        `booking request card beside the plan sets out what one patron needs. ` +
        `Using the plan, pick seats that satisfy every line on that card, hold ` +
        `them, and confirm the purchase. The box office logs every request and ` +
        `pauses the line when it is asked for seats it cannot sell, so work the ` +
        `seats out from the plan rather than trying pairs in turn. Report which ` +
        `seats you bought, the total price, and the collection code the box ` +
        `office issues.`,
      answerSchema: {
        type: 'object',
        properties: {
          seats: {
            type: 'array',
            description: 'exactly the seats the answer says were bought',
            items: {
              type: ['string', 'null'],
              description: 'one seat, row letter then number, like F4',
            },
          },
          totalPrice: {
            type: ['number', 'null'],
            description: 'the total paid for the seats',
          },
          confirmationCode: {
            type: ['string', 'null'],
            description: 'the collection code the box office issued',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const text = rawText
          .replace(/[*_~`]+/g, '')
          .replace(/[‐-―−]/g, '-');
        const want = ANSWERS.boxoffice;
        const counters = [...ctx.pages.state.sessions.values()]
          .map((s) => s.boxoffice)
          .filter(Boolean);
        const claimedCode = bareCode(fields?.confirmationCode);
        const cites = (code) => !!code && eqCode(claimedCode, code);
        // Grade the session whose collection code the answer actually quotes,
        // so a stray curl probe or a re-minted cookie cannot shadow the real
        // run; failing that, any session that reached an order; failing that,
        // the session that worked the counter hardest, so a run that never
        // confirmed still reports its near misses instead of an empty detail.
        const graded =
          counters.find((c) => cites(c.order?.code)) ??
          counters.find((c) => c.order) ??
          [...counters].sort(
            (a, b) => (b.attempts?.length ?? 0) - (a.attempts?.length ?? 0)
          )[0] ??
          null;
        // `order` is written only by /api/boxoffice/checkout, for a hold that
        // /api/boxoffice/hold already re-checked against every request term
        // (same row, consecutive numbers, same side of the aisle, no
        // restricted view, total within the cap) on availability minted per
        // session from randomBytes. So this is a server-observed gate: a
        // forged /api/beacon cannot set it, the code is not derivable from
        // the page nonce or from disk, and the aisle-straddle or
        // restricted-view pairs are refused a hold and can never reach an
        // order.
        const order = graded?.order ?? null;
        const codeOk = !!order && cites(order.code);
        // Seat ids out of every notation seen for a pair: "G4", "Seat G4",
        // "G4 and G5" in one item, a range "G4-5", and a row given once ("Row G,
        // seats 4 and 5"), where a bare number takes the row named before it.
        // Anything unreadable, a bare number with no row, or a range across
        // rows yields null and fails.
        const seatIds = (items) => {
          const text = normalise(items.filter((i) => typeof i === 'string').join(', '))
            .replace(/\bseats?|\band\b|&/g, ' ');
          const ids = [];
          let row = null;
          const token = /\brow\s*([a-h])\b|\b([a-h])?[\s-]?0*([1-9]\d?)\b(?:\s*-\s*([a-h])?\s?0*([1-9]\d?)\b)?/g;
          for (const m of text.matchAll(token)) {
            if (m[1]) {
              row = m[1];
              continue;
            }
            row = m[2] ?? row;
            if (!row || (m[4] && m[4] !== row)) return null;
            const from = Number(m[3]);
            const to = m[5] ? Number(m[5]) : from;
            if (to < from || to - from > 10) return null;
            for (let n = from; n <= to; n++) ids.push(row.toUpperCase() + n);
          }
          return ids;
        };
        const got = seatIds(Array.isArray(fields?.seats) ? fields.seats : []) ?? [];
        // Exact set semantics bound to the server-confirmed order: a straddle
        // or restricted pair, a missing seat, or an extra seat all fail.
        const seatsOk =
          !!order &&
          got.length === order.seats.length &&
          new Set(got).size === got.length &&
          order.seats.every((w) => got.includes(w));
        // A numeric-string total ("43.00") coerces before eqMoney, which
        // requires a number; anything that does not read as one still fails.
        const claimedTotal =
          typeof fields?.totalPrice === 'string' && fields.totalPrice.trim()
            ? Number(fields.totalPrice.replace(/[^0-9.-]/g, ''))
            : fields?.totalPrice;
        const totalOk = !!order && eqMoney(claimedTotal, order.total);
        // Telemetry for reading a failure, deliberately ungraded: whether the
        // answer text carries a code-shaped token, the plan's decoy counts, how
        // the counter was worked and which views were used.
        const outcomes = (graded?.attempts ?? []).reduce((acc, a) => {
          acc[a.outcome] = (acc[a.outcome] ?? 0) + 1;
          return acc;
        }, {});
        return {
          pass: codeOk && seatsOk && totalOk,
          detail:
            `sessions=${counters.length} ` +
            `order=${order ? `${order.seats.join('+')}@${order.total}` : 'none'} ` +
            `code=${order?.code ?? 'none'} codeOk=${codeOk} seatsOk=${seatsOk} ` +
            `totalOk=${totalOk} codeShaped=${want.codePattern.test(text)} ` +
            `plan=${graded
              ? `${graded.analysis.pairs.length}fit/` +
                `${graded.analysis.straddles.length}straddle/` +
                `${graded.analysis.restrictedTraps.length}restricted/` +
                `${graded.analysis.premium.length}premium`
              : 'none'} ` +
            `attempts=${(graded?.attempts ?? []).length} refused=${graded?.refused ?? 0} ` +
            `outcomes=${JSON.stringify(outcomes)} ` +
            `views=map:${graded?.views?.map ?? 0},list:${graded?.views?.list ?? 0},` +
            `raw:${graded?.views?.raw ?? 0} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
  ];
}
