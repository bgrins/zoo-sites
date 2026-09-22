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

import { ANSWERS } from '../answers.mjs';
import { addSession, clickToPath, esc, until, uidOf } from './lib.mjs';

const lines = (snap) => snap.split('\n');

// State-case plants for the navigation-plus-page-beacon gates. `logs` names
// which of a session's records lose the path: both, or only the beacon half.
function dropPath(state, path, logs = ['govNav', 'govViews']) {
  for (const s of state.sessions.values()) {
    for (const key of logs) if (s[key]) s[key] = s[key].filter((r) => r.path !== path);
  }
}

// The two halves of one page's gate, each under its own cookie.
function splitViews(state, path) {
  const moved = [...state.sessions.values()].flatMap((s) =>
    (s.govViews ?? []).filter((r) => r.path === path)
  );
  dropPath(state, path, ['govViews']);
  addSession(state, { govViews: moved });
}

function pageGateCases(path, label) {
  return [
    { name: `the ${label} page was never loaded`, mutate: (state) => dropPath(state, path) },
    {
      name: `the ${label} page was requested with navigation headers but its script never ran`,
      mutate: (state) => dropPath(state, path, ['govViews']),
    },
    {
      name: `the ${label} navigation and its page beacon landed under different cookies`,
      mutate: (state) => splitViews(state, path),
    },
  ];
}

// Removes every directory page `drop` selects from every session's records and
// returns the paths removed.
function dropIndexGets(state, drop) {
  const removed = new Set();
  for (const s of state.sessions.values()) {
    s.govNav = (s.govNav ?? []).filter((n) => !drop(n.path));
    for (const path of Object.keys(s.htmlGets ?? {})) {
      if (drop(path)) {
        removed.add(path);
        delete s.htmlGets[path];
      }
    }
  }
  return [...removed];
}

// A session a curl probe or an earlier tab would leave: it saw one page.
const straySession = (path) => ({
  name: `a stray session minted first loaded ${path} and nothing else`,
  mutate: (state) =>
    addSession(state, { govNav: [{ path, at: Date.now() }], govViews: [{ path, at: Date.now() }] }, { first: true }),
});

// Reads one snapshot text="..." payload. The formatter truncates at 30
// characters, so this only works for a line whose needle leads it.
function textLine(snap, needle) {
  for (const l of lines(snap)) {
    const m = l.match(/text="([^"]*)"/);
    if (m && needle.test(m[1])) return m[1];
  }
  return null;
}

// The Bureau sits under /gov/ on the single-origin server and at its own
// origin's root under --origins, and relative links keep whichever form the
// page was loaded under, so paths compare with that prefix stripped. A RegExp
// is tested against the whole stripped path, for a destination whose path is a
// prefix of the page the click starts from.
const unprefixed = (path) => String(path).replace(/^\/gov(?=\/)/, '');

function pollPath(evaluate, want) {
  const arrived =
    want instanceof RegExp ? (at) => want.test(at) : (at) => at.includes(unprefixed(want));
  return until(
    `the location to include ${want}`,
    async () => arrived(unprefixed(await evaluate(() => location.pathname + location.search))),
    { tries: 20, gap: 200 }
  );
}

const DESK = '/gov/departments/assessment-standards/field-operations/ground-works';

// A desk page's fact table as { label: value }. Table cells never reach the
// snapshot, so the driver reads them with a script; whether a surface delivers
// them is the measurement.
async function deskFacts(evaluate, label) {
  return until(`the desk page's ${label} row`, async () => {
    const facts = await evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('tr')]
          .map((tr) => [...tr.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()))
          .filter((cells) => cells.length === 2)
      )
    );
    return facts?.[label] ? facts : null;
  }, { tries: 20, gap: 200 });
}

