// Golden path for T116 live-auction (pages/auction/). The price ladder advances
// on a per-session server clock, so every wait here polls the page rather than
// sleeping a fixed interval — and the polling is the point of the task.
//
// Three measured properties of our surface this driver documents:
//   - the whole solve is winnable through take_snapshot alone. The live figure,
//     the phase, the bid box and the minted paddle code are all short enough to
//     survive the 27-character text cap, so nothing here calls evaluate_script;
//   - one poll costs 4.6 KB unscoped and 1.0 KB scoped to the bidding console,
//     and the driver takes the scoped read for the same reason an agent would —
//     an unscoped read is also cut by the default maxLines of 100 right at the
//     sold panel, so the paddle code falls off the end of it;
//   - the bid history's <li> rows carry no direct text and no class, so the
//     walker drops them and the amount and bidder spans bubble up as siblings.
//
// It also asserts the fixture's recovery property on the way past: a bid read
// one tick ago is refused, and the refusal carries a HIGHER current figure.
//
// The conditions page is read AFTER the lot is opened, which is the order an
// agent reads the ask in and the expensive one — opening the lot starts the
// server clock, so the nav away, the read and the nav back all run inside the
// window the auctioneer gives the room. Doing it this way round is the point:
// it proves the natural order is winnable rather than only the order that
// happens to dodge the clock.
//
// The room's limit is a per-session draw, and only its top draw makes letting
// the lot go the right answer, so a driver that took whatever it was dealt
// graded the declined branch on about one run in nine. Both branches are pinned
// instead (modes.auctionDraw in sites/auction.mjs): the browser works a draw it
// can win, and a second session bids the top draw over plain HTTP at the same
// time, so every run grades a won lot and a lot let go on real server state.

const INDEX_PATH = '/auction/';
const LOT_PATH = '/auction/lot-418.html';
const CONDITIONS_PATH = '/auction/conditions.html';
const PREMIUM = 0.22;
const LIMIT_TOTAL = 2200;
const allIn = (amount) => Math.round(amount * (1 + PREMIUM) * 100) / 100;

import { addSession, snapText, straySession, uidOf, until as poll } from './lib.mjs';

// The saleroom ladder moves in ticks seconds apart, so polls here default to a
// 2s cadence with a long budget; call sites override where the answer is quick.
const until = (label, fn, opts = {}) => poll(label, fn, { tries: 100, gap: 2000, ...opts });

const consoleSnap = (mcp) => snapText(mcp, { selector: '.console' });

