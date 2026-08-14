// Golden paths for the Bureau of Civic Revenue navigation cluster:
// dept-descent, breadcrumb-sibling, search-decoy, redirect-escape.
//
// Three of the four grade on a SERVER-OBSERVED document navigation paired with a
// beacon from the loaded page's own script, so every driver has to reach its page
// with navigate_page/click_by_uid — reading the HTML with a script satisfies
// neither half, which is the point of the tasks. redirect-escape grades on the
// archive being served, which the server only does for a session that has already
// been round the redirect loop, so its driver must not skip to ?v=2.
//
// See probes.mjs for the driver contract.

import { until, uidOf } from './lib.mjs';

const lines = (snap) => snap.split('\n');

// The snapshot prints a list item and then its link on the following, more
// indented line:
//   uid=4_4 li text="— Ground works, site permit..."
//     uid=4_3 a "Assessment Standards Division" href="..." text="..."
// so a branch is chosen by matching the blurb and taking the link under it.
function uidUnderCue(snap, cue) {
  const rows = lines(snap);
  const at = rows.findIndex((l) => cue.test(l));
  if (at === -1) return null;
  for (let i = at + 1; i < rows.length && i <= at + 3; i++) {
    const m = rows[i].match(/uid=(\S+) a "/);
    if (m) return m[1];
  }
  return null;
}

// Reads one snapshot text="..." payload. The formatter truncates at 30
// characters, so this only works for short, front-loaded lines — which is why
// the desk pages put each graded fact in its own short paragraph.
function textLine(snap, needle) {
  for (const l of lines(snap)) {
    const m = l.match(/text="([^"]*)"/);
    if (m && needle.test(m[1])) return m[1];
  }
  return null;
}

function pollPath(evaluate, fragment) {
  return until(
    `the location to include ${fragment}`,
    async () => String(await evaluate(() => location.href)).includes(fragment),
    { tries: 20, gap: 200 }
  );
}

const DESK = '/gov/departments/assessment-standards/field-operations/ground-works';

