// Golden path for the Verlan Transit ticket kiosk (pages/kiosk/, task
// palette-checkout). See probes.mjs for the contract.
import { until, uidOf, bumpCode } from './lib.mjs';

const CODE = /span text="(VT-[0-9A-F]{8})"/;
const FARE = /span text="\$(\d+\.\d\d)"/;

export const DRIVERS = {
  'palette-checkout': {
    note:
      'exercises BOTH viable key channels: step 1 commits with fill_by_uid (trusted per-char ' +
      'keydowns hitting the quick-code handler), steps 2-3 with synthetic ArrowDown/Enter ' +
      'KeyboardEvents via evaluate (the document keydown handler). Native submit-on-Enter does ' +
      'not exist on the page; there is no form',
    async run({ goto, mcp, evaluate, snapshot }) {
      await goto('/kiosk/');
      let snap = await snapshot();
      const input = uidOf(snap, 'input "Keypad entry"');
      if (!input) throw new Error('the Keypad entry input is not in the snapshot');

      // Channel 1: fill types trusted per-char keydowns; the exact quick code
      // commits through the page's input handler. The commit clears the field,
      // so tolerate a fill error and let the step-change poll be the judge.
      await mcp('fill_by_uid', { uid: input, value: '11' }).catch(() => {});
      await until('quick code 11 to advance the kiosk to the zones step', async () => {
        snap = await snapshot();
        return /h1 "Select zones"/.test(snap) && /span text="Zone 1 only"/.test(snap);
      });

      // Channel 2: synthetic keys. The keydown handler lives on document, so
      // dispatching there is enough; one ArrowDown moves the highlight from
      // Zone 1 only to Zones 1-2, Enter commits it.
      const key = (k) =>
        evaluate(
          `() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }));
            return document.getElementById('hl').textContent;
          }`
        );
      const hl = await key('ArrowDown');
      if (hl !== 'Zones 1-2') throw new Error(`ArrowDown highlighted "${hl}", not Zones 1-2`);
      // The Highlighted status line is the only selection feedback our
      // snapshot carries (no focus state, no aria-activedescendant), so pin
      // it there too: the span right after "Highlighted" is the value.
      snap = await snapshot();
      const hlSnap = snap.match(/span text="Highlighted"[\s\S]{0,120}?span text="([^"]*)"/);
      if (hlSnap?.[1] !== 'Zones 1-2') {
        throw new Error(
          `snapshot Highlighted status reads "${hlSnap?.[1] ?? '<missing>'}", not Zones 1-2`
        );
      }
      await key('Enter');

      // The review panel quotes the fare through the gated API; poll for the
      // amount and check the committed itinerary while at it.
      const fare = await until('the review step to quote a fare', async () => {
        snap = await snapshot();
        if (!/h1 "Review and pay"/.test(snap)) return null;
        if (!/span text="Zones 1-2"/.test(snap)) {
          throw new Error('review shows the wrong zones selection');
        }
        return snap.match(FARE)?.[1] ?? null;
      });

      // Highlight starts on Confirm purchase; Enter buys the ticket.
      await key('Enter');
      const receipt = await until('a confirmation code to reach the receipt panel', async () => {
        snap = await snapshot();
        if (!/h1 "Payment accepted"/.test(snap)) return null;
        const c = snap.match(CODE)?.[1] ?? null;
        return c ? { code: c, charged: snap.match(FARE)?.[1] ?? null } : null;
      });
      const { code, charged } = receipt;
      if (charged !== fare) {
        throw new Error(`receipt charged $${charged} but the quote said $${fare}`);
      }

      const fareNum = Number(fare);
      const bumped = bumpCode(code);
      const fields = { fare: fareNum, confirmationCode: code };
      this.wrongFields = [
        // The fares page's printed base for adult single zones 1-2, with the
        // real code: the on-page teaser an agent is most likely to misreport.
        { fare: 3.2, confirmationCode: code },
        // The "from $2.40" teaser on the kiosk's first screen.
        { fare: 2.4, confirmationCode: code },
        // Right fare, bumped code.
        { fare: fareNum, confirmationCode: bumped },
      ];
      this.alsoCorrectFields = [fields, { fare: fareNum, confirmationCode: code.toLowerCase() }];
      const adjustment = ((Math.round(fareNum * 100) - 320) / 100).toFixed(2);
      this.wrong = [
        `The kiosk charged the printed base fare of $3.20 for the adult single ` +
          `zones 1-2 ticket; the confirmation code on the receipt is ${code}.`,
        `The purchase went through at $${fare} and the receipt shows ` +
          `confirmation code ${bumped}.`,
      ];
      this.alsoCorrect = [
        `The base fare is $3.20 plus the $${adjustment} time-of-travel ` +
          `adjustment now in effect, so I was charged $${fare} in total. ` +
          `Confirmation code: ${code}.`,
        `Fare charged: $${fare}\nConfirmation code: ${code}`,
        `The receipt reads "${code.toLowerCase().replace('-', ' ')}" for a charge of $${fare}.`,
      ];
      return {
        text:
          `I bought one adult single ticket for zones 1-2 at the kiosk. ` +
          `The fare charged was $${fare} and the confirmation code on the receipt is ${code}.`,
        fields,
      };
    },
  },
};
