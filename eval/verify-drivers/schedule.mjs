// T111 room-booking: Peregrine Court's week day book.
//
// The occupancy grid is a real <table> with rowspan blocks, so the golden path
// has to use evaluate_script to read it: our default snapshot contains no table
// node at all, and even take_snapshot({includeAll:true}) emits the cells without
// rowspan/colspan, which leaves the column each cell belongs to unrecoverable
// (measured: a left-to-right reading of the snapshot misplaces ~112 of ~94 free
// cells and answers a different slot). The request card is read from the DOM too:
// its four conditions are minted per session, and they are written the way a
// booking desk writes them rather than trimmed to fit the snapshot's text cap.
// The quick-book line and the reference the desk issues stay on the uid surface.

import { bumpCode, until } from './lib.mjs';

const DAY_KEYS = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
};

export const DRIVERS = {
  'room-booking': {
    note: 'request card and spanning grid read with evaluate_script; booking is uid-driven',
    wrong: [
      'I booked the Bramble Suite on Monday at 09:00; the desk gave me reference PCR-4C71A9.',
    ],
    async run({ goto, evaluate, snapshot, mcp }) {
      await goto('/schedule/');
      // The card is read from the DOM, not the snapshot. Its conditions are
      // written the way a booking desk writes them and run past the snapshot's
      // text cap; whether a surface still delivers them is the result this eval
      // reports, so the driver must not demand it before going green.
      const cardText = async () =>
        String(
          (await evaluate(() => document.getElementById('briefTerms')?.innerText ?? '')) ?? ''
        );
      const card = await until('the request card to render', async () => {
        const t = await cardText();
        return /may start earlier than/.test(t) ? t : null;
      }, { tries: 20 });
      const read = (re, what) => {
        const m = re.exec(card);
        if (!m) throw new Error(`request card line missing: ${what} in ${JSON.stringify(card.slice(0, 300))}`);
        return m[1];
      };
      const minutes = Number(read(/runs for (\d+) minutes/, 'duration'));
      const notBefore = read(/may start earlier than (\d\d:\d\d)/, 'earliest start');
      const seats = Number(read(/must seat (\d+) people or more/, 'seats'));
      const avoidDay = DAY_KEYS[read(/([A-Za-z]+) is not available/, 'excluded day').toLowerCase()];
      if (!avoidDay) throw new Error('excluded day on the request card is not a weekday');

      const week = await evaluate(() => {
        const slots = [...document.querySelectorAll('#daybookBody tr th')].map((th) => th.textContent);
        const rooms = [...document.querySelectorAll('#roomList li')].map((li) => {
          const m = /^(.*) - seats (\d+)$/.exec(li.textContent);
          return { id: m[1].split(' ')[0].toLowerCase(), name: m[1], seats: Number(m[2]) };
        });
        const free = [...document.querySelectorAll('td.free')].map(
          (c) => `${c.dataset.day}|${c.dataset.room}|${c.dataset.start}`
        );
        return { slots, rooms, free };
      });
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      const free = new Set(week.free);
      const need = minutes / 30;
      const from = week.slots.indexOf(notBefore);
      const windows = [];
      days.forEach((day, d) => {
        if (day === avoidDay) return;
        for (let s = from; s + need <= week.slots.length; s++) {
          for (const room of week.rooms) {
            if (room.seats < seats) continue;
            let clear = true;
            for (let i = 0; i < need; i++) {
              if (!free.has(`${day}|${room.id}|${week.slots[s + i]}`)) clear = false;
            }
            if (clear) windows.push({ d, day, start: week.slots[s], room });
          }
        }
      });
      windows.sort((a, b) => a.d - b.d || week.slots.indexOf(a.start) - week.slots.indexOf(b.start));
      const answer = windows[0];
      if (!answer) throw new Error('no window in the week meets the request card');

      // uids expire on every take_snapshot, so read them from a fresh one.
      const fresh = await snapshot();
      const uid = (label) => {
        const m = new RegExp(`uid=(\\S+) (?:input|button) "${label}"`).exec(fresh);
        if (!m) throw new Error(`no "${label}" control in the snapshot`);
        return m[1];
      };
      await mcp('fill_by_uid', { uid: uid('Day'), value: answer.day });
      await mcp('fill_by_uid', { uid: uid('Start time'), value: answer.start });
      await mcp('fill_by_uid', { uid: uid('Room'), value: answer.room.name });
      await mcp('click_by_uid', { uid: uid('Request hold') });

      // No reference is on the page before the desk issues one, so the poll
      // cannot be satisfied by the state before the click.
      const reference = await until(
        'the desk to issue a reference',
        async () => /PCR-[0-9A-F]{6}/.exec(await snapshot())?.[0] ?? null,
        { tries: 120 }
      ).catch(() => '');
      if (!reference) {
        const outcome = await evaluate(() => document.getElementById('qbOutcome')?.textContent ?? '');
        throw new Error(`no reference issued; the desk said "${outcome}"`);
      }
      const endMinutes = Number(answer.start.slice(0, 2)) * 60 + Number(answer.start.slice(3)) + minutes;
      const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
      const fields = { confirmationReference: reference };
      this.wrongFields = [{ confirmationReference: bumpCode(reference) }];
      // A later slot that also fits the card is held without a reference, so
      // the confirmation on the session is the thing graded.
      this.wrongState = [
        {
          name: 'the booking was only held, never confirmed',
          mutate: (state) => {
            for (const s of state.sessions.values()) if (s.schedule) s.schedule.confirmed = null;
          },
        },
      ];
      this.alsoCorrectFields = [fields, { confirmationReference: String(reference).toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `The desk held ${answer.day} ${answer.start} in the ${answer.room.name} and ` +
          `quoted reference ${bumpCode(reference)}.`,
        `The earliest window that fits is ${answer.day} ${answer.start} in the ` +
          `${answer.room.name}; the quick-book line confirmed the hold, but no ` +
          `reference was displayed.`,
      ];
      this.alsoCorrect = [
        `Room: ${answer.room.name}\nSlot: ${answer.day} ${answer.start} to ${end}\n` +
          `Confirmation reference: ${reference}`,
        `Working from the card (${minutes} minutes, ${seats}+ seats, no start before ` +
          `${notBefore}, not on ${avoidDay}), the earliest fit is ${answer.day} ` +
          `${answer.start} in the ${answer.room.name}; the desk issued ${reference}.`,
        `Booked. The desk's confirmation reference is ` +
          `${String(reference).toLowerCase().replace('-', ' ')}.`,
      ];
      return {
        text:
          `The request card asks for ${minutes} minutes, seats for ${seats} or more, ` +
          `no start before ${notBefore} and not on ${avoidDay}. The earliest slot in the ` +
          `week that meets all four is ${answer.day} ${answer.start} to ${end} in the ` +
          `${answer.room.name} (${answer.room.seats} seats). Earlier gaps failed on one ` +
          `condition each: too small a room, the excluded day, too early a start, or ` +
          `thirty minutes too short. The desk confirmed it and issued reference ${reference}.`,
        fields,
      };
    },
  },
};