export const DRIVERS = {
  // --- five-level descent through a 127-page directory ---
  'dept-descent': {
    note: 'reads each listing blurb with evaluate (the snapshot keeps 27 chars of it) and clicks the branch by uid; the hours cell is table markup, so evaluate reads it',
    wrongState: [
      ...pageGateCases(ANSWERS.govNav.deskPath, 'desk'),
      // The ask is to navigate the directory, so a desk URL loaded with no
      // request for the index pages above it anywhere in the run is not the
      // descent, and neither is a walk that skipped a level.
      {
        name: 'the desk was loaded without walking the directory',
        mutate: (state) => dropIndexGets(state, (path) => path.endsWith('/index.html')),
      },
      {
        name: 'no session ever requested the Field Operations index',
        mutate: (state) => dropIndexGets(state, (path) => path.endsWith('/field-operations/index.html')),
      },
    ],
    alsoCorrectState: [
      straySession('/gov/departments/index.html'),
      // Page script fetching the index pages walks the directory as surely as
      // clicking through them does.
      {
        name: 'the directory was crawled by in-page fetch rather than clicked through',
        mutate: (state) => {
          for (const s of state.sessions.values()) {
            s.govNav = (s.govNav ?? []).filter((n) => !n.path.endsWith('/index.html'));
          }
        },
      },
      // curl with no cookie jar mints a session per request, so a shell crawl
      // leaves each index page under its own cookie before the browser opens
      // the desk it found.
      {
        name: 'a shell crawled the directory one cookie-less request per page, then the browser opened the desk',
        mutate: (state) => {
          const crawled = dropIndexGets(state, (path) => path.endsWith('/index.html'));
          for (const path of crawled) addSession(state, { htmlGets: { [path]: 1 } }, { first: true });
        },
      },
    ],
    wrong: [
      'The Subsurface Permits desk keeps the general Bureau counter hours, ' +
        'Monday to Friday 8:30 AM to 4:30 PM.',
    ],
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto('/gov/departments/');
      // One judgment call per level, made on each listing's full blurb, which
      // is read with a script; the chosen link is then clicked by uid. Exactly
      // one listing per level may match, or the cue no longer decides.
      const trail = [
        [/ground works/i, 'assessment-standards/'],
        [/ground works/i, 'field-operations/'],
        [/subsurface/i, 'ground-works/'],
      ];
      for (const [cue, expect] of trail) {
        const listing = await evaluate(() =>
          [...document.querySelectorAll('li')].map((li) => ({
            name: li.querySelector('a')?.textContent.trim() ?? '',
            text: li.textContent.replace(/\s+/g, ' ').trim(),
          }))
        );
        const hits = (listing ?? []).filter((item) => cue.test(item.text));
        if (hits.length !== 1) {
          throw new Error(`${hits.length} directory listings matched ${cue} on the way to ${expect}`);
        }
        const name = esc(hits[0].name.slice(0, 20));
        await clickToPath(mcp, evaluate, async () => uidOf(await snapshot(), `a "${name}`), expect);
      }
      const section = await snapshot();
      const desk = uidOf(section, 'a "Subsurface Permits Desk"');
      if (!desk) throw new Error('no Subsurface Permits Desk link in the Ground Works section');
      await mcp('click_by_uid', { uid: desk });
      await pollPath(evaluate, `${DESK}/subsurface-permits.html`);
      const hours = (await deskFacts(evaluate, 'Public counter hours'))['Public counter hours'];
      if (!/9:15/.test(hours) || !/12:45/.test(hours)) {
        throw new Error(`hours cell is incomplete on the page: "${hours}"`);
      }
      const fields = {
        daysOpen: ['Tuesday', 'Thursday'],
        opensAt: '9:15 AM',
        closesAt: '12:45 PM',
      };
      // From the fourth on, one fact flipped per case, so every conjunct (open,
      // close, each day, no extra day) has a case only it rejects; the four-day
      // list is the sibling Surface Permits desk's Mon - Thu.
      this.wrongFields = [
        { daysOpen: ['Tuesday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tuesday', 'Thursday'], opensAt: '8:30 AM', closesAt: '4:30 PM' },
        { daysOpen: ['Monday', 'Wednesday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tuesday', 'Thursday'], opensAt: '9:15 AM', closesAt: '4:30 PM' },
        { daysOpen: ['Tuesday', 'Thursday'], opensAt: '8:30 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tuesday', 'Friday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        // A range names its endpoints, never the days between them.
        { daysOpen: ['Tue-Thu'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tuesday to Thursday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tue ~ Thu'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tue → Thu'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        // A date's ordinal suffix is not Thursday.
        { daysOpen: ['Tuesday the 9th'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        // Zero-padded hours are 24-hour times: 00:45 is not 12:45 PM.
        { daysOpen: ['Tue', 'Thu'], opensAt: '09:15', closesAt: '00:45' },
      ];
      this.alsoCorrectFields = [
        fields,
        { daysOpen: ['Tue', 'Thu'], opensAt: '09.15', closesAt: '12.45' },
        { daysOpen: ['Tuesday and Thursday'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tuesdays & Thursdays'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tu', 'Th'], opensAt: '0915', closesAt: '1245' },
        // Days carrying a qualifier or an abbreviation dot, the page's own hours
        // line as one item, and a time span between the two days.
        { daysOpen: ['Tuesday mornings', 'Thursday mornings'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tue. & Thu.'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: [hours], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: [`Public counter hours ${hours}`], opensAt: '9:15 AM', closesAt: '12:45 PM' },
        { daysOpen: ['Tue 9:15 AM - 12:45 PM, Thu 9:15 AM - 12:45 PM'], opensAt: '9:15 AM', closesAt: '12:45 PM' },
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
          `desk page, whose counter hours read "${hours}": it opens Tuesdays and ` +
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
    note: 'clicks the Ground Works breadcrumb, then the sibling desk, by uid; both numbers are table cells, so evaluate reads them',
    wrongState: pageGateCases(ANSWERS.govNav.siblingPath, 'sibling desk'),
    alsoCorrectState: [straySession(ANSWERS.govNav.deskPath)],
    wrong: ['The Surface Permits desk can be reached on (804) 555-0163.'],
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto(`${DESK}/subsurface-permits.html`);
      const own = (await deskFacts(evaluate, 'Telephone')).Telephone;
      if (!/555-0163/.test(String(own))) {
        throw new Error(`start page no longer shows its own number: "${own}"`);
      }
      const start = await snapshot();
      const crumb = uidOf(start, 'a "Ground Works"');
      if (!crumb) throw new Error('no Ground Works breadcrumb on the Subsurface Permits page');
      await mcp('click_by_uid', { uid: crumb });
      // The start page's own path already contains `${DESK}/`, so arrival is the
      // section index itself.
      await pollPath(evaluate, /\/ground-works\/(index\.html)?$/);
      const section = await snapshot();
      // "Surface Permits Desk" with the opening quote in the pattern cannot
      // match "Subsurface Permits Desk", which is the near-miss this task grades.
      const sibling = uidOf(section, 'a "Surface Permits Desk"');
      if (!sibling) throw new Error('no Surface Permits Desk link in the section listing');
      await mcp('click_by_uid', { uid: sibling });
      await pollPath(evaluate, `${DESK}/surface-permits.html`);
      const phone = (await deskFacts(evaluate, 'Telephone')).Telephone;
      const number = String(phone).match(/\(\d{3}\)\s*\d{3}-\d{4}/);
      if (!number) throw new Error(`no phone number on the sibling desk page: "${phone}"`);
      const ownNumber = String(own);
      const fields = { telephoneNumber: number[0] };
      // The start desk's number handed to the target is the swap this task
      // measures; a hedge naming both desks, and the Bureau's general line.
      this.wrongFields = [
        { telephoneNumber: '(804) 555-0163' },
        { telephoneNumber: '(804) 555-0178 or (804) 555-0163' },
        { telephoneNumber: '(804) 555-0100' },
      ];
      // The area code is optional, and NANP numbers come in several shapes.
      this.alsoCorrectFields = [
        fields,
        { telephoneNumber: '555-0178' },
        { telephoneNumber: '804-555-0178' },
        { telephoneNumber: '+1 804 555 0178' },
      ];
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
    wrongState: [
      {
        name: 'no session ever used the site search',
        mutate: (state) => {
          for (const s of state.sessions.values()) delete s.govSearches;
        },
      },
      ...pageGateCases('/gov/rv7-instructions.html', 'RV-7 instructions'),
    ],
    // The documented fallback for a cookie re-minted between the search and
    // the page it led to.
    alsoCorrectState: [
      {
        name: 'the search and the RV-7 instructions page landed under different cookies',
        mutate: (state) => {
          const searches = [...state.sessions.values()].flatMap((s) => s.govSearches ?? []);
          for (const s of state.sessions.values()) delete s.govSearches;
          addSession(state, { govSearches: searches }, { first: true });
        },
      },
      straySession('/gov/rv7a-instructions.html'),
    ],
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
      // measures. The third and fourth carry the right box number, so only the
      // annex station and the missing "Box" reject them. The last two are
      // RV-7A's unit on RV-7's box, and a box with no station: not the full
      // address the ask demands.
      this.wrongFields = [
        { mailingAddress: 'Bureau of Civic Revenue, Amendments Section, PO Box 7 A, Substation Annex' },
        { mailingAddress: 'Bureau of Civic Revenue, Statehouse Plaza Station' },
        { mailingAddress: 'PO Box 4410, Substation Annex' },
        { mailingAddress: 'Declarations Unit, 4410 Statehouse Plaza Station' },
        { mailingAddress: 'Bureau of Civic Revenue, Amendments Section, PO Box 4410, Statehouse Plaza Station' },
        { mailingAddress: 'PO Box 4410' },
      ];
      this.alsoCorrectFields = [
        fields,
        { mailingAddress: 'PO Box 4410, Statehouse Plaza Station' },
        // The RV-7 page's own warning repeated alongside the address.
        { mailingAddress: 'PO Box 4410, Statehouse Plaza Station (not the amendments annex)' },
      ];
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
    wrongState: [
      {
        name: 'the archive was never served',
        mutate: (state) => {
          for (const s of state.sessions.values()) if (s.rv3) s.rv3.hits = 0;
        },
      },
      {
        name: 'the archive was served to a session with no interstitial on record',
        mutate: (state) => {
          for (const s of state.sessions.values()) if (s.rv3) s.rv3.interstitials = 0;
        },
      },
    ],
    alsoCorrectState: [
      {
        name: 'a stray session guessed ?v=2 cold and another went round the loop without escaping',
        mutate: (state) => {
          addSession(state, { rv3: { bounces: 0, hits: 0, interstitials: 0, cold: 1 } }, { first: true });
          addSession(state, { rv3: { bounces: 6, hits: 0, interstitials: 1, cold: 0 } });
        },
      },
    ],
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
      this.wrongFields = [
        { revisionDate: '11/2017' },
        { revisionDate: '03/2019' },
        // The forms table's revision, an older printing.
        { revisionDate: '06/03' },
        { revisionDate: 'June 2003' },
        // The right numbers with 11 as a day of another month, named and in the
        // US numeric form.
        { revisionDate: 'March 11, 2019' },
        { revisionDate: '3/11/2019' },
        // A second revision in the same year is a hedge between two months.
        { revisionDate: '11/2019 (May 2019 reprint)' },
        // Day and month either way round, whatever single mark joins them.
        { revisionDate: '3 / 11 / 2019' },
        { revisionDate: '3 11 2019' },
        { revisionDate: '03–11-2019' },
        { revisionDate: '3/11, 2019' },
        { revisionDate: '3/11 2019' },
      ];
      this.alsoCorrectFields = [
        fields,
        { revisionDate: 'November 2019' },
        { revisionDate: 'Nov 2019' },
        { revisionDate: '2019-11' },
        // Only the month bound to the revision year is the claim.
        { revisionDate: 'Revised Nov 2019 (supersedes Mar 2017)' },
        { revisionDate: '11/2019 (may be a reprint)' },
        { revisionDate: 'Rev. 11/2019 (the forms table lists 06/03)' },
        // The form number is not a day.
        { revisionDate: 'Form RV-3, 11/2019' },
        { revisionDate: 'RV-3: 11/2019' },
        { revisionDate: 'RV-3 (11/2019)' },
        { revisionDate: 'Form RV-3 11/2019' },
        { revisionDate: 'Form RV-3 — 11-2019' },
        { revisionDate: 'RV-3 11 2019' },
        { revisionDate: 'RV-3 - 11 - 2019' },
        { revisionDate: 'Form RV 3, 11/2019' },
      ];
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
