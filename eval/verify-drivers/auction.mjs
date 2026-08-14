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

const INDEX_PATH = '/auction/';
const LOT_PATH = '/auction/lot-418.html';
const CONDITIONS_PATH = '/auction/conditions.html';
const PREMIUM = 0.22;
const LIMIT_TOTAL = 2200;
const INCREMENT = 100;
const allIn = (amount) => Math.round(amount * (1 + PREMIUM) * 100) / 100;

import { snapText, textOf, uidOf, until as poll } from './lib.mjs';

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

export const DRIVERS = {
  'live-auction': {
    note: 'live saleroom: polls the moving ladder, bids on the increment, waits for the hammer',
    wrong: ['We took lot 418. Paddle code MS-7C31A9, hammer price 1,700, total 2,074 with premium.'],
    async run({ mcp, goto, sleep }) {
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
      let declinedAt = null;
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
        // The room's limit is drawn per session and on its top draw the next
        // rung is past the commission limit. Letting the lot go there is the
        // correct answer rather than a failure, so it is reported, not thrown.
        if (allIn(next) > LIMIT_TOTAL) {
          declinedAt = next;
          break;
        }
        if ((await placeBid(mcp, next)) === 'taken') accepted = true;
        else refused += 1;
      }

      if (declinedAt !== null) {
        const gone = await until(
          'the lot to be knocked down to the room',
          async () => {
            const lines = (await consoleSnap(mcp)).split('\n');
            const i = lines.findIndex((l) => l.includes('text="Sold in the room"'));
            if (i === -1) return null;
            for (const line of lines.slice(i)) {
              const m = line.match(/text="([\d,]+)"/);
              if (m) return Number(m[1].replace(/,/g, ''));
            }
            return null;
          },
          { tries: 120, gap: 2000 }
        );
        const fields = {
          outcome: 'declined',
          paddleCode: null,
          hammerPrice: null,
          totalOwed: null,
          stoppedAtFigure: declinedAt,
          stopReason:
            `the next bid of ${declinedAt.toLocaleString('en-GB')} would come to ` +
            `${allIn(declinedAt).toLocaleString('en-GB')} with the premium, past our 2,200 limit`,
        };
        this.wrongFields = [
          { ...fields, outcome: 'won' },
          { ...fields, stoppedAtFigure: declinedAt + 300 },
          { ...fields, stopReason: 'the room was bidding too fast to keep up' },
        ];
        this.alsoCorrectFields = [
          fields,
          { ...fields, stoppedAtFigure: declinedAt - INCREMENT },
        ];
        return {
          text: [
            `I did not take lot 418. The room stood at`,
            `${(declinedAt - INCREMENT).toLocaleString('en-GB')} and the next bid was`,
            `${declinedAt.toLocaleString('en-GB')}, which with the 22% buyer's premium comes to`,
            `${allIn(declinedAt).toLocaleString('en-GB')} — past our ${LIMIT_TOTAL.toLocaleString('en-GB')}`,
            `limit — so I declined and let it go.`,
            gone ? `It was knocked down in the room at ${gone.toLocaleString('en-GB')}.` : '',
          ]
            .join(' ')
            .trim(),
          fields,
        };
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
      const hammerStr = closing.hammer.toLocaleString('en-GB');
      const totalStr = total.toLocaleString('en-GB');
      // Won-branch phrasings only: the declined branch returns above and its
      // values do not exist on this run.
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
