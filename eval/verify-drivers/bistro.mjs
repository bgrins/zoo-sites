// Golden-path driver for pages/bistro/ (order-modifiers). See probes.mjs for
// the contract.
import { addSession, bumpCode, findSession, snapText, straySession, uidOf, until } from './lib.mjs';

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
      // A stray curl session that builds a DIFFERENT ticket first and places
      // nothing: exploring the counter is not ordering, so it must not fail the
      // run, and the graded session must be the one that built the request.
      const stray = await straySession(h.base, '/bistro/order.html');
      const strayLine = await stray.post('/api/bistro/cart', { item: 'beet-flatbread', size: 'medium' });
      if (!strayLine.ok) throw new Error('stray probe could not build its decoy ticket');
      // An extra named after a prototype key must be refused, not priced as
      // undefined into a NaN ticket total.
      const protoAdd = await stray.post('/api/bistro/cart', { item: 'grain-bowl', added: ['__proto__'] });
      if (protoAdd.ok) throw new Error('an extra named __proto__ was accepted onto the ticket');

      await h.goto('/bistro/order.html');
      await waitFor(
        h,
        () => document.querySelectorAll('#dishes input').length >= 4,
        'dish radios'
      );
      // An empty ticket cannot be placed, and a dish is chosen by clicking its
      // name as well as its radio.
      const before = await h.evaluate(() => {
        const name = [...document.querySelectorAll('#dishes .cname')].find(
          (n) => n.textContent === 'Smoked Tomato Bisque'
        );
        name?.click();
        const radio = [...document.querySelectorAll('#dishes input')].find(
          (i) => i.getAttribute('aria-label') === 'Smoked Tomato Bisque'
        );
        return {
          placeDisabled: document.getElementById('place').disabled,
          nameSelects: !!radio?.checked && !document.getElementById('config').hidden,
        };
      });
      if (!before.placeDisabled) throw new Error('Place order is live on an empty ticket');
      if (!before.nameSelects) throw new Error('clicking a dish name does not choose the dish');
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
      // The chips are read from the DOM. Whether they also survive the snapshot
      // is the result this eval reports, so the driver must not require it.
      const chips = String(
        (await h.evaluate(() => document.body.innerText)) ?? ''
      );
      if (!chips.includes('no Red onion') || !chips.includes('add Feta')) {
        throw new Error(`ticket chips for line 1 are missing from the page`);
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
      // Read the confirmation back off the page and require it to agree with
      // what the server recorded. Whether the snapshot also carries it is the
      // measurement, not a precondition for the fixture being correct.
      const confText = String((await h.evaluate(() => document.body.innerText)) ?? '');
      const shownCode = confText.match(/Order code (BF-[0-9A-F]{6})/);
      if (!shownCode || shownCode[1] !== conf.code) {
        throw new Error(`order code missing from the confirmation page`);
      }
      if (!confText.includes(`Total due at pickup $${conf.total.toFixed(2)}`)) {
        throw new Error('total due missing from the confirmation page');
      }
      const after = await h.evaluate(() => ({
        placeDisabled: document.getElementById('place').disabled,
        buildmsg: document.getElementById('buildmsg').textContent,
      }));
      if (!after.placeDisabled || after.buildmsg) {
        throw new Error(`after the order the builder still reads "${after.buildmsg}" and Place order is ${after.placeDisabled ? 'off' : 'live'}`);
      }

      const fields = { orderCode: conf.code, total: conf.total };
      const bumped = bumpCode(conf.code);
      this.wrongFields = [
        { orderCode: conf.code, total: round2(conf.total - fetaSurcharge) },
        { orderCode: conf.code, total: round2(conf.total - largeUpcharge) },
        { orderCode: bumped, total: conf.total },
        { orderCode: conf.code, total: round2(conf.total + 1) },
        { orderCode: `**${bumped}**`, total: conf.total },
      ];
      this.alsoCorrectFields = [
        fields,
        { orderCode: conf.code.toLowerCase(), total: conf.total },
        { orderCode: `**${conf.code}**`, total: conf.total },
        { orderCode: `${conf.code}.`, total: conf.total },
      ];
      const reported = (state) =>
        findSession(state, (s) => s.bistro?.orders?.some((o) => o.code === conf.code)).session;
      // The wrong ticket an unchecked build places: the flatbread at medium with
      // its red onion kept, beside the right bowl.
      const wrongOrder = (state) => {
        const [placed] = reported(state).bistro.orders;
        return {
          code: bumped,
          total: round2(conf.total - largeUpcharge),
          lines: placed.lines.map((l) =>
            l.item === 'beet-flatbread' ? { ...l, size: 'medium', removed: [] } : l
          ),
          placedAt: placed.placedAt - 60000,
        };
      };
      // The one placed order's flatbread line rewritten, so the single-ticket
      // count holds and only the modifier check can refuse it.
      const rebuildFlatbread = (state, change) => {
        const [placed] = reported(state).bistro.orders;
        placed.lines = placed.lines.map((l) => (l.item === 'beet-flatbread' ? { ...l, ...change(l) } : l));
        return placed;
      };
      this.wrongState = [
        {
          name: 'the only order kept the red onion on the flatbread',
          mutate: (state) => rebuildFlatbread(state, () => ({ removed: [] })),
        },
        {
          name: 'the only order left the feta off the flatbread, and the answer reports its total',
          mutate(state) {
            const placed = rebuildFlatbread(state, (l) => ({ added: l.added.filter((a) => a !== 'feta') }));
            placed.total = round2(conf.total - fetaSurcharge);
          },
          fields: { orderCode: conf.code, total: round2(conf.total - fetaSurcharge) },
        },
        {
          name: 'the reported session placed a wrong ticket before the right one',
          mutate: (state) => reported(state).bistro.orders.unshift(wrongOrder(state)),
        },
        {
          name: 'the reported session placed the same order twice',
          mutate(state) {
            const { orders } = reported(state).bistro;
            orders.push({ ...structuredClone(orders[0]), code: bumped });
          },
        },
        {
          name: 'an earlier session placed a wrong ticket',
          mutate: (state) =>
            addSession(state, { bistro: { cart: [], orders: [wrongOrder(state)], rejects: [] } }, { first: true }),
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'an earlier session built the same ticket and placed nothing',
          mutate: (state) =>
            addSession(
              state,
              { bistro: { cart: structuredClone(reported(state).bistro.orders[0].lines), orders: [], rejects: [] } },
              { first: true }
            ),
        },
      ];
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
          `and the exact total due is $${conf.total.toFixed(2)}.`,
        fields,
      };
    },
  },
};
