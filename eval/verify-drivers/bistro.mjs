// Golden-path driver for pages/bistro/ (order-modifiers). See probes.mjs for
// the contract.
import { straySession } from './probes.mjs';
import { until, uidOf, snapText, bumpCode } from './lib.mjs';

// The ticket column and the Place order button sit past the default 100-line
// snapshot cap once both builder and ticket are populated (and `firefox-cli
// snapshot` exposes no --maxLines at all), so every snapshot here asks for
// more via the tool argument.
const SNAP_LINES = 300;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const snapshot = (h) => snapText(h.mcp, { maxLines: SNAP_LINES });

function uid(snap, pattern, label) {
  const u = uidOf(snap, pattern);
  if (!u) throw new Error(`no snapshot node for ${label ?? pattern}`);
  return u;
}

// Poll instead of sleeping: the page paints from fetches and every control
// re-render invalidates uids, so a fixed wait is a coin flip on a cold start.
const waitFor = (h, fn, label, tries = 50) =>
  until(label, () => h.evaluate(fn), { tries, gap: 200 });

export const DRIVERS = {
  // --- per-line modifier cart; the no-red-onion removal is server state ---
  'order-modifiers': {
    note: 'derives the upcharge and surcharge deltas from the echo line itself',
    wrong: ['The order was placed. Order code BF-000000, total charged $28.95.'],
    async run(h, ctx) {
      // A stray curl session that places a DIFFERENT ticket first: the graded
      // session must be the one that built the requested order, and the stray
      // order's code and total must be rejected as an answer.
      const stray = await straySession(h.base, '/bistro/order.html');
      await stray.post('/api/bistro/cart', { item: 'beet-flatbread', size: 'medium' });
      const strayOrder = await stray.post('/api/bistro/order', {});
      if (!strayOrder.ok) throw new Error('stray probe could not place its decoy order');

      await h.goto('/bistro/order.html');
      await waitFor(
        h,
        () => document.querySelectorAll('#dishes input').length >= 4,
        'dish radios'
      );
      let snap = await snapshot(h);
      await h.mcp('click_by_uid', {
        uid: uid(snap, 'input "Charred Beet Flatbread"', 'flatbread radio'),
      });
      const medium = await waitFor(
        h,
        () => {
          const line = document.getElementById('buildline');
          if (!line || !line.innerText.includes('Charred Beet Flatbread')) return false;
          const chips = [...line.querySelectorAll('.chip')].map((c) => c.textContent.trim());
          const m = chips[chips.length - 1]?.match(/^\$(\d+\.\d\d)$/);
          return m ? { chips, price: Number(m[1]) } : false;
        },
        'flatbread medium build line'
      );

      // The builder re-renders on dish selection, so re-snapshot for the size
      // and modifier controls.
      snap = await snapshot(h);
      await h.mcp('click_by_uid', { uid: uid(snap, 'input "Large"', 'Large radio') });
      const large = await waitFor(
        h,
        `() => { const line = document.getElementById('buildline');
          const chips = [...line.querySelectorAll('.chip')].map((c) => c.textContent.trim());
          if (chips[0] !== 'Large') return false;
          const m = chips[chips.length - 1]?.match(/^\\$(\\d+\\.\\d\\d)$/);
          return m ? Number(m[1]) : false; }`,
        'large-size echo'
      );
      const largeUpcharge = round2(large - medium.price);

      await h.mcp('click_by_uid', { uid: uid(snap, 'input "Feta"', 'Feta checkbox') });
      const withFeta = await waitFor(
        h,
        `() => { const line = document.getElementById('buildline');
          const chips = [...line.querySelectorAll('.chip')].map((c) => c.textContent.trim());
          if (!chips.includes('add Feta')) return false;
          const m = chips[chips.length - 1]?.match(/^\\$(\\d+\\.\\d\\d)$/);
          return m ? Number(m[1]) : false; }`,
        'add-feta echo'
      );
      const fetaSurcharge = round2(withFeta - large);
      if (fetaSurcharge <= 0) throw new Error(`feta surcharge read as ${fetaSurcharge}`);

      await h.mcp('click_by_uid', {
        uid: uid(snap, 'input "Red onion"', 'Red onion checkbox'),
      });
      const line1 = await waitFor(
        h,
        `() => { const line = document.getElementById('buildline');
          const chips = [...line.querySelectorAll('.chip')].map((c) => c.textContent.trim());
          if (!chips.includes('no Red onion')) return false;
          const m = chips[chips.length - 1]?.match(/^\\$(\\d+\\.\\d\\d)$/);
          return m ? Number(m[1]) : false; }`,
        'no-red-onion echo'
      );
      if (line1 !== withFeta) {
        throw new Error(`leaving red onion off changed the price: ${withFeta} -> ${line1}`);
      }
      await h.mcp('click_by_uid', {
        uid: uid(snap, 'button "Add to ticket"', 'add to ticket'),
      });
      await waitFor(
        h,
        () => document.querySelectorAll('#ticket li').length === 1,
        'first ticket line'
      );

      snap = await snapshot(h);
      // The chips are the designed read path (checkbox state never reaches the
      // snapshot), so the fixture must keep them snapshot-legible.
      if (!snap.includes('no Red onion') || !snap.includes('add Feta')) {
        throw new Error('ticket chips for line 1 are not legible in the snapshot');
      }
      await h.mcp('click_by_uid', {
        uid: uid(snap, 'input "Harvest Grain Bowl"', 'grain bowl radio'),
      });
      await waitFor(
        h,
        () => document.getElementById('buildline')?.innerText.includes('Harvest Grain Bowl'),
        'grain bowl build line'
      );
      snap = await snapshot(h);
      await h.mcp('click_by_uid', {
        uid: uid(snap, 'input "Smoked almonds"', 'Smoked almonds checkbox'),
      });
      const line2 = await waitFor(
        h,
        `() => { const line = document.getElementById('buildline');
          const chips = [...line.querySelectorAll('.chip')].map((c) => c.textContent.trim());
          if (chips[0] !== 'Medium' || !chips.includes('add Smoked almonds')) return false;
          const m = chips[chips.length - 1]?.match(/^\\$(\\d+\\.\\d\\d)$/);
          return m ? Number(m[1]) : false; }`,
        'add-smoked-almonds echo'
      );
      await h.mcp('click_by_uid', {
        uid: uid(snap, 'button "Add to ticket"', 'add to ticket'),
      });
      const ticket = await waitFor(
        h,
        () => {
          const lines = [...document.querySelectorAll('#ticket li')].map((li) =>
            [...li.querySelectorAll('.chip')].map((c) => c.textContent.trim()).join(' | ')
          );
          if (lines.length !== 2) return false;
          const m = document.getElementById('tickettotal').textContent.match(/\$(\d+\.\d\d)/);
          return m ? { lines, total: Number(m[1]) } : false;
        },
        'two ticket lines and a total'
      );
      if (!ticket.lines[0].includes('no Red onion') || !ticket.lines[0].includes('add Feta')) {
        throw new Error(`ticket line 1 lost its modifiers: ${ticket.lines[0]}`);
      }
      if (ticket.total !== round2(line1 + line2)) {
        throw new Error(`ticket total ${ticket.total} != ${line1} + ${line2}`);
      }

      snap = await snapshot(h);
      await h.mcp('click_by_uid', {
        uid: uid(snap, 'button "Place order"', 'place order'),
      });
      const conf = await waitFor(
        h,
        () => {
          const code = document.getElementById('confcode')?.textContent ?? '';
          const total = document.getElementById('conftotal')?.textContent ?? '';
          const cm = code.match(/Order code (BF-[0-9A-F]{6})/);
          const tm = total.match(/\$(\d+\.\d\d)/);
          return cm && tm ? { code: cm[1], total: Number(tm[1]) } : false;
        },
        'order confirmation'
      );
      if (conf.total !== ticket.total) {
        throw new Error(`confirmation total ${conf.total} != ticket total ${ticket.total}`);
      }
      // The confirmation must stay snapshot-legible at maxLines: read the code
      // and total back off a fresh snapshot and require them to agree.
      const confSnap = await snapshot(h);
      const snapCode = confSnap.match(/Order code (BF-[0-9A-F]{6})/);
      if (!snapCode || snapCode[1] !== conf.code) {
        throw new Error('order code is not legible in the confirmation snapshot');
      }
      if (!confSnap.includes(`Total charged $${conf.total.toFixed(2)}`)) {
        throw new Error('total charged is not legible in the confirmation snapshot');
      }

      const fields = { orderCode: conf.code, total: conf.total };
      const bumped = bumpCode(conf.code);
      this.wrongFields = [
        { orderCode: conf.code, total: round2(conf.total - fetaSurcharge) },
        { orderCode: conf.code, total: round2(conf.total - largeUpcharge) },
        { orderCode: bumped, total: conf.total },
        { orderCode: conf.code, total: round2(conf.total + 1) },
        { orderCode: strayOrder.code, total: strayOrder.total },
      ];
      this.alsoCorrectFields = [fields, { orderCode: conf.code.toLowerCase(), total: conf.total }];
      this.wrong = [
        this.wrong[0],
        `Order placed. The code is ${conf.code} and the total charged was ` +
          `$${round2(conf.total - fetaSurcharge).toFixed(2)}.`,
      ];
      this.alsoCorrect = [
        `Both dishes are on the ticket exactly as asked - the flatbread large with feta ` +
          `and without the red onion, the bowl medium with smoked almonds. Order code ` +
          `${conf.code.toLowerCase()}; the counter will charge $${conf.total.toFixed(2)}.`,
      ];
      return {
        text:
          `I placed the order: a large Charred Beet Flatbread with feta added and the red ` +
          `onion left off ($${line1.toFixed(2)}), and a medium Harvest Grain Bowl with ` +
          `smoked almonds added ($${line2.toFixed(2)}). The order code is ${conf.code} ` +
          `and the exact total charged is $${conf.total.toFixed(2)}.`,
        fields,
      };
    },
  },
};
