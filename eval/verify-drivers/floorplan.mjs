// Golden paths for pages/floorplan/ (T069). See probes.mjs for the contract.

import { uidOf } from './lib.mjs';

export const DRIVERS = {
  // --- inline-SVG region clicking: the plan's rooms are <rect> nodes ---
  'floorplan-room': {
    note: 'clicks SVG <rect> regions by uid; snapshot names them only because they carry aria-label',
    wrong: 'The north-east corner office on Level 04 is occupied by Tobin Radleigh.',
    async run({ goto, snapshot, mcp, sleep }) {
      await goto('/floorplan/');
      // The sheet is drawn with plan north to the LEFT, and the snapshot carries
      // no geometry at all, so the orientation has to be read as text. The long
      // sentence under the sheet is past the snapshot's 27-char text cap, so the
      // page also carries a short key line that survives it.
      const first = await snapshot();
      if (!/text="Plan north: left"/.test(first)) {
        throw new Error('orientation key line missing from the snapshot');
      }

      // Read the space record out of the SNAPSHOT (not a script): the drawer
      // lines are short and front-loaded on purpose, so the whole task is
      // winnable through take_snapshot + click_by_uid. Deliberately NOT the
      // shared until(): a missed click has to be re-issued, so the outer loop
      // re-clicks up to three times with its own inner poll.
      const readRecord = async (room) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const snap = await snapshot();
          const region = uidOf(snap, `button "Room ${room}"`);
          if (!region) throw new Error(`no snapshot region for room ${room}`);
          await mcp('click_by_uid', { uid: region });
          for (let poll = 0; poll < 15; poll++) {
            await sleep(200);
            const after = await snapshot();
            const lines = after.split('\n');
            const at = lines.findIndex((l) => l.includes(`text="Room ${room}"`));
            if (at === -1) continue;
            const fields = lines
              .slice(at + 1, at + 8)
              .map((l) => l.match(/text="([^"]*)"/)?.[1] ?? '')
              .filter(Boolean);
            if (fields.length >= 3) return { occupant: fields[0], role: fields[1], kind: fields[2] };
          }
        }
        throw new Error(`space record for ${room} never rendered in the snapshot`);
      };

      // Both north-east rooms: the codes say which quadrant a room is in, but
      // only the space record says which of them is the corner office.
      const ne3 = await readRecord('NE-3');
      const ne4 = await readRecord('NE-4');
      if (/corner office/i.test(ne3.kind)) {
        throw new Error(`NE-3 should not be a corner office; record says "${ne3.kind}"`);
      }
      if (!/corner office/i.test(ne4.kind)) {
        throw new Error(`NE-4 is not classified as a corner office; record says "${ne4.kind}"`);
      }
      if (!/\S+\s+\S+/.test(ne4.occupant)) {
        throw new Error(`no occupant name in the NE-4 record; read "${ne4.occupant}"`);
      }
      const initialled = `${ne4.occupant[0]}. ${ne4.occupant.split(' ').pop()}`;
      const fields = { occupantName: ne4.occupant, roomCode: 'NE-4' };
      this.wrongFields = [
        { occupantName: ne3.occupant, roomCode: 'NE-3' },
        { occupantName: ne3.occupant, roomCode: 'NE-4' },
      ];
      this.alsoCorrectFields = [
        fields,
        { occupantName: initialled, roomCode: 'NE-4' },
      ];
      this.wrong = [
        `The north-east corner office on Level 04 is occupied by ${ne3.occupant}.`,
        `The corner office in the north-east is room NE-3; its space record ` +
          `lists ${ne3.occupant}.`,
      ];
      this.alsoCorrect = [
        `Plan north is to the left, so the NE corner of the building is the ` +
          `top-left region of the sheet: room NE-4, occupied by ${ne4.occupant}.`,
        `Room code: NE-4\nOccupant: ${ne4.occupant}`,
        `${initialled} has the corner office, NE-4.`,
      ];
      return {
        text:
          `The sheet is drawn with plan north to the left, so the north-east corner of the ` +
          `building is the top-left region: room NE-4. Its space record gives the occupant as ` +
          `${ne4.occupant}, ${ne4.role}. The other north-east room, NE-3, is a plain office ` +
          `(${ne3.occupant}), not the corner office.`,
        fields,
      };
    },
  },
};
