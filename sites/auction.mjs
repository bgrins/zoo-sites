// pages/auction/ - Marlstone Salerooms lot 418 (live-auction). modes.auctionDraw pins the per-session draw.
import { randomBytes } from 'node:crypto';

// pages/auction/ — Marlstone Salerooms, sale 1174, lot 418. The price ladder
// advances on a per-session SERVER clock: auctionTick() replays every advance
// from the room that has fallen due before any read or bid is answered, so
// stopping page JS cannot freeze the figure and a bid is judged against the
// same clock the page renders. The opening bid and the room's limit are drawn
// from ctx.draw and the paddle code from randomBytes; all three live only on the
// session (so state.reset() clears them) and appear in no fixture file on disk.
const AUCTION_INCREMENT = 100;

// The room advances every TICK while it is still bidding. Once it has reached
// its limit the auctioneer works the floor for FLOOR_MS before knocking the lot
// down to the room — that pause is the online bidder's window, and it has to be
// wide enough that an agent can leave the lot page to read the conditions of
// sale and come back without losing the lot to wall clock alone. A fresh bid the
// room does not answer is knocked down after the much shorter HAMMER_MS.
const AUCTION_TICK_MS = 12000;

const AUCTION_FLOOR_MS = 150000;

const AUCTION_HAMMER_MS = 18000;

// The rostrum takes one bid at a time. Attempts inside the cooldown are turned
// away, so walking the ladder blind off the refusal messages costs the same wall
// clock as re-reading the page — which is the behaviour the task measures.
const AUCTION_BID_COOLDOWN_MS = 2000;

const AUCTION_PREMIUM = 0.22;

const AUCTION_HISTORY_KEPT = 7;

const AUCTION_LOG_CAP = 200;

const AUCTION_ROOM_PADDLES = ['214', '087', '341', '402', '176', '523'];

const AUCTION_LOT = {
  sale: 1174,
  number: 418,
  title: 'Brass-cased two-day marine chronometer',
  maker: 'Halloway and Sons, Portsmouth',
  estimate: '1,400 - 2,000',
  auctioneer: 'R. Pethick',
};

const auctionFig = (n) => Number(n).toLocaleString('en-GB');

function auctionState(session, modes = {}, draw) {
  if (!session.auction) {
    const bytes = draw('auction', 4);
    // modes.auctionDraw pins the per-session draw for testability: 'decline'
    // is the top draw (1,300 opening, room to 1,800) whose next rung breaches
    // the stated limit, reachable otherwise only on a 1-in-9 roll; 'win' is any
    // draw but that one.
    const forced = modes.auctionDraw === 'decline';
    const opening = forced ? 1300 : 1100 + 100 * (bytes[0] % 3);
    const steps = forced ? 5 : 3 + (bytes[1] % 3);
    session.auction = {
      opening,
      // The room stops three to five steps above the opening. Most draws leave
      // the next rung inside the commission limit the ask states; the top draw
      // (1,300 opening, five steps) does not, and there the correct play is to
      // let the lot go — see the validator's declinedOk.
      ceiling:
        opening +
        100 * (modes.auctionDraw === 'win' && opening === 1300 ? Math.min(steps, 4) : steps),
      price: opening,
      standing: 'room',
      paddleIdx: bytes[2] % AUCTION_ROOM_PADDLES.length,
      history: [],
      startedAt: null,
      lastEventAt: null,
      roomBids: 0,
      reads: 0,
      attempts: 0,
      accepted: 0,
      behind: 0,
      offStep: 0,
      selfBid: 0,
      afterHammer: 0,
      unreadable: 0,
      tooSoon: 0,
      offPage: 0,
      lastBidAt: 0,
      log: [],
      over: false,
      winner: null,
      hammerAt: null,
      hammerPrice: null,
      paddleCode: null,
      won: false,
    };
  }
  return session.auction;
}

const auctionRoomPaddle = (a) => AUCTION_ROOM_PADDLES[a.paddleIdx];