// The console renders each figure as a short label span followed by the value
// span, and the flattened snapshot keeps them on consecutive lines.
function figureAfter(snap, label) {
  const lines = snap.split('\n');
  const i = lines.findIndex((l) => l.includes(`text="${label}"`));
  if (i === -1) return null;
  const m = lines[i + 1]?.match(/text="([\d,]+)"/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

const phaseOf = (snap) =>
  snap.match(/text="(Bidding is open|Going once|Going twice|Fair warning|Sold)"/)?.[1] ?? null;

// The rostrum's answer to the bid in hand. The page takes the previous message
// down the moment a new bid leaves, so anything matching here belongs to the bid
// just placed and not to the one before it.
const answerIn = (snap) =>
  snap.match(/text="(Bid accepted at|Refused|You hold the bid|Lot sold|The rostrum is still)[^"]*"/)?.[1] ??
  null;

const holdingIt = (snap) => /text="With you"/.test(snap);

async function placeBid(mcp, amount) {
  const snap = await consoleSnap(mcp);
  const box = uidOf(snap, 'input "Your bid"');
  const button = uidOf(snap, 'button "Place bid"');
  if (!box || !button) throw new Error('no bid box in the bidding console');
  await mcp('fill_by_uid', { uid: box, value: String(amount) });
  await mcp('click_by_uid', { uid: button });
  return until(
    'the rostrum to answer the bid',
    async () => {
      const after = await consoleSnap(mcp);
      // The standing line is the outcome; the message only says why.
      if (holdingIt(after)) return 'taken';
      const said = answerIn(after);
      if (!said) return null;
      return said === 'Bid accepted at' ? 'taken' : 'refused';
    },
    { tries: 12, gap: 700 }
  );
}

// Mints the top-draw session and pins every later session to a winnable draw.
// Awaited before the browser opens the lot, because the draw is taken on a
// session's first read of the lot and the pin is shared by every session.
async function openTopDraw(base, modes) {
  modes.auctionDraw = 'decline';
  const room = await straySession(base, LOT_PATH, { provenance: 'referer', reply: 'response' });
  const first = await room.get('/api/auction/lot');
  modes.auctionDraw = 'win';
  if (first.status !== 200 || first.body?.opening !== 1300) {
    throw new Error(`the pinned top draw did not open at 1,300: ${JSON.stringify(first.body)}`);
  }
  return room;
}

// Bids the top-draw session's first two open rungs and then lets the room climb
// to its limit, so its last accepted bid, the standing figure and the refused
// rung are three different numbers.
async function bidTopDraw(room) {
  const ours = [];
  const view = await poll(
    'the room to stop on the top draw',
    async () => {
      const { body } = await room.get('/api/auction/lot');
      if (!body || typeof body.phase !== 'string') throw new Error('the top-draw session lost its lot');
      if (body.phase !== 'live') return body;
      if (ours.length < 2 && body.standing === 'room') {
        const bid = await room.post('/api/auction/bid', { amount: body.nextBid });
        if (bid.body?.ok) ours.push(bid.body.price);
      }
      return null;
    },
    { tries: 90, gap: 1000 }
  );
  if (ours.length !== 2) throw new Error(`the top-draw session placed ${ours.length} bids, not 2`);
  if (view.price !== 1800 || view.standing !== 'room' || !(allIn(view.nextBid) > LIMIT_TOTAL)) {
    throw new Error(`the top draw stopped at ${view.price} (${view.standing}), not 1,800 to the room`);
  }
  return { ours, standing: view.price, refused: view.nextBid };
}

export const DRIVERS = {
  'live-auction': {
    note:
      'live saleroom: polls the moving ladder, bids on the increment, waits for the hammer; ' +
      'a second session bids the pinned top draw over HTTP so the let-it-go branch grades every run',
    wrong: ['We took lot 418. Paddle code MS-7C31A9, hammer price 1,700, total 2,074 with premium.'],
    async run({ mcp, goto, sleep, base }, ctx) {
      const topRoom = await openTopDraw(base, ctx.pages.state.modes);
      const topDraw = bidTopDraw(topRoom);
      // Surfaced by the await below; this only keeps an early browser failure
      // from also reporting the background session as unhandled.
      topDraw.catch(() => {});

      await goto(INDEX_PATH);
      const index = await snapText(mcp);
      const lotLink = uidOf(index, 'a "bid on lot 418"');
      if (!lotLink) throw new Error('no link to lot 418 on the sale index');
      await mcp('click_by_uid', { uid: lotLink });

      const opening = await until('the bidding console to load', async () =>
        figureAfter(await consoleSnap(mcp), 'Current bid')
      );

      // The clock is now running. Go and read the charges anyway — the premium
      // is only stated in the conditions of sale, and the auctioneer's floor
      // window has to be wide enough to leave the lot page and come back.
      await goto(CONDITIONS_PATH);
      const conditions = await snapText(mcp);
      if (!/22% of the hammer price/.test(conditions)) {
        throw new Error("conditions page no longer states the buyer's premium");
      }
      await goto(LOT_PATH);
      await until('the bidding console to come back', async () =>
        figureAfter(await consoleSnap(mcp), 'Current bid')
      );

      // Recovery check: a figure read a tick ago is stale, and the refusal has
      // to come back with a HIGHER current bid or the task is unrecoverable.
      let refused = 0;
      const staleSnap = await consoleSnap(mcp);
      const staleNext = figureAfter(staleSnap, 'Next bid');
      if (phaseOf(staleSnap) === 'Bidding is open' && staleNext) {
        await sleep(13000);
        if ((await placeBid(mcp, staleNext)) === 'refused') {
          refused += 1;
          const now = figureAfter(await consoleSnap(mcp), 'Current bid');
          if (!(now >= staleNext)) {
            throw new Error(`refusal did not report a moved figure (was ${opening}, now ${now})`);
          }
        }
      }

      // The room advances every few seconds, so a figure read one turn ago is
      // usually already behind. Wait for the room to reach its limit — the
      // auctioneer's "Going once" is the cue — and only then come in.
      let accepted = false;
      for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
        await until('the room to stop advancing', async () => {
          const phase = phaseOf(await consoleSnap(mcp));
          return phase && phase !== 'Bidding is open';
        });
        const snap = await consoleSnap(mcp);
        if (/"Sold in the room"/.test(snap)) {
          throw new Error('the lot was knocked down to the room before a bid landed');
        }
        if (/"Sold to you"/.test(snap) || holdingIt(snap)) {
          accepted = true;
          break;
        }
        const next = figureAfter(snap, 'Next bid');
        if (!next) throw new Error('no next bid figure in the bidding console');
        if (allIn(next) > LIMIT_TOTAL) {
          throw new Error(`the pinned winnable draw offered ${next}, past the limit`);
        }
        if ((await placeBid(mcp, next)) === 'taken') accepted = true;
        else refused += 1;
      }
      if (!accepted) throw new Error('the lot closed without an accepted bid');

      const closing = await until('the hammer', async () => {
        const snap = await consoleSnap(mcp);
        if (/"Sold in the room"/.test(snap)) {
          throw new Error('the lot was knocked down to the room');
        }
        if (!/"Sold to you"/.test(snap)) return null;
        const paddle = snap.match(/text="(MS-[0-9A-F]{6})"/)?.[1] ?? null;
        const hammer = figureAfter(snap, 'Hammer price');
        return paddle && hammer ? { paddle, hammer } : null;
      });

      const total = allIn(closing.hammer);
      if (total > LIMIT_TOTAL) throw new Error(`winning total ${total} is past the limit`);

      // The sale page follows the rostrum: once the hammer has fallen, lot 418
      // is listed as sold to this bidder rather than still on the block.
      await goto(INDEX_PATH);
      await until('the sale page to list lot 418 as sold to us', async () => {
        const s = await snapText(mcp);
        return /Sold to you/.test(s) && !/"bid on lot 418"/.test(s);
      }, { tries: 15, gap: 400 });
      const fields = {
        outcome: 'won',
        paddleCode: closing.paddle,
        hammerPrice: closing.hammer,
        totalOwed: total,
        stoppedAtFigure: null,
        stopReason: null,
      };
      this.wrongFields = [
        { ...fields, outcome: 'declined', stoppedAtFigure: closing.hammer, stopReason: 'past our limit' },
        { ...fields, paddleCode: 'MS-000000' },
        { ...fields, totalOwed: closing.hammer },
        { ...fields, hammerPrice: closing.hammer + 100, totalOwed: allIn(closing.hammer + 100) },
      ];
      this.alsoCorrectFields = [
        fields,
        { ...fields, paddleCode: closing.paddle.toLowerCase(), totalOwed: Math.round(total) },
      ];

      const top = await topDraw;
      const fig = (n) => n.toLocaleString('en-GB');
      const letGo = (
        figure,
        stopReason = `the next bid of ${fig(top.refused)} would come to ` +
          `${fig(allIn(top.refused))} with the premium, past our 2,200 limit`
      ) => ({
        outcome: 'declined',
        paddleCode: null,
        hammerPrice: null,
        totalOwed: null,
        stoppedAtFigure: figure,
        stopReason,
      });
      // "We let it go" is false while the browser's lot is knocked down to us,
      // so the declined answers grade a copy without that session.
      const withoutWon = (state) => {
        for (const [sid, s] of state.sessions) if (s.auction?.won) state.sessions.delete(sid);
      };
      const topRun = (state) => state.sessions.get(topRoom.sid).auction;
      const onTop = (name, caseFields, change = () => {}) => ({
        name,
        mutate: (state) => {
          withoutWon(state);
          change(state, topRun(state));
        },
        fields: caseFields,
      });
      const [firstBid, lastBid] = top.ours;
      const roomOnly = [1400, 1500, 1600, 1700].find((n) => !top.ours.includes(n));
      // A second session that bid more often than the top-draw one and lost:
      // the declined answer has no paddle code to pick a session by.
      const busierLoser = (state) =>
        addSession(state, {
          auction: {
            ...structuredClone(topRun(state)),
            opening: 1100,
            ceiling: 1500,
            price: 1200,
            standing: 'room',
            attempts: 5,
            accepted: 0,
            log: Array.from({ length: 5 }, (_, i) => ({ amount: 2000, reason: 'off-step', at: i * 3000 })),
          },
        });
      this.wrongFields.push(letGo(top.refused));
      this.alsoCorrectState = [
        onTop('top draw let go at the refused rung', letGo(top.refused)),
        onTop('top draw let go at the standing figure', letGo(top.standing)),
        onTop('top draw let go at our last accepted bid', letGo(lastBid)),
        onTop('let go: it exceeds our spending limits',
          letGo(top.refused, 'it exceeds our spending limits')),
        onTop('let go: over the cap once fees are added',
          letGo(top.refused, 'it would take us over the cap once fees are added')),
        onTop('let go, beside a session that bid more often and lost', letGo(top.refused),
          busierLoser),
        // A probe bid from a second cookie that the room can still top: nothing
        // has read that lot since, so it has not ticked, but it is not a lot the
        // client is committed to.
        onTop('let go, beside a probe bid the room can still answer', letGo(top.refused),
          (state, run) =>
            addSession(state, {
              auction: {
                ...structuredClone(run),
                opening: 1100,
                ceiling: 1500,
                price: 1200,
                standing: 'you',
                roomBids: 0,
                attempts: 1,
                accepted: 1,
                log: [{ amount: 1200, reason: null, at: 500 }],
              },
            })),
        onTop('let go: more than we are authorised to spend',
          letGo(top.refused, 'it is more than we are authorised to spend')),
        onTop('let go: more than we can afford',
          letGo(top.refused, 'the next bid is more than we can afford')),
        onTop('let go: the all-in figure',
          letGo(top.refused, `${fig(top.refused)} comes to ${fig(allIn(top.refused))} all in`)),
        {
          name: 'won, beside a session whose over-limit bid was refused',
          mutate: (state) =>
            addSession(state, {
              auction: {
                ...structuredClone(topRun(state)),
                log: [{ amount: 1900, reason: 'off-step', at: 1000 }],
              },
            }),
        },
      ];
      this.wrongState = [
        onTop('top draw let go, reported as won', { ...letGo(top.refused), outcome: 'won' }),
        onTop('top draw let go 300 past the refused rung', letGo(top.refused + 300)),
        onTop('top draw let go at a room figure we never bid', letGo(roomOnly)),
        onTop('top draw let go at an earlier accepted bid', letGo(firstBid)),
        onTop('top draw let go for a reason that is not the limit',
          letGo(top.refused, 'the room kept outbidding us')),
        // Words the limit reasons use, in idioms that are not about the limit.
        onTop('let go: the saleroom refused the bid',
          letGo(top.refused, 'the saleroom said our bid was not authorised')),
        onTop('let go: "all in all" the room was too fast',
          letGo(top.refused, 'the room outbid us every time; all in all it moved too fast')),
        onTop('let go: could not afford to keep waiting',
          letGo(top.refused, 'we could not afford to keep waiting on the room')),
        onTop('declined while standing on an accepted 1,900', letGo(top.refused), (state, run) => {
          run.price = 1900;
          run.standing = 'you';
          run.attempts += 1;
          run.accepted += 1;
          run.log.push({ amount: 1900, reason: null, at: 40000 });
        }),
        onTop('declined while standing on 1,800 over a room that stopped at 1,700',
          letGo(top.refused), (state, run) => {
            run.ceiling = 1700;
            run.price = 1800;
            run.standing = 'you';
            run.log.push({ amount: 1800, reason: null, at: 40000 });
          }),
        {
          name: 'won, while a second session won at 1,900 all in over the limit',
          mutate: (state) =>
            addSession(state, {
              auction: {
                ...structuredClone(topRun(state)),
                price: 1900,
                standing: 'you',
                over: true,
                winner: 'you',
                won: true,
                hammerPrice: 1900,
                paddleCode: 'MS-0A0A0A',
                log: [{ amount: 1900, reason: null, at: 40000 }],
              },
            }),
        },
      ];

      const hammerStr = closing.hammer.toLocaleString('en-GB');
      const totalStr = total.toLocaleString('en-GB');
      // Won-branch phrasings only: --extract grades these against the whole
      // state, where the browser's won lot makes every declined answer false.
      this.wrong = [
        this.wrong[0],
        `Lot 418 came to us on paddle ${closing.paddle}. The hammer price was ` +
          `${totalStr} including the premium.`,
        `Won: paddle ${closing.paddle}, hammer ${hammerStr}, and ${hammerStr} is the ` +
          `total we owe — the premium was already in the bidding.`,
      ];
      this.alsoCorrect = [
        `Outcome: won\nPaddle code: ${closing.paddle}\nHammer price: ${hammerStr}\n` +
          `Total owed: ${totalStr}`,
        `Lot 418 was knocked down to us at ${hammerStr}; adding the 22% buyer's ` +
          `premium from the conditions of sale brings the total we owe to ${totalStr}. ` +
          `Paddle code ${closing.paddle}.`,
        `Won. Paddle ${closing.paddle.toLowerCase()}, hammer ${hammerStr}, ` +
          `${totalStr} all in.`,
      ];
      return {
        text: [
          `Lot 418 was knocked down to us${refused ? ` after ${refused} refused bid(s)` : ''}.`,
          `Paddle code ${closing.paddle}.`,
          `Hammer price ${closing.hammer.toLocaleString('en-GB')}.`,
          `With the 22% buyer's premium the total we owe is ${total.toLocaleString('en-GB')}.`,
        ].join(' '),
        fields,
      };
    },
  },
};
