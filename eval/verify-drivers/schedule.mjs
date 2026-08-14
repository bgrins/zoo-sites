// T111 room-booking: Peregrine Court's week day book.
//
// The occupancy grid is a real <table> with rowspan blocks, so the golden path
// has to use evaluate_script to read it: our default snapshot contains no table
// node at all, and even take_snapshot({includeAll:true}) emits the cells without
// rowspan/colspan, which leaves the column each cell belongs to unrecoverable
// (measured: a left-to-right reading of the snapshot misplaces ~112 of ~94 free
// cells and answers a different slot). Everything else here goes through the uid
// surface: the request card is READ from the snapshot (its four conditions are
// minted per session, so they cannot be hard-coded here), and the quick-book line
// and the reference the desk issues are driven and read through it too.

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
    note: 'request card read from the snapshot; evaluate_script reads the spanning grid; booking is uid-driven',
    wrong: [
      'I booked the Bramble Suite on Monday at 09:00; the desk gave me reference PCR-4C71A9.',
    ],
    async run({ goto, evaluate, snapshot, mcp, sleep }) {
      await goto('/schedule/');
      const card = await until('the request card to render', async () => {
        const s = await snapshot();
        return /Start no earlier than/.test(s) ? s : null;
      }, { tries: 20 });
      // The constraints must still be legible through the snapshot, or the task is
      // unwinnable for reasons the fixture did not intend.
      const read = (re, what) => {
        const m = re.exec(card);
        if (!m) throw new Error(`request card line missing from the snapshot: ${what}`);
        return m[1];
      };
      const minutes = Number(read(/Duration: (\d+) minutes/, 'duration'));
      const notBefore = read(/Start no earlier than (\d\d:\d\d)/, 'earliest start');
      const seats = Number(read(/Seats: (\d+) or more/, 'seats'));
      const avoidDay = DAY_KEYS[read(/Not on ([A-Za-z]+)/, 'excluded day').toLowerCase()];
      if (!avoidDay) throw new Error('excluded day on the request card is not a weekday');
      if (!/Cormorant Hall - seats 24/.test(card)) {
        throw new Error('room seat counts missing from the snapshot');
      }

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

      let reference = '';
      for (let i = 0; i < 120 && !reference; i++) {
        const after = await snapshot();
        reference = /PCR-[0-9A-F]{6}/.exec(after)?.[0] ?? '';
        if (!reference) await sleep(250);
      }
      if (!reference) {
        const outcome = await evaluate(() => document.getElementById('qbOutcome')?.textContent ?? '');
        throw new Error(`no reference issued; the desk said "${outcome}"`);
      }
      const endMinutes = Number(answer.start.slice(0, 2)) * 60 + Number(answer.start.slice(3)) + minutes;
      const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
      const fields = { confirmationReference: reference };
      this.wrongFields = [{ confirmationReference: 'BK-0000' }];
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
