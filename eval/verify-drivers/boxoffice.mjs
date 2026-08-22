// seat-picker: the Aurelia Playhouse stalls plan. The whole golden path runs on
// the uid surface: the SVG seat rects carry role=button, tabindex and short
// front-loaded aria-labels ('F9 28.00 open'), so the snapshot lists every seat
// still on sale — sold seats are plain rects and never appear, which is itself
// the availability signal. The driver reads the request card and the seat
// labels from the snapshot, solves for a qualifying pair, and drives seats,
// hold and confirm through click_by_uid; evaluate_script is never needed.
// The accessible list page (access.html) is a first-class alternate surface:
// booking through it flips the validator's views telemetry to list.

import { until, uidOf } from './lib.mjs';

const SEAT_RE =
  /uid=(\S+) button "([A-H])(\d{1,2}) (\d+\.\d\d) (open|restricted|selected)"/g;

function readSeats(snap) {
  const seats = new Map();
  for (const m of snap.matchAll(SEAT_RE)) {
    seats.set(m[2] + m[3], {
      uid: m[1],
      row: m[2],
      n: Number(m[3]),
      price: Number(m[4]),
      state: m[5],
    });
  }
  return seats;
}

export const DRIVERS = {
  'seat-picker': {
    note: 'request card and SVG seat labels read from the snapshot; seats, hold and confirm clicked by uid',
    wrong: 'I bought seats E6 and E7 for 56.00; the collection code is AUR-9F41C2.',
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto('/boxoffice/');
      await until('the request card to render', async () => {
        const terms = await evaluate(() =>
          [...document.querySelectorAll('#briefTerms li')].map((li) => li.textContent).join(' ')
        );
        return /\d+\.\d\d/.test(String(terms ?? '')) ? terms : null;
      }, { tries: 20 });
      // The card's own wording is read from the DOM, not the snapshot. Its terms
      // run past the snapshot's text cap, and whether an agent can still read
      // them there is the result this eval reports - not something the driver
      // should require before it will go green.
      const terms = String(
        await evaluate(() =>
          [...document.querySelectorAll('#briefTerms li')].map((li) => li.textContent).join('\n')
        )
      );
      const limit = Number(/(\d+\.\d\d) or less/.exec(terms)?.[1] ?? NaN);
      if (!Number.isFinite(limit)) {
        throw new Error(`price cap missing from the request card: ${terms}`);
      }
      if (!/centre aisle between seats 6 and 7/i.test(terms)) {
        throw new Error(`aisle term missing from the request card: ${terms}`);
      }
      const snap = await snapshot();
      const seats = readSeats(snap);
      if (!seats.size) throw new Error('no seat rects in the snapshot');
      const aisleAfter = 6;
      const sameBlock = (a, b) => (a <= aisleAfter) === (b <= aisleAfter);
      const pairs = { good: [], straddle: [], restrictedTrap: [], premium: [] };
      for (const seat of seats.values()) {
        const mate = seats.get(seat.row + (seat.n + 1));
        if (!mate) continue;
        const total = +(seat.price + mate.price).toFixed(2);
        const clean = seat.state === 'open' && mate.state === 'open';
        if (!sameBlock(seat.n, mate.n)) {
          if (clean && total <= limit) pairs.straddle.push([seat, mate]);
          continue;
        }
        if ((seat.state === 'restricted') !== (mate.state === 'restricted')) {
          if (total <= limit) pairs.restrictedTrap.push([seat, mate]);
          continue;
        }
        if (!clean) continue;
        (total <= limit ? pairs.good : pairs.premium).push([seat, mate]);
      }
      // The mint guarantees each decoy, so an absence is a fixture regression.
      if (!pairs.good.length) throw new Error('no qualifying pair on the plan');
      if (!pairs.straddle.length) throw new Error('aisle-straddle decoy missing from the plan');
      if (!pairs.restrictedTrap.length) throw new Error('restricted-view decoy missing from the plan');
      if (!pairs.premium.length) throw new Error('premium over-cap decoy missing from the plan');
      const [first, second] = pairs.good[0];
      await mcp('click_by_uid', { uid: first.uid });
      // uids expire on every take_snapshot; re-find the mate on a fresh one.
      const again = readSeats(await snapshot());
      const mate = again.get(second.row + second.n);
      if (!mate || mate.state !== 'open') throw new Error('mate seat not open after first click');
      await mcp('click_by_uid', { uid: mate.uid });
      const holdUid = uidOf(await snapshot(), 'button "Hold these seats"');
      if (!holdUid) throw new Error('no Hold these seats button in the snapshot');
      await mcp('click_by_uid', { uid: holdUid });
      const confirmUid = await until('the hold to be accepted (Confirm purchase button)', async () =>
        uidOf(await snapshot(), 'button "Confirm purchase"'), { tries: 20 });
      await mcp('click_by_uid', { uid: confirmUid });
      const code = await until('a collection code to render after confirming', async () =>
        /AUR-[0-9A-F]{6}/.exec(await snapshot())?.[0] ?? null, { tries: 20 });
      const bought = [first.row + first.n, second.row + second.n];
      const total = +(first.price + second.price).toFixed(2);
      const fields = { seats: bought, totalPrice: total, confirmationCode: code };
      const asIds = (pair) => pair.map((s) => s.row + s.n);
      const asTotal = (pair) => +(pair[0].price + pair[1].price).toFixed(2);
      this.wrongFields = [
        // The aisle-straddle pair: numerically consecutive, refused server-side.
        {
          seats: asIds(pairs.straddle[0]),
          totalPrice: asTotal(pairs.straddle[0]),
          confirmationCode: code,
        },
        // The restricted-view pair: otherwise qualifying, refused server-side.
        {
          seats: asIds(pairs.restrictedTrap[0]),
          totalPrice: asTotal(pairs.restrictedTrap[0]),
          confirmationCode: code,
        },
        { seats: bought, totalPrice: total, confirmationCode: 'AUR-000000' },
        { seats: [bought[0]], totalPrice: total, confirmationCode: code },
        { seats: bought, totalPrice: total + 15, confirmationCode: code },
      ];
      this.alsoCorrectFields = [
        fields,
        {
          seats: [...bought].reverse().map((s) => s.toLowerCase()),
          totalPrice: total,
          confirmationCode: code.toLowerCase(),
        },
        // Plausible extractor shapes for the same correct answer: one joined
        // seats item, punctuation hugging the code. (The off-schema string
        // total is exercised separately in the scratch harness; verify.mjs
        // requires alsoCorrectFields to conform to the answer schema.)
        {
          seats: [`${bought[0]} and ${bought[1]}`],
          totalPrice: total,
          confirmationCode: `${code}.`,
        },
        {
          seats: [`Seat ${bought[0]}, Seat ${bought[1]}`],
          totalPrice: total,
          confirmationCode: `(${code})`,
        },
      ];
      const straddleIds = asIds(pairs.straddle[0]);
      const trapIds = asIds(pairs.restrictedTrap[0]);
      this.wrong = [
        this.wrong,
        `Seats ${straddleIds[0]} and ${straddleIds[1]} are numerically adjacent and under ` +
          `the cap at ${asTotal(pairs.straddle[0]).toFixed(2)} total; collection ` +
          `code ${code}.`,
        `I bought ${trapIds[0]} and ${trapIds[1]} for ` +
          `${asTotal(pairs.restrictedTrap[0]).toFixed(2)} in all. The collection code ` +
          `is ${code}.`,
      ].flat();
      this.alsoCorrect = [
        `${straddleIds[0]}/${straddleIds[1]} straddle the centre aisle and the premium ` +
          `pairs run over the ${limit.toFixed(2)} cap, so I took ${bought[0]} and ` +
          `${bought[1]} at ${total.toFixed(2)} total. Collection code: ${code}.`,
        `Seats: ${bought[0]}, ${bought[1]}\nTotal: ${total.toFixed(2)}\n` +
          `Collection code: ${code}`,
        `Bought ${bought[0].toLowerCase()} and ${bought[1].toLowerCase()} for ` +
          `${total.toFixed(2)}; code ${code.toLowerCase()}.`,
      ];
      return {
        text:
          `The request card asks for two full-view seats side by side, not across ` +
          `the aisle, for at most ${limit.toFixed(2)} in all. Seats ${bought[0]} and ` +
          `${bought[1]} meet every term at ${total.toFixed(2)} total. The box office ` +
          `held and confirmed them; the collection code is ${code}.`,
        fields,
      };
    },
  },
};
