// Golden path for the Tamarack Hollow booking calendar
// (pages/cabins/, task cabin-dates). See probes.mjs for the contract.
import { until, uidOf, snapText } from './lib.mjs';

const REF = /Reference (TH-[0-9A-F]{6})/;

// The Fridays of September 2026, asserted against the weekday the page names on
// each day button. Nothing here hardcodes the list, because reading the weekday
// off the surface is the affordance the task depends on: an empty grid cell has no
// text, so the blank lead cells that align the calendar reach no accessibility
// snapshot, and an agent that infers a weekday from a day's position in the grid
// lands one column out. September 2026 starts on a Tuesday, so that error is
// exactly one day.
const EXPECTED_FRIDAYS = [4, 11, 18, 25];

const cabinIso = (d) => `2026-09-${String(d).padStart(2, '0')}`;

export const DRIVERS = {
  'cabin-dates': {
    note:
      'reads the September grid off the day-button labels (maxLines raised: the two-month ' +
      'grid alone outruns the default 100-line snapshot), proves the open-celled trap Friday ' +
      'is refused with a named mid-stay blackout night, then books the target Friday through ' +
      'the hybrid order (typed check-in, clicked check-out cell) and reads the confirmation ' +
      'panel',
    wrong:
      'I booked the cabin for four nights from 2026-09-04 to 2026-09-08. ' +
      'The total quoted is £560 and the confirmation reference is TH-9C2D41.',
    async run({ goto, mcp, snapshot, evaluate }) {
      await goto('/cabins/');
      const grid = () => snapText(mcp, { maxLines: 400 });
      // The grids are drawn from the session-gated availability fetch; poll
      // until all thirty September day buttons carry a state label.
      const days = await until('the September grid to finish rendering', async () => {
        const s = await grid();
        const d = {};
        for (const m of s.matchAll(/button "(?:(\w{3}) )?Sep (\d{1,2}) - (open|blackout)"/g)) {
          d[Number(m[2])] = { dow: m[1], state: m[3] };
        }
        return Object.keys(d).length === 30 ? d : null;
      });
      const unnamed = Object.keys(days).filter((n) => !days[n].dow);
      if (unnamed.length) {
        throw new Error(
          `${unnamed.length} day buttons name no weekday (e.g. Sep ${unnamed[0]}); the grid's ` +
            `blank lead cells are invisible in a snapshot, so the weekday has to be in the name`
        );
      }
      const fridays = Object.keys(days)
        .map(Number)
        .filter((n) => days[n].dow === 'Fri')
        .sort((a, b) => a - b);
      if (fridays.join() !== EXPECTED_FRIDAYS.join()) {
        throw new Error(
          `the grid names ${fridays.join()} as September's Fridays, not ${EXPECTED_FRIDAYS.join()}`
        );
      }
      const stayClear = (f) => [0, 1, 2, 3, 4].every((k) => days[f + k]?.state === 'open');
      const target = fridays.find(stayClear);
      if (!target) throw new Error('no September Friday can host a four-night stay');
      // The trap the fixture exists for: an earlier Friday whose own cell is
      // open, so only the server's re-check of the whole stay can refuse it.
      const trap = fridays.find((f) => f < target && days[f].state === 'open');
      if (trap === undefined) throw new Error('the mid-stay trap Friday is missing from the draw');
      const click = async (label) => {
        const u = uidOf(await grid(), `button "${label}"`);
        if (!u) throw new Error(`no control labelled "${label}" in the snapshot`);
        await mcp('click_by_uid', { uid: u });
      };
      // A blackout can sit on the trap stay's own check-out day, so take the
      // first open cell at four to six nights; any of them still crosses the
      // mid-stay blackout night.
      const trapOut = [4, 5, 6].map((n) => trap + n).find((d) => days[d]?.state === 'open');
      if (!trapOut) throw new Error('no open check-out cell for the trap stay');
      await click(`${days[trap].dow} Sep ${trap} - open`);
      // The check-out morning is not a stay night, so once a check-in is
      // picked a later blackout day must be pickable as the check-out, as the
      // server accepts it; the mid-stay trap nights stay refused server-side.
      const blackoutAfter = [1, 2, 3, 4].map((n) => trap + n).find((d) => days[d]?.state === 'blackout');
      const pickable = await evaluate(
        `() => { const b = [...document.querySelectorAll('button.day')]
            .find((x) => x.getAttribute('aria-label') === '${days[blackoutAfter]?.dow} Sep ${blackoutAfter} - blackout');
          return b ? !b.disabled : null; }`
      );
      if (pickable !== true) {
        throw new Error(`blackout Sep ${blackoutAfter} after a picked check-in is not pickable as the check-out (${pickable})`);
      }
      await click(`${days[trapOut].dow} Sep ${trapOut} - open`);
      await click('Reserve the cabin');
      await until('the mid-stay trap booking to be refused', async () =>
        /Blackout night: (Sep|Oct) \d/.test(await snapshot()));
      const fill = async (label, value) => {
        const u = uidOf(await grid(), `input "${label}"`);
        if (!u) throw new Error(`no input labelled "${label}" in the snapshot`);
        await mcp('fill_by_uid', { uid: u, value });
      };
      // Now the real stay, booked in the hybrid order an agent may well use:
      // type the check-in (fill never fires change, so the page only learns of
      // it when onDay re-reads the inputs), then click the check-out cell.
      // Regression for the page bug where the click overwrote the typed date.
      await fill('Check-in date YYYY-MM-DD', cabinIso(target));
      await fill('Check-out date YYYY-MM-DD', '');
      await click(`${days[target + 4].dow} Sep ${target + 4} - open`);
      await click('Reserve the cabin');
      let snap = '';
      const found = await until('a confirmation reference to appear after booking', async () => {
        snap = await snapshot();
        return snap.match(REF);
      });
      const reference = found[1];
      const total = Number(snap.match(/Total £(\d+) for 4 nights/)?.[1]);
      const checkIn = snap.match(/Check-in (\d{4}-\d{2}-\d{2})/)?.[1];
      const checkOut = snap.match(/Check-out (\d{4}-\d{2}-\d{2})/)?.[1];
      if (!checkIn || !checkOut || !Number.isFinite(total)) {
        throw new Error('the confirmation panel is missing a graded line');
      }
      if (checkIn !== cabinIso(target) || checkOut !== cabinIso(target + 4)) {
        throw new Error(`confirmation dates ${checkIn}..${checkOut} are not the target stay`);
      }
      const fields = {
        checkInDate: checkIn,
        checkOutDate: checkOut,
        totalPrice: total,
        confirmationReference: reference,
      };
      this.wrongFields = [
        // The naive answer: the open-celled trap Friday, quoted with the real
        // total and reference.
        {
          checkInDate: cabinIso(trap),
          checkOutDate: cabinIso(trap + 4),
          totalPrice: total,
          confirmationReference: reference,
        },
        {
          checkInDate: checkIn,
          checkOutDate: checkOut,
          totalPrice: total,
          confirmationReference: 'TH-000000',
        },
        // A three-night total (total is 4 x rate, so this subtracts one night).
        {
          checkInDate: checkIn,
          checkOutDate: checkOut,
          totalPrice: total - total / 4,
          confirmationReference: reference,
        },
        // Off-by-one check-out: a three-night stay reported over the right start.
        {
          checkInDate: checkIn,
          checkOutDate: cabinIso(target + 3),
          totalPrice: total,
          confirmationReference: reference,
        },
        // The Saturday after the target: with the grid's blank lead cells absent
        // from the snapshot, the Friday column reads one day late, which is the
        // off-by-one a snapshot-driven agent lands on.
        {
          checkInDate: cabinIso(target + 1),
          checkOutDate: cabinIso(target + 5),
          totalPrice: total,
          confirmationReference: reference,
        },
        // The same Saturday in the year-first and day-first numeric forms the
        // accepted variants below use, so their folding stays exact.
        {
          checkInDate: `2026 September ${target + 1}`,
          checkOutDate: `2026 September ${target + 5}`,
          totalPrice: total,
          confirmationReference: reference,
        },
        {
          checkInDate: `${target + 1}/09/2026`,
          checkOutDate: `${target + 5}/09/2026`,
          totalPrice: total,
          confirmationReference: reference,
        },
      ];
      this.alsoCorrectFields = [
        fields,
        {
          checkInDate: `September ${target}, 2026`,
          checkOutDate: `${target + 4} September 2026`,
          totalPrice: total,
          confirmationReference: reference.toLowerCase(),
        },
        // The "of" phrasing and slash-ISO, both real agent renderings the
        // validator's day() folding must keep accepting.
        {
          checkInDate: `the ${target}th of September 2026`,
          checkOutDate: `2026/09/${String(target + 4).padStart(2, '0')}`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // Year first with a month name, which must not read the 26 of 2026
        // as the day.
        {
          checkInDate: `2026 September ${target}`,
          checkOutDate: `2026 Sep ${target + 4} (${days[target + 4].dow})`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // Day first, as most of the world writes it: 11/09/2026 is 11 September.
        {
          checkInDate: `${target}/09/2026`,
          checkOutDate: `${target + 4}/09/2026`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // Month first with a two-digit year.
        {
          checkInDate: `9/${target}/26`,
          checkOutDate: `9/${target + 4}/26`,
          totalPrice: total,
          confirmationReference: reference,
        },
      ];
      // The day-first case above is ambiguous only when the day is 12 or under,
      // which on this draw it may not be, so a stay on the 11th is planted to
      // read 11/09/2026 as 11 September on every run.
      this.alsoCorrectState = [
        {
          name: 'a stay on the 11th written day first',
          mutate: (state) => {
            for (const s of state.sessions.values()) {
              if (!s.cabins?.confirmed) continue;
              s.cabins.target = '2026-09-11';
              s.cabins.targetCheckOut = '2026-09-15';
              s.cabins.confirmed.checkIn = '2026-09-11';
              s.cabins.confirmed.checkOut = '2026-09-15';
            }
          },
          fields: {
            checkInDate: '11/09/2026',
            checkOutDate: '15/09/2026',
            totalPrice: total,
            confirmationReference: reference,
          },
        },
      ];
      this.wrongState = [
        {
          name: 'the stay was never confirmed',
          mutate: (state) => {
            for (const s of state.sessions.values()) if (s.cabins) s.cabins.confirmed = null;
          },
        },
      ];
      this.wrong = [
        this.wrong,
        `I booked four nights from ${cabinIso(trap)} to ${cabinIso(trap + 4)}. ` +
          `The total is £${total} and the confirmation reference is ${reference}.`,
        `Booked ${checkIn} to ${checkOut} at £${total - total / 4} total; ` +
          `reference ${reference}.`,
      ].flat();
      this.alsoCorrect = [
        `Sep ${trap} shows an open cell, but the server refused that stay over a ` +
          `mid-stay blackout night, so the earliest workable Friday is ${checkIn}: ` +
          `booked through ${checkOut}, four nights, £${total} total, ` +
          `reference ${reference}.`,
        `Check-in: ${checkIn}\nCheck-out: ${checkOut}\nTotal: £${total}\n` +
          `Reference: ${reference}`,
        `Booked Friday September ${target} through September ${target + 4}, 2026 ` +
          `for £${total}; the confirmation reference is ${reference.toLowerCase()}.`,
      ];
      return {
        text:
          `I booked the cabin for four nights starting Friday ${checkIn} ` +
          `(check-out ${checkOut}). The quoted total is £${total} and the ` +
          `confirmation reference is ${reference}.`,
        fields,
      };
    },
  },
};