export const DRIVERS = {
  // --- five-level descent through a 127-page directory ---
  'dept-descent': {
    note: 'descends by the front-loaded listing blurbs; hours read straight from the snapshot',
    wrong: [
      'The Subsurface Permits desk keeps the general Bureau counter hours, ' +
        'Monday to Friday 8:30 AM to 4:30 PM.',
    ],
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto('/gov/departments/');
      // One judgment call per level. Only the first 27 characters of a listing
      // blurb survive the snapshot, so each cue below is what an agent can
      // actually read: "Ground works, site permi...", not the full sentence.
      const trail = [
        [/li text="[^"]*Ground works, site permi/, 'assessment-standards/'],
        [/li text="[^"]*Excavation and ground wo/, 'field-operations/'],
        [/li text="[^"]*Subsurface and surface pe/, 'ground-works/'],
      ];
      for (const [cue, expect] of trail) {
        const snap = await snapshot();
        const uid = uidUnderCue(snap, cue);
        if (!uid) throw new Error(`no directory listing matched ${cue} on the way to ${expect}`);
        await mcp('click_by_uid', { uid });
        await pollPath(evaluate, expect);
      }
      const section = await snapshot();
      const desk = uidOf(section, 'a "Subsurface Permits Desk"');
      if (!desk) throw new Error('no Subsurface Permits Desk link in the Ground Works section');
      await mcp('click_by_uid', { uid: desk });
      await pollPath(evaluate, `${DESK}/subsurface-permits.html`);
      // 28 characters, so the hours line survives the formatter's 30-char cap
      // intact and no evaluate() is needed to read the graded fact.
      const page = await snapshot();
      const hours = textLine(page, /9:15/);
      if (!hours) throw new Error('counter hours not visible in the desk page snapshot');
      if (!/12:45/.test(hours)) throw new Error(`hours line looks truncated: "${hours}"`);
      const fields = {
        daysOpen: ['Tuesday', 'Thursday'],
        opensAt: '9:15 AM',
        closesAt: '12:45 PM',
      };
      this.wrongFields = [
        { daysOpen: ['Tuesday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tuesday', 'Thursday'], opensAt: '8:30 AM', closesAt: '4:30 PM' },
        { daysOpen: ['Monday', 'Wednesday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
      ];
      this.alsoCorrectFields = [
        fields,
        { daysOpen: ['Tue', 'Thu'], opensAt: '09.15', closesAt: '12.45' },
      ];
      this.wrong = [
        this.wrong[0],
        `The desk page shows "${hours}", but the Bureau-wide counter hours take ` +
          `precedence, so the Subsurface Permits desk is open Monday to Friday, ` +
          `8:30 AM to 4:30 PM.`,
        `The Subsurface Permits counter is open on Tuesdays from 9:15 AM to 12:45 PM.`,
      ];
      this.alsoCorrect = [
        `Days open: Tuesday and Thursday\nOpens at: 9:15 AM\nCloses at: 12:45 PM`,
        `I walked Assessment Standards > Field Operations > Ground Works down to the ` +
          `desk page, whose counter line reads "${hours}": it opens Tuesdays and ` +
          `Thursdays at 9:15 AM and closes at 12:45 PM.`,
        `The desk's public counter runs Tue and Thu, 09.15 to 12.45.`,
      ];
      return {
        text:
          `The Subsurface Permits desk is four levels down, under Assessment Standards ` +
          `Division > Office of Field Operations > Ground Works Section. Its public ` +
          `counter hours are ${hours} (Tuesdays and Thursdays only, 9:15 AM to 12:45 PM); ` +
          `outside those hours it takes filings through the ground-floor drop box.`,
        fields,
      };
    },
  },

  // --- breadcrumb up one level, then across to the sibling desk ---
  'breadcrumb-sibling': {
    note: 'clicks the Ground Works breadcrumb, then the sibling desk; both numbers read from snapshots',
    wrong: ['The Surface Permits desk can be reached on (555) 014-3391.'],
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto(`${DESK}/subsurface-permits.html`);
      const start = await snapshot();
      const own = textLine(start, /^Phone:/);
      if (!/014-3391/.test(String(own))) {
        throw new Error(`start page no longer shows its own number: "${own}"`);
      }
      const crumb = uidOf(start, 'a "Ground Works"');
      if (!crumb) throw new Error('no Ground Works breadcrumb on the Subsurface Permits page');
      await mcp('click_by_uid', { uid: crumb });
      await pollPath(evaluate, `${DESK}/`);
      const section = await snapshot();
      // "Surface Permits Desk" with the opening quote in the pattern cannot
      // match "Subsurface Permits Desk", which is the near-miss this task grades.
      const sibling = uidOf(section, 'a "Surface Permits Desk"');
      if (!sibling) throw new Error('no Surface Permits Desk link in the section listing');
      await mcp('click_by_uid', { uid: sibling });
      await pollPath(evaluate, `${DESK}/surface-permits.html`);
      const page = await snapshot();
      const phone = textLine(page, /^Phone:/);
      const number = String(phone).match(/\(\d{3}\)\s*\d{3}-\d{4}/);
      if (!number) throw new Error(`no phone number on the sibling desk page: "${phone}"`);
      const ownNumber = String(own).replace(/^Phone:\s*/, '');
      const fields = { telephoneNumber: number[0] };
      // The start desk's number handed to the target is the swap this task
      // measures.
      this.wrongFields = [{ telephoneNumber: '(555) 014-3391' }];
      this.alsoCorrectFields = [fields, { telephoneNumber: '014-8862' }];
      this.wrong = [
        this.wrong[0],
        `Both desks route through the section line, so call the Surface Permits ` +
          `desk on ${ownNumber}.`,
      ];
      this.alsoCorrect = [
        `Desk: Surface Permits\nTelephone: ${number[0]}`,
        `Up the Ground Works breadcrumb and across to the sibling: the Surface ` +
          `Permits desk lists ${number[0]} — not ${ownNumber}, which belongs to the ` +
          `Subsurface Permits desk I started on.`,
        `The Surface Permits desk's number is ${number[0].replace(/[()]/g, '').replace(/\s+/g, ' ')}.`,
      ];
      return {
        text:
          `Surface Permits Desk: ${number[0]}. I went up one level with the Ground Works ` +
          `breadcrumb and across to the sibling desk. Note the Subsurface Permits page I ` +
          `started on lists a different extension, ${ownNumber}.`,
        fields,
      };
    },
  },

  // --- site search that ranks the amended form's page above the original's ---
  'search-decoy': {
    note: 'search box has no accessible name in the snapshot; the address line needs evaluate to read in full',
    wrong: [
      'Send Form RV-7 to the Bureau of Civic Revenue, Amendments Section, ' +
        'PO Box 7 A, Substation Annex.',
    ],
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto('/gov/');
      const home = await snapshot();
      // The sidebar search field carries no id, name, label or placeholder, so
      // the snapshot shows a bare `input` with nothing to identify it: the only
      // handle is "the input in the same form as the GO button".
      const form = lines(home).findIndex((l) => /uid=\S+ form/.test(l));
      if (form === -1) throw new Error('no search form in the gov home snapshot');
      const field = lines(home)
        .slice(form + 1, form + 4)
        .map((l) => l.match(/uid=(\S+) input(?! value)/))
        .find(Boolean);
      const go = lines(home)
        .slice(form + 1, form + 4)
        .map((l) => l.match(/uid=(\S+) input value="GO"/))
        .find(Boolean);
      if (!field || !go) throw new Error('could not resolve the search field and GO button');
      await mcp('fill_by_uid', { uid: field[1], value: 'Form RV-7 mailing address' });
      await mcp('click_by_uid', { uid: go[1] });
      await pollPath(evaluate, 'search.html?q=');
      const results = await until(
        'the results to list Form RV-7 Instructions',
        async () => {
          const s = await snapshot();
          return /Form RV-7 Instructions/.test(s) ? s : null;
        },
        { tries: 20 }
      );
      // The ranking is the trap: hit 1 is the RV-7A page. Take the RV-7 one.
      if (!/uid=\S+ a "Form RV-7A Instructions"/.test(results)) {
        throw new Error('the decoy RV-7A hit is missing, so the task has no trap left');
      }
      const wanted = uidOf(results, 'a "Form RV-7 Instructions"');
      if (!wanted) throw new Error('no Form RV-7 Instructions hit in the results');
      await mcp('click_by_uid', { uid: wanted });
      await pollPath(evaluate, '/gov/rv7-instructions.html');
      // "Bureau of Civic Revenue, Declarations Unit" and "PO Box 4410,
      // Statehouse Plaza Station" are both longer than the formatter's 30-char
      // cap, so the snapshot shows "PO Box 4410, Statehouse Pla..." and loses
      // the rest: the full address can only be read with a script.
      const address = await evaluate(() => {
        const heading = [...document.querySelectorAll('h3')].find((h) =>
          /where to file/i.test(h.textContent)
        );
        if (!heading) return null;
        const out = [];
        for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
          const t = el.textContent.replace(/\s+/g, ' ').trim();
          if (/^PO Box/i.test(t) || /Bureau of Civic Revenue,/.test(t)) out.push(t);
        }
        return out.join(' ');
      });
      if (!address || !/4410/.test(String(address))) {
        throw new Error(`no Declarations Unit address on the RV-7 instructions page: "${address}"`);
      }
      const fields = { mailingAddress: address };
      // The amended form's annex box handed to RV-7 is the swap this task
      // measures.
      this.wrongFields = [
        { mailingAddress: 'Bureau of Civic Revenue, Amendments Section, PO Box 7 A, Substation Annex' },
        { mailingAddress: 'Bureau of Civic Revenue, Statehouse Plaza Station' },
      ];
      this.alsoCorrectFields = [fields, { mailingAddress: 'PO Box 4410, Statehouse Plaza Station' }];
      this.wrong = [
        this.wrong[0],
        `Form RV-7 goes to the Bureau of Civic Revenue at Statehouse Plaza Station.`,
      ];
      this.alsoCorrect = [
        `Form: RV-7\nMailing address: ${address}`,
        `The top search hit was the RV-7A instructions, whose Amendments Section box ` +
          `(PO Box 7 A, Substation Annex) covers amended declarations only; the RV-7 ` +
          `instructions page itself says to mail the declaration to ${address}.`,
        `Send Form RV-7 to the Declarations Unit, P.O. Box 4410, Statehouse Plaza Station.`,
      ];
      return {
        text:
          `Form RV-7 goes to ${address}. The search put Form RV-7A Instructions at the top ` +
          `of the results, but that page gives the Amendments Section box (PO Box 7 A, ` +
          `Substation Annex), which is only for amended declarations on Form RV-7A.`,
        fields,
      };
    },
  },

  // --- redirect loop with a server-side escape hatch ---
  'redirect-escape': {
    note: 'follows the loop to the interstitial, then re-requests with ?v=2',
    wrong: ['The archived Form RV-3 page is marked Rev. 06/03.'],
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto('/gov/forms.html');
      const forms = await snapshot();
      const link = uidOf(forms, 'a "Legacy archive: RV-3"');
      if (!link) throw new Error('no legacy archive link in the forms table');
      await mcp('click_by_uid', { uid: link });
      await pollPath(evaluate, '/gov/legacy/rv3');
      // Six 302s land on a 200 interstitial, well short of the 20-redirect limit
      // at which Firefox substitutes its own error page. The hops never appear
      // in the requests log, so the interstitial is the only cue.
      const notice = await snapshot();
      if (!/\?v=2/.test(notice)) {
        throw new Error('the interstitial no longer names the ?v=2 escape');
      }
      await goto('/gov/legacy/rv3?v=2');
      const archive = await snapshot();
      const rev = textLine(archive, /^Rev\./);
      if (!rev) throw new Error('no revision line on the archived page');
      const date = String(rev).match(/(\d{1,2}\/\d{4})/);
      if (!date) throw new Error(`revision line does not carry a date: "${rev}"`);
      const fields = { revisionDate: date[1] };
      this.wrongFields = [{ revisionDate: '11/2017' }, { revisionDate: '03/2019' }];
      this.alsoCorrectFields = [fields, { revisionDate: 'November 2019' }];
      this.wrong = [
        this.wrong[0],
        `The legacy address just bounces between rv3 and rv3-b, so the archive never ` +
          `loaded; the only revision on record is the forms table's 06/03.`,
      ];
      this.alsoCorrect = [
        `Archived page: /gov/legacy/rv3?v=2\nRevision date: ${date[1]}`,
        `The forms table lists RV-3 at 06/03, but that is the superseded print; the ` +
          `archived page itself is marked ${rev}, so the revision date is November 2019.`,
        `The archived Form RV-3 page carries revision 2019-11.`,
      ];
      return {
        text:
          `The old address bounced between /gov/legacy/rv3 and /gov/legacy/rv3-b until the ` +
          `server returned a notice saying to append ?v=2. The archived Form RV-3 page at ` +
          `/gov/legacy/rv3?v=2 is marked ${rev} (${date[1]}).`,
        fields,
      };
    },
  },
};
