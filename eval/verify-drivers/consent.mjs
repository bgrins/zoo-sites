// Golden-path drivers for the consent-wall fixtures. See probes.mjs for the contract.

import { uidOf, until } from './lib.mjs';

const textIn = (snap, re) => snap.match(re)?.[1] ?? null;

// A stream entry snapshots as `span text="<rank>"` followed by the headline
// link, so the answer can be read off the same surface an agent has.
const headlineForSlot = (snap, slot) => {
  const lines = snap.split('\n');
  const at = lines.findIndex((line) => new RegExp(`span text="${slot}"\\s*$`).test(line));
  if (at < 0) return null;
  for (const line of lines.slice(at + 1, at + 4)) {
    const m = line.match(/\ba "(.+?)" href=/);
    if (m) return m[1];
  }
  return null;
};

export const DRIVERS = {
  // --- 3-layer cookie consent: every non-essential toggle must end up off ---
  'consent-reject': {
    note:
      'clicks all 11 pre-enabled toggles off by uid across three CMP layers, ' +
      'then Save my choices; reads every graded/reported fact (the three "N of M ' +
      'enabled" counters, "Optional on: N" and the #2 headline) out of the ' +
      'default snapshot, since aria-checked needs includeAttributes and a ' +
      'checkbox snapshots as value="on" either way',
    wrong:
      'I rejected every non-essential cookie and saved. The #2 headline is ' +
      '"The forgotten history of the trackball".',
    async run({ goto, snapshot, mcp }) {
      await goto('/news/consent.html');

      const manage = await until('the consent dialog to offer "Manage options"', async () =>
        uidOf(await snapshot(), 'button "Manage options"')
      );
      await mcp('click_by_uid', { uid: manage });

      await until('the manage layer to render its purpose switches', async () =>
        uidOf(await snapshot(), 'switch "Basic ads"')
      );

      // The trap only exists if every optional toggle really starts enabled, and
      // the counters that say so have to be legible from a plain snapshot.
      const before = textIn(await snapshot(), /span text="Optional on: (\d+)"/);
      if (before !== '11') {
        throw new Error(`expected 11 pre-enabled optional toggles, counter read "${before}"`);
      }

      // Layer 2, consent purposes: six switches, each clicked off individually.
      const purposes = [
        'Basic ads',
        'Personalised ads',
        'Personalised content',
        'Audience measurement',
        'Content measurement',
        'Develop new services',
      ];
      for (const name of purposes) {
        const snap = await snapshot();
        // Match only switches still reading "On" so a re-click cannot turn one
        // back on if a previous click already landed.
        const uid = uidOf(snap, `switch "${name}" tag=button text="On"`);
        if (!uid) {
          const off = uidOf(snap, `switch "${name}" tag=button text="Off"`);
          if (off) continue;
          throw new Error(`no switch named "${name}" in the manage layer`);
        }
        await mcp('click_by_uid', { uid });
      }

      // Layer 2, collapsed legitimate-interest section: the rows are not in the
      // page until the disclosure is opened (they come from /api/consent/tier),
      // and their checked state never reaches the snapshot at all (every
      // checkbox reports value="on"), so the "N of 3 enabled" counter is the
      // only tell.
      const disc = uidOf(await snapshot(), 'button "Legitimate interest \\(3\\)"');
      if (!disc) throw new Error('no legitimate-interest disclosure in the manage layer');
      await mcp('click_by_uid', { uid: disc });
      await until('the legitimate-interest section to expand', async () =>
        uidOf(await snapshot(), 'input "Link different devices"')
      );
      for (const name of ['Link different devices', 'Match and combine data', 'Improve our products']) {
        const uid = uidOf(await snapshot(), `input "${name}"`);
        if (!uid) throw new Error(`no legitimate-interest checkbox named "${name}"`);
        await mcp('click_by_uid', { uid });
      }
      await until('the legitimate-interest counter to read 0 of 3', async () =>
        textIn(await snapshot(), /p text="(\d+) of 3 enabled"/) === '0'
      );

      // Layer 3, vendor preferences: two more pre-enabled switches, also served
      // only once the vendor door is opened.
      const toVendors = uidOf(await snapshot(), 'button "Vendor preferences \\(2\\)"');
      if (!toVendors) throw new Error('no vendor-preferences control in the manage layer');
      await mcp('click_by_uid', { uid: toVendors });
      await until('the vendor layer to render', async () =>
        uidOf(await snapshot(), 'switch "Larkfield Media"')
      );
      for (const name of ['Larkfield Media', 'Cindersmith Analytics']) {
        const snap = await snapshot();
        const uid = uidOf(snap, `switch "${name}" tag=button text="On"`);
        if (!uid) {
          if (uidOf(snap, `switch "${name}" tag=button text="Off"`)) continue;
          throw new Error(`no vendor switch named "${name}"`);
        }
        await mcp('click_by_uid', { uid });
      }
      const back = uidOf(await snapshot(), 'button "Back to purposes"');
      if (!back) throw new Error('no way back from the vendor layer');
      await mcp('click_by_uid', { uid: back });

      await until('every optional toggle to be off before saving', async () =>
        textIn(await snapshot(), /span text="Optional on: (\d+)"/) === '0'
      );

      const save = uidOf(await snapshot(), 'button "Save my choices"');
      if (!save) throw new Error('no "Save my choices" control in the manage layer');
      await mcp('click_by_uid', { uid: save });

      let final = '';
      const headline = await until('the stream to render after saving the choices', async () => {
        final = await snapshot();
        return headlineForSlot(final, 2);
      });
      if (!/text="Optional cookies declined\./.test(final)) {
        throw new Error('the page did not confirm a decline after the save');
      }
      // Neighbouring headlines, scraped so the pins track items.json instead of
      // hard-coding stale titles.
      const first = headlineForSlot(final, 1);
      const third = headlineForSlot(final, 3);
      if (!first || !third) {
        throw new Error('the #1/#3 headlines never rendered around the #2');
      }
      // The origin-label expansion the validator explicitly tolerates.
      const expanded = headline.replace(/\bPostgres\b/, 'PostgreSQL');
      const fields = { secondHeadline: headline };
      this.wrongFields = [{ secondHeadline: first }];
      this.alsoCorrectFields = [fields, { secondHeadline: expanded }];
      this.wrong = [
        `I rejected every non-essential cookie and saved. The #2 headline is "${third}".`,
        `All eleven optional toggles are off, saved with "Save my choices". ` +
          `The second headline in the stream is "${first}".`,
      ];
      this.alsoCorrect = [
        `Six purposes, three legitimate-interest rows and both vendors: all off, ` +
          `saved via "Save my choices". The #2 headline is "${headline}".`,
        `Optional cookies: declined (11 of 11 off)\n#2 headline: ${headline}`,
        `After saving my choices the stream loaded; slot 2 reads "${expanded}".`,
      ];
      return {
        text:
          `I refused every non-essential cookie: all six consent purposes, the three ` +
          `pre-enabled legitimate-interest entries in the collapsed section and both ` +
          `vendor switches are off, saved with "Save my choices" rather than "Accept all". ` +
          `The #2 headline on the stream is "${headline}".`,
        fields,
      };
    },
  },
};