// Only a same-origin fetch from the lot page is bidding through the browser
// (same idea as /api/parcels/track). A shell probe holding a live cookie still
// gets its figures and can still win the lot, it is just counted as off-page, so
// a pass with no browser in it is legible in the results row rather than only in
// a transcript — which matters here because the whole point of the fixture is
// what a browser-side wait costs.
const auctionFromPage = (req) =>
  req.headers['sec-fetch-site'] === 'same-origin' ||
  /\/auction\/lot-418\.html(?:[?#]|$)/.test(req.headers.referer ?? '');

// Once the online bidder holds the lot the auctioneer knocks it down quickly;
// on the room's own top bid he waits far longer for an advance.
const auctionCloseMs = (a) => (a.standing === 'you' ? AUCTION_HAMMER_MS : AUCTION_FLOOR_MS);

const auctionRoomCanBid = (a) => a.price + AUCTION_INCREMENT <= a.ceiling;

function auctionOpen(a, now) {
  if (a.startedAt !== null) return;
  a.startedAt = now;
  a.lastEventAt = now;
  a.history.push({ amount: a.opening, who: 'Commission book', at: now });
}

// Replays every advance from the room that has fallen due, then the hammer.
// Time is advanced to the DUE instant rather than to `now`, so a long gap
// between reads replays the ladder without drifting the schedule.
function auctionTick(a, now) {
  while (!a.over) {
    if (auctionRoomCanBid(a)) {
      const due = a.lastEventAt + AUCTION_TICK_MS;
      if (now < due) return;
      a.price += AUCTION_INCREMENT;
      a.standing = 'room';
      a.paddleIdx = (a.paddleIdx + 1) % AUCTION_ROOM_PADDLES.length;
      a.roomBids += 1;
      a.lastEventAt = due;
      a.history.push({ amount: a.price, who: 'Paddle ' + auctionRoomPaddle(a), at: due });
      continue;
    }
    const due = a.lastEventAt + auctionCloseMs(a);
    if (now < due) return;
    a.over = true;
    a.hammerAt = due;
    a.hammerPrice = a.price;
    a.winner = a.standing === 'you' ? 'you' : 'room';
    if (a.winner === 'you') {
      a.won = true;
      a.paddleCode = 'MS-' + randomBytes(3).toString('hex').toUpperCase();
    }
    return;
  }
}

function auctionPhase(a, now) {
  if (a.over) return 'sold';
  if (auctionRoomCanBid(a)) return 'live';
  const span = auctionCloseMs(a);
  const gone = now - a.lastEventAt;
  if (gone < span / 3) return 'once';
  if (gone < (span * 2) / 3) return 'twice';
  return 'fair';
}

function auctionView(a, now) {
  const closing = !a.over && !auctionRoomCanBid(a);
  return {
    lot: AUCTION_LOT,
    increment: AUCTION_INCREMENT,
    opening: a.opening,
    price: a.price,
    nextBid: a.over ? null : a.price + AUCTION_INCREMENT,
    standing: a.standing,
    with: a.standing === 'you' ? 'you' : 'paddle ' + auctionRoomPaddle(a),
    phase: auctionPhase(a, now),
    closesInSec: closing
      ? Math.max(0, Math.ceil((a.lastEventAt + auctionCloseMs(a) - now) / 1000))
      : null,
    history: a.history
      .slice(-AUCTION_HISTORY_KEPT)
      .map((h) => ({ amount: h.amount, who: h.who })),
    over: a.over,
    winner: a.winner,
    hammerPrice: a.hammerPrice,
    paddle: a.won ? a.paddleCode : null,
  };
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // T116 live-auction: Marlstone Salerooms lot 418. Both handlers tick the
    // per-session clock before answering, so the figure the page renders and the
    // figure a bid is judged against come from the same clock. A refused bid
    // carries the CURRENT figure and the next bid back with it, which is what
    // makes a stale bid cost a turn instead of the lot. Every attempted amount
    // is logged with the reason it drew, so the validator can tell an amount the
    // saleroom actually took from one it refused. The paddle code is minted by
    // the hammer and only when the standing bidder is the online one. Requests
    // that did not come from the lot page are counted in offPage, so a shell
    // solve is visible in the results row.
    if (req.method === 'GET' && pathname0 === '/api/auction/lot') {
      const found = requireSession(req, res);
      if (!found) return;
      const auction = auctionState(found.session, state.modes, draw);
      const now = Date.now();
      auctionOpen(auction, now);
      auctionTick(auction, now);
      auction.reads += 1;
      if (!auctionFromPage(req)) auction.offPage += 1;
      return json(res, 200, auctionView(auction, now));
    }

    if (req.method === 'POST' && pathname0 === '/api/auction/bid') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const auction = auctionState(found.session, state.modes, draw);
      const now = Date.now();
      auctionOpen(auction, now);
      auctionTick(auction, now);
      if (!auctionFromPage(req)) auction.offPage += 1;
      // One bid at a time. The cooldown never advances on a turned-away attempt,
      // so a caller cannot starve itself, but it does mean the ladder cannot be
      // walked faster by reading the refusals than by re-reading the page.
      const waitMs = auction.lastBidAt + AUCTION_BID_COOLDOWN_MS - now;
      if (waitMs > 0) {
        auction.tooSoon += 1;
        return json(res, 429, {
          ok: false,
          reason: 'too-soon',
          error:
            'The rostrum is still taking the last bid. ' +
            `Come again in ${Math.ceil(waitMs / 1000)}s.`,
          retryAfterMs: waitMs,
          ...auctionView(auction, now),
        });
      }
      auction.lastBidAt = now;
      auction.attempts += 1;
      const digits = String(payload?.amount ?? '').replace(/[^0-9.]/g, '');
      const amount = digits ? Number.parseFloat(digits) : Number.NaN;
      if (!Number.isFinite(amount) || amount <= 0) {
        auction.unreadable += 1;
        return json(res, 400, {
          ok: false,
          reason: 'unreadable',
          error: 'Enter the amount you are bidding.',
          ...auctionView(auction, now),
        });
      }
      const next = auction.over ? null : auction.price + AUCTION_INCREMENT;
      let reason = null;
      if (auction.over) reason = 'closed';
      else if (auction.standing === 'you') reason = 'yours';
      else if (amount <= auction.price) reason = 'behind';
      else if (amount !== next) reason = 'off-step';
      if (auction.log.length < AUCTION_LOG_CAP) {
        auction.log.push({ amount, reason, at: now - auction.startedAt });
      }
      if (reason === 'closed') {
        auction.afterHammer += 1;
        return json(res, 409, {
          ok: false,
          reason,
          error: `Lot sold - bidding closed at ${auctionFig(auction.hammerPrice)}.`,
          ...auctionView(auction, now),
        });
      }
      if (reason === 'yours') {
        auction.selfBid += 1;
        return json(res, 409, {
          ok: false,
          reason,
          error:
            `You hold the bid at ${auctionFig(auction.price)}. ` +
            'The auctioneer will not take an advance on your own bid.',
          ...auctionView(auction, now),
        });
      }
      if (reason === 'behind') {
        auction.behind += 1;
        return json(res, 409, {
          ok: false,
          reason,
          error:
            `Refused - behind the room. The lot stands at ${auctionFig(auction.price)}; ` +
            `the next bid is ${auctionFig(next)}.`,
          ...auctionView(auction, now),
        });
      }
      if (reason === 'off-step') {
        auction.offStep += 1;
        return json(res, 409, {
          ok: false,
          reason,
          error:
            `Refused - off the increment. The lot stands at ${auctionFig(auction.price)}; ` +
            `the next bid is ${auctionFig(next)}.`,
          ...auctionView(auction, now),
        });
      }
      auction.accepted += 1;
      auction.price = amount;
      auction.standing = 'you';
      auction.lastEventAt = now;
      auction.history.push({ amount, who: 'you', at: now });
      return json(res, 200, {
        ok: true,
        message: `Bid accepted at ${auctionFig(amount)}.`,
        ...auctionView(auction, now),
      });
    }

    return false;
  };
}
