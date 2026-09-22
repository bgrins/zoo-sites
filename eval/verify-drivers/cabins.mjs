// Golden path for the Tamarack Hollow booking calendar
// (pages/cabins/, task cabin-dates). See probes.mjs for the contract.
import { until, uidOf, snapText } from './lib.mjs';

const REF = /Reference (TH-[0-9A-F]{6})/;

const DAY = 86400000;
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const plus = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

// One calendar day in the forms the answer variants below write it in.
function dayParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const ordinal = [11, 12, 13].includes(d % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] ?? 'th';
  return {
    y, m, d,
    long: LONG_MONTHS[m - 1],
    short: LONG_MONTHS[m - 1].slice(0, 3),
    mm: String(m).padStart(2, '0'),
    dd: String(d).padStart(2, '0'),
    dow: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
    nth: `${d}${ordinal}`,
  };
}

export const DRIVERS = {
  'cabin-dates': {
    note:
      'reads the season grid off the day-button labels (maxLines raised: the two-month ' +
      'grid alone outruns the default 100-line snapshot), proves the open-celled trap Friday ' +
      'is refused with a named mid-stay blackout night, then books the target Friday through ' +
      'the hybrid order (typed check-in, clicked check-out cell) and reads the confirmation ' +
      'panel',
    async run({ goto, mcp, snapshot, evaluate }) {
      await goto('/cabins/');
      // The season is counted from the day the session opened (sites/cabins.mjs),
      // so every Friday the ask can mean is still ahead on whatever day the gate
      // runs: the window opens on the first of a later month and closes on the
      // last day of the month after it.
      const today = Math.floor(Date.now() / DAY) * DAY;
      const windowLine = await until('the booking window line', () =>
        evaluate(() => {
          const m = /Booking window: (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(
            document.getElementById('window-line').textContent
          );
          return m ? [m[1], m[2]] : null;
        })
      );
      const [from, to] = windowLine.map((s) => Date.parse(s));
      const opens = new Date(from);
      if (from <= today || opens.getUTCDate() !== 1) {
        throw new Error(`the booking window opens on ${windowLine[0]}, not the first of a month after today`);
      }
      if (to !== Date.UTC(opens.getUTCFullYear(), opens.getUTCMonth() + 2, 0)) {
        throw new Error(`the booking window closes on ${windowLine[1]}, not the end of the month after it opens`);
      }
      const season = dayParts(windowLine[0]);
      const seasonDays = (to - from) / DAY + 1;
      const grid = () => snapText(mcp, { maxLines: 400 });
      // The grids are drawn from the session-gated availability fetch; poll
      // until every day button of the window carries a state label. A label
      // names no year, so a month before the window's first falls in the next.
      const days = await until('the season grid to finish rendering', async () => {
        const s = await grid();
        const d = {};
        for (const m of s.matchAll(/button "(?:(\w{3}) )?(\w{3}) (\d{1,2}) - (open|blackout)"/g)) {
          const month = LONG_MONTHS.findIndex((name) => name.startsWith(m[2])) + 1;
          if (!month) continue;
          const y = month < season.m ? season.y + 1 : season.y;
          d[`${y}-${String(month).padStart(2, '0')}-${m[3].padStart(2, '0')}`] = { dow: m[1], state: m[4] };
        }
        return Object.keys(d).length === seasonDays ? d : null;
      });
      const unnamed = Object.keys(days).filter((iso) => !days[iso].dow);
      if (unnamed.length) {
        throw new Error(
          `${unnamed.length} day buttons name no weekday (e.g. ${unnamed[0]}); the grid's ` +
            `blank lead cells are invisible in a snapshot, so the weekday has to be in the name`
        );
      }
      // The first month's Fridays, asserted against the weekday the page names
      // on each day button. Reading the weekday off the surface is the
      // affordance the task depends on: an empty grid cell has no text, so the
      // blank lead cells that align the calendar reach no accessibility
      // snapshot, and an agent that infers a weekday from a day's position in
      // the grid lands as many columns out as the month has lead cells.
      const fridays = Object.keys(days).filter((iso) => days[iso].dow === 'Fri').sort();
      const expected = Array.from({ length: seasonDays }, (_, n) => plus(windowLine[0], n))
        .filter((iso) => new Date(iso).getUTCDay() === 5);
      if (fridays.join() !== expected.join()) {
        throw new Error(`the grid names ${fridays.join()} as the season's Fridays, not ${expected.join()}`);
      }
      const stayClear = (f) => [0, 1, 2, 3, 4].every((k) => days[plus(f, k)]?.state === 'open');
      const target = fridays.find(stayClear);
      if (!target) throw new Error('no Friday of the season can host a four-night stay');
      if (!fridays.slice(1, 4).includes(target)) {
        throw new Error(`the first clear Friday ${target} is not the second to fourth of the season`);
      }
      // The trap the fixture exists for: an earlier Friday whose own cell is
      // open, so only the server's re-check of the whole stay can refuse it.
      const trap = fridays.find((f) => f < target && days[f].state === 'open');
      if (trap === undefined) throw new Error('the mid-stay trap Friday is missing from the draw');
      const label = (iso) => {
        const p = dayParts(iso);
        return `${days[iso].dow} ${p.short} ${p.d} - ${days[iso].state}`;
      };
      const click = async (text) => {
        const u = uidOf(await grid(), `button "${text}"`);
        if (!u) throw new Error(`no control labelled "${text}" in the snapshot`);
        await mcp('click_by_uid', { uid: u });
      };
      // A blackout can sit on the trap stay's own check-out day, so take the
      // first open cell at four to six nights; any of them still crosses the
      // mid-stay blackout night.
      const trapOut = [4, 5, 6].map((n) => plus(trap, n)).find((d) => days[d]?.state === 'open');
      if (!trapOut) throw new Error('no open check-out cell for the trap stay');
      await click(label(trap));
      // The check-out morning is not a stay night, so once a check-in is
      // picked a later blackout day must be pickable as the check-out, as the
      // server accepts it; the mid-stay trap nights stay refused server-side.
      const blackoutAfter = [1, 2, 3, 4].map((n) => plus(trap, n)).find((d) => days[d]?.state === 'blackout');
      const pickable = await evaluate(
        `() => { const b = [...document.querySelectorAll('button.day')]
            .find((x) => x.getAttribute('aria-label') === ${JSON.stringify(blackoutAfter ? label(blackoutAfter) : '')});
          return b ? !b.disabled : null; }`
      );
      if (pickable !== true) {
        throw new Error(`blackout ${blackoutAfter} after a picked check-in is not pickable as the check-out (${pickable})`);
      }
      await click(label(trapOut));
      await click('Reserve the cabin');
      await until('the mid-stay trap booking to be refused', async () =>
        /Blackout night: [A-Z][a-z]{2} \d/.test(await snapshot()));
      const fill = async (text, value) => {
        const u = uidOf(await grid(), `input "${text}"`);
        if (!u) throw new Error(`no input labelled "${text}" in the snapshot`);
        await mcp('fill_by_uid', { uid: u, value });
      };
      // Now the real stay, booked in the hybrid order an agent may well use:
      // type the check-in (fill never fires change, so the page only learns of
      // it when onDay re-reads the inputs), then click the check-out cell.
      // Regression for the page bug where the click overwrote the typed date.
      await fill('Check-in date YYYY-MM-DD', target);
      await fill('Check-out date YYYY-MM-DD', '');
      await click(label(plus(target, 4)));
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
      if (checkIn !== target || checkOut !== plus(target, 4)) {
        throw new Error(`confirmation dates ${checkIn}..${checkOut} are not the target stay`);
      }
      const inDay = dayParts(checkIn);
      const outDay = dayParts(checkOut);
      const sat = dayParts(plus(target, 1));
      const satOut = dayParts(plus(target, 5));
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
          checkInDate: trap,
          checkOutDate: plus(trap, 4),
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
          checkOutDate: plus(target, 3),
          totalPrice: total,
          confirmationReference: reference,
        },
        // The Saturday after the target: with the grid's blank lead cells absent
        // from the snapshot, the Friday column reads one day late, which is the
        // off-by-one a snapshot-driven agent lands on.
        {
          checkInDate: plus(target, 1),
          checkOutDate: plus(target, 5),
          totalPrice: total,
          confirmationReference: reference,
        },
        // The same Saturday in the year-first and day-first numeric forms the
        // accepted variants below use, so their folding stays exact.
        {
          checkInDate: `${sat.y} ${sat.long} ${sat.d}`,
          checkOutDate: `${satOut.y} ${satOut.long} ${satOut.d}`,
          totalPrice: total,
          confirmationReference: reference,
        },
        {
          checkInDate: `${sat.d}/${sat.mm}/${sat.y}`,
          checkOutDate: `${satOut.d}/${satOut.mm}/${satOut.y}`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // The same Saturday with no year, which the validator reads in the
        // season's year.
        {
          checkInDate: `${sat.long} ${sat.d}`,
          checkOutDate: `${satOut.long} ${satOut.d}`,
          totalPrice: total,
          confirmationReference: reference,
        },
      ];
      this.alsoCorrectFields = [
        fields,
        {
          checkInDate: `${inDay.long} ${inDay.d}, ${inDay.y}`,
          checkOutDate: `${outDay.d} ${outDay.long} ${outDay.y}`,
          totalPrice: total,
          confirmationReference: reference.toLowerCase(),
        },
        // The "of" phrasing and slash-ISO, both real agent renderings the
        // validator's day() folding must keep accepting.
        {
          checkInDate: `the ${inDay.nth} of ${inDay.long} ${inDay.y}`,
          checkOutDate: `${outDay.y}/${outDay.mm}/${outDay.dd}`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // Year first with a month name, which must not read the last two
        // digits of the year as the day.
        {
          checkInDate: `${inDay.y} ${inDay.long} ${inDay.d}`,
          checkOutDate: `${outDay.y} ${outDay.short} ${outDay.d} (${outDay.dow})`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // Day first, as most of the world writes it.
        {
          checkInDate: `${inDay.d}/${inDay.mm}/${inDay.y}`,
          checkOutDate: `${outDay.d}/${outDay.mm}/${outDay.y}`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // Month first with a two-digit year.
        {
          checkInDate: `${inDay.m}/${inDay.d}/${String(inDay.y).slice(2)}`,
          checkOutDate: `${outDay.m}/${outDay.d}/${String(outDay.y).slice(2)}`,
          totalPrice: total,
          confirmationReference: reference,
        },
        // No year at all, as an answer about "the first Friday" often puts it.
        {
          checkInDate: `Friday ${inDay.d} ${inDay.long}`,
          checkOutDate: `${outDay.long} ${outDay.d}`,
          totalPrice: total,
          confirmationReference: reference,
        },
      ];
      // The day-first case above is ambiguous only when the day is 12 or under
      // and differs from the month, which on this draw it may not be, so a stay
      // is planted on such a day (the 11th, or the 10th in November) to read
      // day first on every run.
      const planted = (checkInIso, checkOutIso) => (state) => {
        for (const s of state.sessions.values()) {
          if (!s.cabins?.confirmed) continue;
          s.cabins.target = checkInIso;
          s.cabins.targetCheckOut = checkOutIso;
          s.cabins.confirmed.checkIn = checkInIso;
          s.cabins.confirmed.checkOut = checkOutIso;
        }
      };
      const early = season.m === 11 ? 10 : 11;
      const earlyIso = `${season.y}-${season.mm}-${early}`;
      this.alsoCorrectState = [
        {
          name: `a stay on the ${early}th written day first`,
          mutate: planted(earlyIso, plus(earlyIso, 4)),
          fields: {
            checkInDate: `${early}/${season.mm}/${season.y}`,
            checkOutDate: `${early + 4}/${season.mm}/${season.y}`,
            totalPrice: total,
            confirmationReference: reference,
          },
        },
        // A season can run into January, and an answer that names no year
        // still means the year each date falls in.
        {
          name: 'a stay that ends in the new year, written without years',
          mutate: planted(`${season.y}-12-30`, `${season.y + 1}-01-03`),
          fields: {
            checkInDate: '30 December',
            checkOutDate: '3 January',
            totalPrice: total,
            confirmationReference: reference,
          },
        },
      ];
      // A confirmed stay other than the asked one, reported exactly as the
      // server holds it, so only the tie to the first clear Friday and four
      // nights can refuse it.
      const rebooked = (checkInIso, nights) => (state) => {
        for (const s of state.sessions.values()) {
          if (!s.cabins?.confirmed) continue;
          Object.assign(s.cabins.confirmed, {
            checkIn: checkInIso,
            checkOut: plus(checkInIso, nights),
            nights,
            total: (total / 4) * nights,
          });
        }
      };
      const later = fridays.find((f) => f > target && stayClear(f)) ?? plus(target, 7);
      this.wrongState = [
        {
          name: 'the stay was never confirmed',
          mutate: (state) => {
            for (const s of state.sessions.values()) if (s.cabins) s.cabins.confirmed = null;
          },
        },
        {
          name: 'the confirmed stay starts on a later Friday',
          mutate: rebooked(later, 4),
          fields: {
            checkInDate: later,
            checkOutDate: plus(later, 4),
            totalPrice: total,
            confirmationReference: reference,
          },
        },
        {
          name: 'the confirmed stay starts on the target Friday but runs five nights',
          mutate: rebooked(target, 5),
          fields: {
            checkInDate: target,
            checkOutDate: plus(target, 5),
            totalPrice: (total / 4) * 5,
            confirmationReference: reference,
          },
        },
      ];
      this.wrong = [
        `I booked the cabin for four nights from ${fridays[0]} to ${plus(fridays[0], 4)}. ` +
          'The total quoted is £560 and the confirmation reference is TH-9C2D41.',
        `I booked four nights from ${trap} to ${plus(trap, 4)}. ` +
          `The total is £${total} and the confirmation reference is ${reference}.`,
        `Booked ${checkIn} to ${checkOut} at £${total - total / 4} total; ` +
          `reference ${reference}.`,
      ].flat();
      const trapDay = dayParts(trap);
      this.alsoCorrect = [
        `${trapDay.short} ${trapDay.d} shows an open cell, but the server refused that stay over a ` +
          `mid-stay blackout night, so the earliest workable Friday is ${checkIn}: ` +
          `booked through ${checkOut}, four nights, £${total} total, ` +
          `reference ${reference}.`,
        `Check-in: ${checkIn}\nCheck-out: ${checkOut}\nTotal: £${total}\n` +
          `Reference: ${reference}`,
        `Booked Friday ${inDay.long} ${inDay.d} through ${outDay.long} ${outDay.d}, ${outDay.y} ` +
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
