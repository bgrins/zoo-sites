// Golden-path drivers. See probes.mjs for the contract.
//
// Family: pages/forms/ and pages/grid-edit/ — multi-step forms, server-issued
// corrections, cascading selects, autosave/resume and inline grid editing.
//
// Two tool-surface gaps shape these drivers:
//   * take_snapshot truncates every text node at 27 characters, so anything the
//     task hides inside a long sentence (a corrected email, a conversion rule,
//     a referral code buried in a terms clause) is unreadable from the snapshot
//     and has to be read with evaluate_script.
//   * the snapshot emits no <option> nodes, so a <select>'s choices are
//     invisible until one is selected (the chosen value then shows up as
//     value="..."), and fill_by_uid on a select acts as keyboard typeahead.
// Everything else below is driven with take_snapshot + fill_by_uid /
// click_by_uid.

import { addSession, bumpCode, esc, findSession, snapText, straySession, textOf, uidOf as uidMatch, until as poll } from './lib.mjs';
import { GRID_EDIT_STATES } from './extraction-lib.mjs';

const uidOf = (snap, pattern, what) => {
  const m = uidMatch(snap, pattern);
  if (!m) throw new Error(`no uid for ${what} in the snapshot`);
  return m;
};

// callTool reports a failed tool as isError on the result rather than throwing,
// so an interaction against a stale uid would otherwise pass silently.
export const act = async (mcp, name, args) => {
  const r = await mcp(name, args);
  if (r.isError) {
    throw new Error(`${name} failed: ${textOf(r)}`);
  }
  return r;
};

// Poll a snapshot until `test` accepts it; returns the accepting snapshot.
export const untilSnap = (snapshot, test, what, tries = 30) =>
  poll(
    what,
    async () => {
      const snap = await snapshot();
      return test(snap) ? snap : false;
    },
    { tries }
  );

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// The Nerrow Strait calendar is counted from the day the session opened
// (sites/forms.mjs), so on whatever day the gate runs the study is already placed
// and the desk still takes capsules. Read in the browser's own session from every
// page that prints a date, each date against the weekday it names.
async function nerrowCalendar(evaluate) {
  const pages = await evaluate(async () => {
    const out = { 'abstract.html': document.documentElement.outerHTML };
    for (const name of ['index.html', 'registration.html', 'programme.html', 'contact.html', 'travel.html',
      'policies.html', 'past-meetings.html', 'sessions.html', 'reviewers.html']) {
      out[name] = await (await fetch(name)).text();
    }
    return out;
  });
  const DAY = 86400000;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const leftover = Object.keys(pages).filter((name) => /__NERROW_/.test(pages[name]));
  if (leftover.length) throw new Error(`unrendered calendar tokens on ${leftover.join(', ')}`);
  const dayRe = new RegExp(`\\b(${WEEKDAY_NAMES.join('|')}) (\\d{1,2}) (${MONTH_NAMES.join('|')})(?: (\\d{4}))?`, 'g');
  // A date printed without its year falls this year or next; exactly one of
  // the two carries the weekday it names.
  const weekdayDate = ([text, weekday, d, month, y], where) => {
    const years = y ? [+y] : [new Date(today).getUTCFullYear(), new Date(today).getUTCFullYear() + 1];
    const t = years
      .map((year) => Date.UTC(year, MONTH_NAMES.indexOf(month), +d))
      .find((at) => WEEKDAY_NAMES[new Date(at).getUTCDay()] === weekday && new Date(at).getUTCDate() === +d);
    if (t === undefined) throw new Error(`${where} prints "${text}", which is not that weekday`);
    return t;
  };
  for (const [name, html] of Object.entries(pages)) for (const m of html.matchAll(dayRe)) weekdayDate(m, name);
  const one = (html, re, what) => {
    const m = re.exec(html);
    if (!m) throw new Error(`no ${what}`);
    return m;
  };
  const dated = (text, what) => weekdayDate(one(text, new RegExp(dayRe.source), what), what);
  const placed = dated(one(pages['abstract.html'], /<dt>Placed<\/dt><dd>([^<]+)</, 'placement date')[1], 'the placement date');
  const openUntil = dated(one(pages['abstract.html'], /<dt>Desk status<\/dt><dd>([^<]+)</, 'desk status')[1], 'the desk status');
  if (placed > today) throw new Error(`the study is placed on ${iso(placed)}, after today`);
  if (openUntil <= today) throw new Error(`the desk takes capsules until ${iso(openUntil)}, not past today`);
  const convened = new Set(Object.values(pages).map((html) => one(html, /Convened ([^<]+)</, 'convened line')[1]));
  if (convened.size !== 1) throw new Error(`the banners disagree on the meeting: ${[...convened].join(' | ')}`);
  const range = one([...convened][0], new RegExp(`^(\\d{1,2})(?: (${MONTH_NAMES.join('|')}))?(?: (\\d{4}))? to (\\d{1,2}) (${MONTH_NAMES.join('|')}) (\\d{4})$`), 'meeting range');
  const ends = Date.UTC(+range[6], MONTH_NAMES.indexOf(range[5]), +range[4]);
  const opens = Date.UTC(+(range[3] ?? range[6]), MONTH_NAMES.indexOf(range[2] ?? range[5]), +range[1]);
  if (new Date(opens).getUTCDay() !== 2 || ends !== opens + 3 * DAY) {
    throw new Error(`the meeting runs ${iso(opens)} to ${iso(ends)}, not Tuesday to Friday`);
  }
  // The two deadline lists carry the same dates in order, and name the
  // placement, the capsule deadline and the opening the other pages print.
  const listed = (name) => [...pages[name].matchAll(/<dt>([^<]+)<\/dt>/g)]
    .filter((m) => new RegExp(dayRe.source).test(m[1]))
    .map((m) => dated(m[1], `a date on ${name}`));
  const keep = listed('index.html');
  if (listed('registration.html').join() !== keep.join()) throw new Error('the two deadline lists disagree');
  if (keep.length !== 5 || keep.some((t, i) => i && t <= keep[i - 1])) {
    throw new Error(`the deadline list is not five dates in order: ${keep.map(iso).join(', ')}`);
  }
  if (keep[1] !== placed || keep[2] !== openUntil || keep[4] !== opens) {
    throw new Error(`the deadline list ${keep.map(iso).join(', ')} disagrees with the desk and the banner`);
  }
  for (let k = 0; k < 4; k++) {
    const day = new Date(opens + k * DAY);
    const heading = `${WEEKDAY_NAMES[day.getUTCDay()]} ${day.getUTCDate()} ${MONTH_NAMES[day.getUTCMonth()]}`;
    if (!pages['programme.html'].includes(`<h2>${heading} `)) throw new Error(`the programme has no day headed ${heading}`);
  }
}

const GAUNTLET_WRONG = [
  'I reached the review step. The reference code is MD-1042.',
  'I reached the review step. The reference code shown is MD-4921.',
  'Reference code: MD-4921. I did not press Submit.',
];

const DRAFT_ASKED = {
  applicant: 'Rosa Lindqvist',
  organization: 'Tidewater Labs',
  project: 'Kelp Survey',
  budget: '4800',
  duration: '6 months',
};

const ROSTER_WRONG = [
  'All four attendees were registered but the page showed no group code.',
  // 'GRP-' plus the page nonce's first four hex digits is computable from one GET
  // with no registration at all, so a code of that shape must not pass.
  'All four attendees are registered. The group code is GRP-1035.',
];

export const DRIVERS = {
  // --- three-step form; server counts steps walked and must see no submit ---
  'form-gauntlet': {
    note: 'walks all three steps by uid; stops before Submit',
    // MD-4921 is what page script can compute ('MD-' + (4000 + 921)), so it is
    // readable off disk, and it takes zero fields filled, so it must fail.
    wrong: GAUNTLET_WRONG,
    async run({ goto, snapshot, mcp, evaluate, base }) {
      // Stray sessions ahead of the browser run, each stopping at review
      // without pressing Submit: a wrong phone, a note typed into the optional
      // box, the off-screen Fax honeypot filled. None of their codes may pass,
      // and none may fail the real run beside them.
      const asked = {
        name: 'Maya Okafor',
        email: 'maya.okafor@example.com',
        phone: '312-555-0164',
        flagged: false,
        service: 'Cleaning',
        insurance: 'Self-pay',
        newPatient: 'Yes',
        dob: '1990-03-14',
        date: '2026-08-12',
        time: 'Morning (8am\u201312pm)',
        notes: '',
      };
      const walkToReview = async (data) => {
        const stray = await straySession(base, '/forms/drennhill/');
        await stray.post('/api/form-step', { step: 2, data });
        const { refCode } = await stray.post('/api/form-step', { step: 3, data });
        if (!refCode) throw new Error('a stray session did not reach the review step');
        return refCode;
      };
      const strayCodes = [
        await walkToReview({ ...asked, phone: '312-555-0000' }),
        await walkToReview({ ...asked, notes: 'N/A' }),
        await walkToReview({ ...asked, flagged: true }),
      ];
      const submitted = (refCode, steps = [2, 3, 4]) => ({
        formGauntlet: {
          opens: 1,
          steps,
          data: asked,
          refCode,
          submits: steps.filter((s) => s === 4).length,
        },
      });
      this.wrongState = [
        {
          name: 'a stray session pressed Submit before the graded one stopped at review',
          mutate(state) {
            addSession(state, submitted('MD-0A0A0A'), { first: true });
          },
        },
        {
          name: 'pressed Submit under one cookie, reported a review-only session under another',
          mutate(state) {
            addSession(state, submitted('MD-0B0B0B'));
            addSession(state, submitted('MD-0C0C0C', [2, 3]));
          },
          fields: { referenceCode: 'MD-0C0C0C' },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a stray session went back and forth to review and never pressed Submit',
          mutate(state) {
            addSession(state, submitted('MD-0D0D0D', [2, 3, 2, 3]), { first: true });
          },
        },
      ];

      // The review step prints back what the visitor typed, so markup in a
      // field must arrive there as text. This walk shares the browser session
      // with the graded one below, whose step 3 overwrites the data it records.
      await goto('/forms/drennhill/');
      let snap = await snapshot();
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(snap, 'input "Full name', 'full name'), value: 'Ada <i>Brook</i>' },
          { uid: uidOf(snap, 'input "Email address', 'email'), value: 'ada.brook@example.com' },
          { uid: uidOf(snap, 'input "Phone number', 'phone'), value: '312-555-0100' },
        ],
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'button "Continue to visit details"', 'step-1 continue'),
      });
      snap = await untilSnap(snapshot, (s) => /select "Service/.test(s), 'markup walk step 2');
      const hostileNote = '<img src="x" onerror="window.__reviewInjected = true">';
      const pick = (pattern, what) => uidOf(snap, pattern, what);
      await act(mcp, 'fill_by_uid', { uid: pick('select "Service', 'service'), value: 'Cleaning' });
      await act(mcp, 'fill_by_uid', {
        uid: pick('select "Insurance', 'insurance'),
        value: 'Self-pay',
      });
      await act(mcp, 'click_by_uid', { uid: pick('input value="No"', 'new-patient No') });
      await act(mcp, 'fill_by_uid', {
        uid: pick('input "Preferred date', 'preferred date'),
        value: '2026-08-12',
      });
      await act(mcp, 'fill_by_uid', { uid: pick('textarea', 'notes'), value: hostileNote });
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, 'input value="on"', 'consent') });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'button "Continue to review"', 'step-2 continue'),
      });
      await untilSnap(snapshot, (s) => /button "Submit request"/.test(s), 'markup walk review');
      const review = await evaluate(() => ({
        elements: document.querySelectorAll('#review *:not(dt):not(dd)').length,
        text: document.getElementById('review').textContent,
        ran: window.__reviewInjected === true,
      }));
      const asText = review.text.includes('Ada <i>Brook</i>') && review.text.includes(hostileNote);
      if (review.elements || review.ran || !asText) {
        throw new Error(`the review step rendered typed markup: ${JSON.stringify(review)}`);
      }

      await goto('/forms/drennhill/');
      snap = await snapshot();
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(snap, 'input "Full name', 'full name'), value: 'Maya Okafor' },
          {
            uid: uidOf(snap, 'input "Email address', 'email'),
            value: 'maya.okafor@example.com',
          },
          {
            uid: uidOf(snap, 'input "Phone number', 'phone'),
            value: '312-555-0164',
          },
        ],
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'button "Continue to visit details"', 'step-1 continue'),
      });
      snap = await untilSnap(snapshot, (s) => /select "Service/.test(s), 'step 2');
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, 'select "Service', 'service'),
        value: 'Cleaning',
      });
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, 'select "Insurance', 'insurance'),
        value: 'Self-pay',
      });
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, 'select "Preferred time of day"', 'time'),
        value: 'Morning',
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'input value="Yes"', 'new-patient Yes'),
      });
      snap = await untilSnap(snapshot, (s) => /input "Date of birth/.test(s), 'the DOB field');
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, 'input "Date of birth', 'date of birth'),
        value: '1990-03-14',
      });
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, 'input "Preferred date', 'preferred date'),
        value: '2026-08-12',
      });
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, 'input value="on"', 'consent') });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'button "Continue to review"', 'step-2 continue'),
      });
      snap = await untilSnap(
        snapshot,
        (s) => /button "Submit request"/.test(s),
        'the review step'
      );
      // The code is minted per session by /api/form-step, so it cannot be
      // predicted; six hex digits.
      const code = snap.match(/MD-[0-9A-F]{6}/);
      if (!code) throw new Error('no reference code on the review step');
      const bumped = bumpCode(code[0]);
      if (strayCodes.includes(code[0])) throw new Error('a stray session and the browser share a code');
      const fields = { referenceCode: code[0] };
      this.wrongFields = [
        { referenceCode: 'MD-000000' },
        { referenceCode: bumped },
        ...strayCodes.map((referenceCode) => ({ referenceCode })),
      ];
      this.alsoCorrectFields = [fields, { referenceCode: code[0].toLowerCase() }];
      this.wrong = [
        ...GAUNTLET_WRONG,
        `I stopped on the review step without submitting; the reference code shown is ${bumped}.`,
      ];
      this.alsoCorrect = [
        `Step 1 took the contact details, step 2 the visit details, and the ` +
          `review page issued reference code ${code[0]}. I stopped there without submitting.`,
        `Reference code: ${code[0]}\nSubmitted: no`,
        `I reached review; the reference code is ${code[0].toLowerCase()}.`,
      ];
      return {
        text: `I completed both steps and reached the review page. The reference code is ${code[0]}. I did not press Submit.`,
        fields,
      };
    },
  },

  // --- server bounces the first submit with corrections that must be applied ---
  'register-errors': {
    note: 'reads the bounced corrections with evaluate — snapshot truncates them at 27 chars',
    wrong: [
      'The records office accepted the registration on the second try, ' +
        'but no confirmation code was displayed.',
    ],
    async run({ goto, snapshot, mcp, evaluate, base }) {
      // A curl-shaped completion ahead of the browser run: bounced, then
      // resubmitted with the server's corrections. The session whose code the
      // answer names is the one graded, so an earlier completer must not
      // shadow it.
      const asked = {
        name: 'Priya Nair',
        email: 'priya@nair-home.example',
        company: 'Meridian',
        zip: '60614-2210',
        referral: 'RF-7304',
      };
      const completeStray = async (change) => {
        const stray = await straySession(base, '/forms/vendor/register.html');
        const { errors } = await stray.post('/api/register', asked);
        const fix = {
          email: String(errors?.email).match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0],
          zip: String(errors?.zip).match(/\b\d{5}\b/)?.[0],
        };
        if (!fix.email || !fix.zip) throw new Error('a stray was not bounced with corrections');
        const { confirmation } = await stray.post('/api/register', { ...asked, ...fix, ...change });
        if (!confirmation) throw new Error('a stray resubmission was not accepted');
        return confirmation;
      };
      const earlier = await completeStray({});
      this.alsoCorrectState = [
        {
          name: 'a probe ahead of every session was bounced and never resubmitted',
          mutate(state) {
            addSession(
              state,
              { registerAttempts: [{ ...asked, accepted: false, at: Date.now() }] },
              { first: true }
            );
          },
        },
      ];

      await goto('/forms/vendor/register.html');
      const snap = await snapshot();
      const field = (label, what) => uidOf(snap, `input "${esc(label)}`, what);
      const submit = uidOf(snap, 'button "Submit registration"', 'submit');
      const emailUid = field('Work email', 'email');
      const zipUid = field('Company ZIP', 'zip');
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: field('Full name', 'name'), value: 'Priya Nair' },
          { uid: emailUid, value: 'priya@nair-home.example' },
          { uid: field('Company *', 'company'), value: 'Meridian' },
          { uid: zipUid, value: '60614-2210' },
          { uid: field('Referral code', 'referral'), value: 'RF-7304' },
        ],
      });
      await act(mcp, 'click_by_uid', { uid: submit });
      // First submit is always rejected; wait for the server-issued corrections.
      // Every take_snapshot invalidates the previous snapshot's uids, so the
      // second pass has to be driven off the snapshot that ends this poll.
      const bounced = await untilSnap(
        snapshot,
        (s) => /status tag=div text="The records office rejected/.test(s),
        'the first submission to be rejected'
      );
      // The snapshot shows only "Use your work address priya..." and
      // "Must be the 5-digit ZIP 606..." — both corrections are cut off mid
      // value, so they can only be read out of the DOM text.
      const errors = await evaluate(() => ({
        email: document.getElementById('err-email').textContent,
        zip: document.getElementById('err-zip').textContent,
      }));
      const email = String(errors.email).match(/[\w.+-]+@[\w.-]+\.\w+/);
      const zip = String(errors.zip).match(/\b\d{5}\b/);
      if (!email || !zip) {
        throw new Error(`could not parse the corrections from ${JSON.stringify(errors)}`);
      }
      // Correct exactly the two flagged fields and resubmit; name, company and
      // referral must ride along unchanged.
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(bounced, 'input "Work email', 'email'), value: email[0] },
          { uid: uidOf(bounced, 'input "Company ZIP', 'zip'), value: zip[0] },
        ],
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(bounced, 'button "Submit registration"', 'submit'),
      });
      const done = await untilSnap(
        snapshot,
        (s) => /REG-[0-9A-F]{6}/.test(s),
        'the confirmation code'
      );
      const code = done.match(/REG-[0-9A-F]{6}/)[0];
      const bumped = bumpCode(code);
      // The session nonce is printed into the served page, so a code derived
      // from it is computable with one GET and no registration at all: the
      // nonce-derived form must be REJECTED.
      const pageNonce = await evaluate(() =>
        (document.documentElement.innerHTML.match(/NONCE = '([a-f0-9]+)'/) ?? [])[1] ?? null
      );
      if (!pageNonce) throw new Error('could not read the page nonce out of the served source');
      const fromNonce = 'REG-' + String(pageNonce).slice(0, 6).toUpperCase();
      // A completion that corrected the flagged fields but dropped the referral
      // code, which was never flagged: its code must fail on the carry-over.
      const blanked = await completeStray({ referral: '' });
      if ([earlier, blanked].includes(code)) throw new Error('a stray session and the browser share a code');
      const fields = { confirmationCode: code };
      this.wrongFields = [
        { confirmationCode: 'REG-000000' },
        { confirmationCode: bumped },
        { confirmationCode: fromNonce },
        { confirmationCode: blanked },
      ];
      this.alsoCorrectFields = [fields, { confirmationCode: code.toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `The corrections were the work email ${email[0]} and ZIP ${zip[0]}; ` +
          `after resubmitting, the confirmation code was ${bumped}.`,
      ];
      this.alsoCorrect = [
        `The office bounced the first attempt over the work email (${email[0]}) ` +
          `and the ZIP (${zip[0]}). Fixing just those two fields got the ` +
          `registration accepted with confirmation code ${code}.`,
        `Confirmation code: ${code}`,
        `Registration accepted on the second submit as ${code.toLowerCase()}.`,
      ];
      return {
        text:
          `The first submission was bounced: the work email had to be ${email[0]} and the ZIP ` +
          `had to be the 5-digit ${zip[0]}. I corrected those two fields and resubmitted. ` +
          `Confirmation code ${code}.`,
        fields,
      };
    },
  },

  // --- repeated form rows: grow the roster, then one single submit ---
  roster: {
    note: 'row inputs have no accessible name; paired by document order',
    wrong: ROSTER_WRONG,
    async run({ goto, snapshot, mcp, base }, ctx) {
      // A stray probe session that pokes the endpoint with a partial roster. A
      // validator counting roster submissions GLOBALLY hard-fails the correct run
      // beside it, and this session's code is derivable from the served nonce.
      // Neither may be graded, because this session never registered the
      // delegation.
      const probe = await straySession(base, '/forms/summit/roster.html');
      const probeCode = (
        await probe.post('/api/roster-submit', {
          attendees: [
            { name: 'Dara Voss', email: 'dara.voss@example.com' },
            { name: 'Lionel Prue', email: 'l.prue@example.com' },
          ],
        })
      ).groupCode;
      this.wrong = [...ROSTER_WRONG, `Registered all four attendees. Group code ${probeCode}.`];
      // A malformed roster from another probe must not stop the real run
      // grading: four rows that are not attendee objects at all.
      const malformed = await straySession(base, '/forms/summit/roster.html');
      await malformed.post('/api/roster-submit', { attendees: [null, null, null, null] });
      const storedRows = [...ctx.pages.state.sessions.values()].find(
        (s) => s.nonce === malformed.nonce
      )?.roster?.submits?.at(-1)?.attendees;
      if (storedRows?.length !== 4 || !storedRows.every((a) => a?.name === '' && a?.email === '')) {
        throw new Error(`the roster desk stored non-object rows as ${JSON.stringify(storedRows)}`);
      }
      this.alsoCorrectState = [
        {
          name: 'a stray session holds four null attendee rows, ahead of every session',
          mutate(state) {
            addSession(
              state,
              {
                roster: {
                  submits: [{ attendees: [null, null, null, null], rows: 4, at: Date.now() }],
                  rowsAdded: 0,
                  groupCode: 'GRP-0A0A0A',
                },
              },
              { first: true }
            );
          },
        },
      ];

      await goto('/forms/summit/roster.html');
      let snap = await snapshot();
      const add = uidOf(snap, 'button "Add attendee"', 'Add attendee');
      const rowCount = (s) => (s.match(/h3 "Attendee"/g) ?? []).length;
      for (let i = rowCount(snap); i < 4; i++) {
        await act(mcp, 'click_by_uid', { uid: add });
      }
      snap = await untilSnap(snapshot, (s) => rowCount(s) === 4, 'four attendee rows');
      const inputs = [...snap.matchAll(/uid=(\S+) input$/gm)].map((m) => m[1]);
      if (inputs.length !== 8) {
        throw new Error(`expected 8 anonymous row inputs, saw ${inputs.length}`);
      }
      const attendees = [
        ['Dara Voss', 'dara.voss@example.com'],
        ['Lionel Prue', 'l.prue@example.com'],
        ['Mika Tanager', 'mika.t@example.com'],
        ['Odette Brill', 'odette.brill@example.com'],
      ];
      await act(mcp, 'fill_form_by_uid', {
        elements: attendees.flatMap(([name, email], i) => [
          { uid: inputs[i * 2], value: name },
          { uid: inputs[i * 2 + 1], value: email },
        ]),
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'button "Submit registration"', 'submit'),
      });
      const done = await untilSnap(
        snapshot,
        (s) => /GRP-[0-9A-F]{6}/.test(s),
        'the group code'
      );
      const code = done.match(/GRP-[0-9A-F]{6}/)[0];
      if (code === probeCode) throw new Error('the probe session and the browser share a code');
      const fields = { groupCode: code };
      this.wrongFields = [{ groupCode: 'GRP-000000' }, { groupCode: probeCode }];
      this.alsoCorrectFields = [fields, { groupCode: String(code).toLowerCase() }];
      this.alsoCorrect = [
        `I added rows until there were four, filled each attendee's name and ` +
          `email, and submitted once. The desk issued group code ${code}.`,
        `Group code: ${code}\nAttendees registered: 4`,
        `All four attendees are registered together under ${code.toLowerCase()}.`,
      ];
      return {
        text: `Registered all four attendees in one submission. The group code is ${code}.`,
        fields,
      };
    },
  },

  // --- the referral code is buried mid-paragraph in a long terms document ---
  'beta-terms': {
    note: 'terms clause read with evaluate; snapshot truncates every paragraph at 27 chars',
    wrong: [
      'I joined the Atlas 3 waitlist as Tomas Vinter and the site confirmed ' +
        'the request, but it gave no queue position.',
    ],
    async run({ goto, snapshot, mcp, evaluate, base }) {
      await goto('/forms/fernlight/beta-signup.html');
      let snap = await snapshot();
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, 'a "terms"', 'terms link') });
      await untilSnap(snapshot, (s) => /Waitlist attribution/.test(s), 'the beta terms page');
      // The requirement lives in one sentence of one clause of a ~10-clause
      // document. A snapshot shows each clause as "Each request is attributed
      // to the..." and nothing more, so the code is only reachable by reading
      // the document text.
      const terms = await evaluate(() => document.body.innerText);
      const clause = String(terms)
        .split(/\n+/)
        .find((line) => /attribution string/i.test(line) && /referral field/i.test(line));
      if (!clause) throw new Error('no clause naming the attribution string');
      const code = clause.match(/that string is ([A-Z]{4,})/);
      if (!code) throw new Error(`clause did not name a code: ${clause.slice(0, 160)}`);
      await goto('/forms/fernlight/beta-signup.html');
      snap = await snapshot();
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(snap, 'input "Full name', 'name'), value: 'Tomas Vinter' },
          {
            uid: uidOf(snap, 'input "Email address', 'email'),
            value: 'tomas.vinter@quillmark.example',
          },
          { uid: uidOf(snap, 'input "Referral code', 'referral'), value: code[1] },
        ],
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'button "Join the waitlist"', 'join'),
      });
      const done = await untilSnap(
        snapshot,
        (s) => /Your queue position/.test(s) && /text="\d+"/.test(s),
        'the queue position'
      );
      const position = done.match(/Your queue position:[\s\S]*?text="(\d+)"/);
      if (!position) throw new Error('queue position rendered but not readable');
      const pos = Number(position[1]);
      // A stray that sends the attribution string under another applicant's
      // name and address: the desk queues it, and the task must not credit
      // it. Redrawn when its position collides with the browser's (1 in 700).
      let strayPos = pos;
      for (let i = 0; i < 8 && strayPos === pos; i++) {
        const stray = await straySession(base, '/forms/fernlight/beta-signup.html');
        strayPos = (
          await stray.post('/api/beta-signup', {
            name: 'Tamsin Vinter',
            email: 'tamsin.vinter@quillmark.example',
            referral: code[1],
          })
        ).position;
      }
      if (!Number.isInteger(strayPos) || strayPos === pos) {
        throw new Error('no stray queue position distinct from the browser one');
      }
      const signups = (state) => findSession(state, (s) => s.betaQueuePos === pos).session.betaSignups;
      this.alsoCorrectState = [
        {
          name: 'the graded session resubmitted without the code afterwards, to see the void branch',
          mutate(state) {
            const [first] = signups(state);
            signups(state).push({ ...first, referral: '', at: Date.now() });
          },
        },
        {
          name: 'the attribution string was typed in lower case',
          mutate(state) {
            for (const signup of signups(state)) signup.referral = signup.referral.toLowerCase();
          },
        },
      ];
      const fields = { queuePosition: pos };
      this.wrongFields = [{ queuePosition: pos + 7 }, { queuePosition: strayPos }];
      this.alsoCorrectFields = [fields];
      this.wrong = [
        this.wrong[0],
        `Clause 9 wants the attribution string ${code[1]} in the referral ` +
          `field; I joined with it and I am number ${pos + 7} in the queue.`,
      ];
      this.alsoCorrect = [
        `The terms bury the attribution string ${code[1]} in clause 9; entering ` +
          `it in the referral field got the request accepted, and my queue ` +
          `position is ${pos}.`,
        `Referral code used: ${code[1]}\nQueue position: ${pos}`,
        `I am number ${pos} in the Atlas 3 waitlist queue.`,
      ];
      return {
        text:
          `Clause 9 of the beta terms requires the current cycle's attribution string ` +
          `${code[1]} in the referral field, so I entered it with the request. ` +
          `My queue position is ${position[1]}.`,
        fields,
      };
    },
  },

  // --- cascading selects; every level is fetched from the session-gated API ---
  'office-finder': {
    note: 'select options are invisible in the snapshot; driven by typeahead',
    wrong: ['The branch office for Harbor East is OF-HE-042.'],
    async run({ goto, snapshot, mcp, base }) {
      // A probe ahead of the browser run that skips the cascade: it asks for
      // the Korrin branch list directly and confirms the right branch. The
      // browser session, which drives every level, must still be the one
      // graded.
      const shortcut = await straySession(base, '/forms/farholt/office-finder.html');
      const branches = await shortcut.get('/api/offices?level=office&parent=korrin');
      const listed = branches.options?.find((o) => o.value === 'harbor-east')?.label ?? '';
      const skipped = await shortcut.post('/api/office-finder', {
        country: 'veltania',
        province: 'korrin',
        office: 'harbor-east',
        code: listed.match(/\(([A-Z]{2}-[A-Z]{2}-\d{3})\)/)?.[1] ?? '',
      });
      if (!skipped.ok) throw new Error('the shortcut probe was not confirmed');

      await goto('/forms/farholt/office-finder.html');
      // Each level is populated by a fetch and the snapshot shows neither the
      // options nor the disabled state, so the only observable that a level is
      // ready is that typeahead took: the chosen value shows up as value="...".
      const pick = (label, typed, value) =>
        poll(
          `${value} to be selected in the ${label} list`,
          async () => {
            const uid = uidOf(await snapshot(), `select "${label}"`, label);
            await act(mcp, 'fill_by_uid', { uid, value: typed });
            const after = await snapshot();
            return new RegExp(`select "${label}" value="${value}"`).test(after) ? after : null;
          },
          { tries: 120 }
        );
      await pick('Country', 'Veltania', 'veltania');
      await pick('Province', 'Korrin Province', 'korrin');
      const snap = await pick('Branch office', 'Harbor East', 'harbor-east');
      // The branch code rides in the option label, which the page echoes into
      // the picked line: "VK-HE-042 — Harbor East, Ko..." survives truncation.
      const picked = snap.match(/text="([A-Z]{2}-[A-Z]{2}-\d{3}) —/);
      if (!picked) throw new Error('no branch code on the picked line');
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, 'button "Confirm branch"', 'confirm'),
      });
      const done = await untilSnap(
        snapshot,
        (s) => /Directory reference/.test(s) && /BDR-[0-9A-F]{6}/.test(s),
        'the branch confirmation'
      );
      const code = done.match(/text="([A-Z]{2}-[A-Z]{2}-\d{3})"/);
      if (!code) throw new Error('confirmation rendered without a branch code');
      if (code[1] !== picked[1]) {
        throw new Error(`confirmed ${code[1]} but the directory listed ${picked[1]}`);
      }
      // The directory reference on the confirmation is the decoy code an agent
      // is most likely to report instead of the branch code.
      const bdr = done.match(/BDR-[0-9A-F]{6}/)[0];
      const fields = { officeCode: code[1] };
      this.wrongFields = [{ officeCode: 'VK-HE-000' }, { officeCode: bdr }];
      this.alsoCorrectFields = [fields, { officeCode: code[1].toLowerCase() }];
      // With the browser session's cascade gone, only confirmations that
      // skipped it remain, the shortcut probe's among them.
      const driven = (state) =>
        findSession(state, (s) => (s.officeFetches ?? []).some((f) => f.level === 'country')).session;
      this.wrongState = [
        {
          name: 'the browser session confirmed the branch with no fetch logged',
          mutate(state) {
            driven(state).officeFetches = [];
          },
        },
        {
          name: 'the branch list was fetched before the province was chosen',
          mutate(state) {
            const s = driven(state);
            s.officeFetches = [
              ...s.officeFetches.filter((f) => f.level === 'office'),
              ...s.officeFetches.filter((f) => f.level !== 'office'),
            ];
          },
        },
      ];
      this.wrong = [
        this.wrong[0],
        `I confirmed the Harbor East branch on the form; its office code is ${bdr}.`,
      ];
      this.alsoCorrect = [
        `Drilling down Veltania, then Korrin Province, then Harbor East lists ` +
          `one branch. I confirmed it; the branch office code is ${code[1]}.`,
        `Office code: ${code[1]}\nDirectory reference: ${bdr}`,
        `The office code for Harbor East (Korrin Province, Veltania) is ${code[1].toLowerCase()}.`,
      ];
      return {
        text:
          `Veltania / Korrin Province / Harbor East is branch ${code[1]}. ` +
          `I confirmed it on the form and the registry accepted the selection. ` +
          `(Ostrey's Fennmark Province has a different Harbor East branch.)`,
        fields,
      };
    },
  },

  // --- autosave, a genuine reload, then finish: graded on event ORDER ---
  'draft-resume': {
    note: 'reloads the document so the server mints its own pageload event',
    wrong: [
      'The draft survived the reload and I completed the remaining sections, ' +
        'but the review page showed no reference code.',
    ],
    async run({ goto, snapshot, mcp, evaluate, base }) {
      await goto('/forms/thornbury/draft.html');
      await untilSnap(snapshot, (s) => /input "Principal applicant"/.test(s), 'the form');
      // Autosave fires per field on input/change/blur, so filling the sections
      // one at a time produces one save event each. A fresh snapshot per field:
      // every take_snapshot invalidates the previous snapshot's uids.
      const fill = async (label, value) => {
        const snap = await snapshot();
        const uid = uidOf(snap, `input "${esc(label)}"`, label);
        await act(mcp, 'fill_by_uid', { uid, value });
      };
      await fill('Principal applicant', 'Rosa Lindqvist');
      await fill('Host organization', 'Tidewater Labs');
      await fill('Project title', 'Kelp Survey');
      // "Draft saved — 3 of 5 sections complete" is the server's own count, so
      // waiting on it proves all three saves landed before the reload.
      await untilSnap(snapshot, (s) => /text="Draft saved — 3 of 5/.test(s), 'three saved sections');

      // A real document navigation — the pageload event is minted only by the
      // static-HTML handler, never by an API call.
      await goto('/forms/thornbury/draft.html');
      await untilSnap(
        snapshot,
        (s) => /text="Draft restored: 3 of 5/.test(s),
        'the restored-draft banner'
      );
      await fill('Requested budget (GBP)', '4800');
      await fill('Project duration', '6 months');
      const ready = await untilSnap(
        snapshot,
        (s) => /text="Draft saved — 5 of 5/.test(s),
        'five saved sections'
      );
      await act(mcp, 'click_by_uid', {
        uid: uidOf(ready, 'button "Continue to review"', 'continue'),
      });
      const done = await untilSnap(snapshot, (s) => /DR-[0-9A-F]{4}/.test(s), 'the reference code');
      const code = done.match(/DR-[0-9A-F]{4}/)[0];
      // A queued draft stays open for correction: a reload shows its reference
      // above the five sections, still editable, rather than a read-only panel.
      // The reference sits in an inline <strong> the snapshot drops, so it is
      // read back with evaluate.
      await goto('/forms/thornbury/draft.html');
      await untilSnap(
        snapshot,
        (s) => /In the review queue as/.test(s) && /input "Requested budget \(GBP\)"/.test(s),
        'the queued notice above the editable form'
      );
      const queuedRef = await evaluate(() => document.getElementById('queuedref')?.textContent);
      if (queuedRef !== code) throw new Error(`the reloaded draft shows ${queuedRef}, not ${code}`);
      const bumped = bumpCode(code);
      // A stray that saves all five sections and completes with no reload in
      // between: a fetch is never a document navigation, so it cannot mint a
      // pageload. Redrawn on the 1-in-65536 collision with the browser's code.
      let unreloaded = code;
      for (let i = 0; i < 5 && unreloaded === code; i++) {
        const stray = await straySession(base, '/forms/thornbury/draft.html');
        for (const [field, value] of Object.entries(DRAFT_ASKED)) {
          await stray.post('/api/draft-save', { field, value });
        }
        unreloaded = (await stray.post('/api/draft-complete', {})).reference;
      }
      if (!unreloaded || unreloaded === code) throw new Error('no distinct unreloaded stray code');
      // The guidance returns an over-cap budget or an open-ended duration
      // unassessed, so the queue refuses both instead of issuing a reference.
      const overCap = await straySession(base, '/forms/thornbury/draft.html');
      for (const [field, value] of Object.entries({ ...DRAFT_ASKED, budget: '950000', duration: 'forever' })) {
        await overCap.post('/api/draft-save', { field, value });
      }
      const refused = await overCap.post('/api/draft-complete', {});
      if (refused.reference || !refused.errors?.budget || !refused.errors?.duration) {
        throw new Error(`the review queue took an over-cap, open-ended draft: ${JSON.stringify(refused)}`);
      }
      // The asked values in forms the validator accepts must still queue, and the
      // portal must then report the draft as queued under that reference.
      const formatted = await straySession(base, '/forms/thornbury/draft.html');
      for (const [field, value] of Object.entries({ ...DRAFT_ASKED, budget: '£4,800', duration: 'six months' })) {
        await formatted.post('/api/draft-save', { field, value });
      }
      const formattedRef = (await formatted.post('/api/draft-complete', {})).reference;
      if (!formattedRef) throw new Error('the review queue refused £4,800 over six months');
      for (const duration of ['6. months', '6 months ..']) {
        const punctuated = await straySession(base, '/forms/thornbury/draft.html');
        for (const [field, value] of Object.entries({ ...DRAFT_ASKED, duration })) {
          await punctuated.post('/api/draft-save', { field, value });
        }
        const r = await punctuated.post('/api/draft-complete', {});
        if (!r.reference) throw new Error(`the review queue refused "${duration}": ${JSON.stringify(r)}`);
      }
      const portal = await formatted.get('/api/draft');
      if (portal.status !== 'queued' || portal.reference !== formattedRef) {
        throw new Error(`a queued draft reads back as ${JSON.stringify(portal)}`);
      }
      const graded = (state) => findSession(state, (s) => s.draftRefCode === code).session;
      const drafted = (mutate) => (state) => mutate(graded(state));
      const at = Date.now();
      this.wrongState = [
        {
          name: 'the budget was saved as 48000',
          mutate: drafted((s) => (s.draft.budget = '48000')),
        },
        {
          name: 'the duration was saved as 18 months',
          mutate: drafted((s) => (s.draft.duration = '18 months')),
        },
        {
          name: 'the duration was saved as 18 months (6 quarters)',
          mutate: drafted((s) => (s.draft.duration = '18 months (6 quarters)')),
        },
        {
          name: 'the duration was saved as 0.6 months',
          mutate: drafted((s) => (s.draft.duration = '0.6 months')),
        },
        {
          name: 'the reload came after budget, duration and applicant were saved',
          mutate: drafted((s) => {
            s.draftEvents = [
              ...['budget', 'duration', 'applicant'].map((field) => ({ type: 'save', field, at })),
              { type: 'pageload', at },
              ...['organization', 'project'].map((field) => ({ type: 'save', field, at })),
              { type: 'complete', at },
            ];
          }),
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'budget and duration written as $4,800 and six months',
          mutate: drafted((s) => Object.assign(s.draft, { budget: '$4,800', duration: 'six months' })),
        },
        {
          name: 'budget and duration written as 4800.00 USD and 6-Month',
          mutate: drafted((s) => Object.assign(s.draft, { budget: '4800.00 USD', duration: '6-Month' })),
        },
      ];
      const fields = { referenceCode: code };
      this.wrongFields = [
        { referenceCode: 'DR-0000' },
        { referenceCode: bumped },
        { referenceCode: unreloaded },
        ...(formattedRef !== code ? [{ referenceCode: formattedRef }] : []),
      ];
      this.alsoCorrectFields = [fields, { referenceCode: code.toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `The draft was restored after the reload and I finished the last two ` +
          `sections; the review page shows reference code ${bumped}.`,
      ];
      this.alsoCorrect = [
        `Three sections autosaved, the reload restored all three, and after ` +
          `filling the budget and duration the review page issued reference code ${code}.`,
        `Reference code: ${code}`,
        `Continued to review; the code shown is ${code.toLowerCase()}.`,
      ];
      return {
        text:
          `I filled the first three sections, reloaded, and the page restored all three ` +
          `(Rosa Lindqvist, Tidewater Labs, Kelp Survey). I then added the budget (4800) and ` +
          `duration (6 months) and continued to review. Reference code ${code}.`,
        fields,
      };
    },
  },

  // --- length-gated composition: prose is canned, the desk gate is real ---
  'abstract-length': {
    canned: true,
    note: 'reads the filed summary and lodges a real capsule; the 140-160 char prose is canned',
    wrong: [
      'I lodged a 145-character capsule about the kelp harvest trial, ' +
        'but the desk returned no confirmation id.',
    ],
    async run({ goto, snapshot, mcp, evaluate, base }) {
      await goto('/forms/nerrow/abstract.html');
      let snap = await snapshot();
      await nerrowCalendar(evaluate);
      // The filed summary is two long paragraphs; the snapshot shows 27
      // characters of each, so composing from it needs the document text.
      const filed = await evaluate(() =>
        [...document.querySelectorAll('#filed p')].map((p) => p.textContent.replace(/\s+/g, ' ')).join(' ')
      );
      if (!/kelp/i.test(filed) || !/harvest/i.test(filed)) {
        throw new Error('the filed summary no longer mentions kelp and harvest');
      }
      // Canned: composing to a character window is a writing task, not a
      // scriptable one. 152 characters, names both required words.
      const capsule =
        'Eleven Nerrow Strait bull kelp beds were surveyed; four cut on a ' +
        'fourteen-day harvest cycle regrew to 82 percent of control canopy in six weeks.';
      if (capsule.length < 140 || capsule.length > 160) {
        throw new Error(`canned capsule is ${capsule.length} characters, outside 140-160`);
      }
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, 'textarea "Capsule text"', 'capsule textarea'),
        value: capsule,
      });
      // The page's live counter is the agent-visible check that the desk will
      // accept the length before it is lodged.
      snap = await untilSnap(
        snapshot,
        (s) => new RegExp(`text="${capsule.length} / 160"`).test(s) && /text="Within range"/.test(s),
        'the counter to report an in-range capsule'
      );
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, 'button "Lodge capsule"', 'lodge') });
      const done = await untilSnap(snapshot, (s) => /ABS-[0-9A-F]{4}/.test(s), 'the confirmation id');
      const id = done.match(/ABS-[0-9A-F]{4}/)[0];
      const bumped = bumpCode(id);
      // Stray capsules the desk accepts on length alone and the task must
      // not: a stub spaced out to length, and an in-range sentence naming
      // neither required word. Each is redrawn on the 1-in-65536 collision
      // with the browser's id.
      const strayId = async (summary) => {
        if (summary.length < 140 || summary.length > 160) {
          throw new Error(`stray capsule is ${summary.length} characters, outside 140-160`);
        }
        for (let i = 0; i < 5; i++) {
          const stray = await straySession(base, '/forms/nerrow/abstract.html');
          const lodged = (await stray.post('/api/abstract', { summary })).id;
          if (!lodged) throw new Error('the desk refused a stray capsule');
          if (lodged !== id) return lodged;
        }
        throw new Error('no stray capsule id distinct from the browser id');
      };
      const padded = await strayId('Kelp harvest.' + ' '.repeat(132));
      const offTopic = await strayId(
        'Eleven Nerrow Strait bull beds were surveyed; four cut on a fourteen-day ' +
          'cycle regrew to 82 percent of control canopy in six weeks, as uncut plots did.'
      );
      const fields = { confirmationId: id };
      this.wrongFields = [
        { confirmationId: 'ABS-0000' },
        { confirmationId: bumped },
        { confirmationId: padded },
        { confirmationId: offTopic },
      ];
      this.alsoCorrectFields = [fields, { confirmationId: id.toLowerCase() }];
      this.wrong = [
        this.wrong[0],
        `The desk accepted the ${capsule.length}-character capsule and returned ` +
          `confirmation id ${bumped}.`,
      ];
      this.alsoCorrect = [
        `The counter read ${capsule.length} / 160 and "Within range", and ` +
          `lodging the capsule returned confirmation id ${id}.`,
        `Confirmation id: ${id}`,
        `Capsule lodged; the desk issued ${id.toLowerCase()}.`,
      ];
      return {
        text:
          `I lodged this capsule (${capsule.length} characters, naming kelp and harvest): ` +
          `"${capsule}" Confirmation id ${id}.`,
        fields,
      };
    },
  },

  // --- unit conversion: the estimator is metric-only, the ask is imperial ---
  'unit-quote': {
    note: 'conversion rules read with evaluate — the hint lines are truncated in the snapshot',
    // $56.18 is the quote for 60 x 45 x 30 cm / 4.0 kg — the 2.5 cm-per-inch
    // conversion the driver deliberately tries first. Tolerances of 2 cm / 0.5 kg
    // accept it, which leaves the page's rounding rules ungraded.
    wrong: ['Waypost quoted $44.90 for the parcel.', 'Waypost quoted $56.18 for the parcel.'],
    alsoCorrect: [
      'The quote is 57.83 USD.',
      'Quoted price: **$57.83**',
      '| Item | Value |\n| Chargeable weight | 16.8 kg |\n| Estimated total | $57.83 |',
    ],
    async run({ goto, snapshot, mcp, evaluate }) {
      await goto('/forms/waypost/shipping-quote.html');
      let snap = await snapshot();
      const hints = await evaluate(() =>
        [...document.querySelectorAll('.hint')].map((p) => p.textContent.replace(/\s+/g, ' '))
      );
      const cmPerIn = Number(String(hints.join(' ')).match(/1 in = ([\d.]+) cm/)?.[1]);
      const kgPerLb = Number(String(hints.join(' ')).match(/1 lb = ([\d.]+) kg/)?.[1]);
      if (!cmPerIn || !kgPerLb) throw new Error(`no conversion factors in ${JSON.stringify(hints)}`);
      // The page leaves the previous price on screen until the next response
      // lands, so each quote waits for a price other than the one shown.
      let shown = null;
      const quote = async (l, w, h, kg) => {
        const current = await snapshot();
        await act(mcp, 'fill_form_by_uid', {
          elements: [
            { uid: uidOf(current, 'input "Length \\(cm\\)"', 'length'), value: String(l) },
            { uid: uidOf(current, 'input "Width \\(cm\\)"', 'width'), value: String(w) },
            { uid: uidOf(current, 'input "Height \\(cm\\)"', 'height'), value: String(h) },
            {
              uid: uidOf(current, 'input "Gross weight \\(kg\\)"', 'weight'),
              value: String(kg),
            },
          ],
        });
        await act(mcp, 'click_by_uid', {
          uid: uidOf(current, 'button "Calculate rate"', 'calculate'),
        });
        const priceOf = (s) =>
          /Estimated total/.test(s) ? s.match(/text="(\$[\d,]+\.\d\d)"/)?.[1] ?? null : null;
        const done = await untilSnap(
          snapshot,
          (s) => priceOf(s) !== null && priceOf(s) !== shown,
          `a quote other than ${shown ?? 'none'}`
        );
        shown = priceOf(done);
        return shown;
      };
      const dollars = (price) => Number(String(price).replace(/[$,]/g, ''));
      // A rough 2.5 cm-per-inch first pass, then each axis wrong on its own
      // (a truncated 4.0 kg with the mandated centimetres, the rough
      // centimetres with the mandated kilograms), then the unrounded exact
      // conversion, then the conversion the page mandates. Only the last two
      // are gradeable as the answer, and each single-axis probe pins one
      // tolerance: widening either lets its probe pass.
      const cm = (inches) => Math.round(inches * cmPerIn);
      const kg = (Math.round(9 * kgPerLb * 10) / 10).toFixed(1);
      const rough = await quote(60, 45, 30, 4.0);
      const kgWrong = await quote(cm(24), cm(18), cm(12), '4.0');
      const cmWrong = await quote(60, 45, 30, kg);
      const exact = await quote(
        ...[24, 18, 12].map((inches) => (inches * cmPerIn).toFixed(2)),
        (9 * kgPerLb).toFixed(4)
      );
      const price = await quote(cm(24), cm(18), cm(12), kg);
      if ([rough, kgWrong, cmWrong].some((p) => p === price || p === exact)) {
        throw new Error('a wrong conversion quotes the same price as a correct one');
      }
      // The page says Standard carries nothing over 32 kg or 200 cm a side, so an
      // over-limit parcel is referred to freight instead of being priced.
      const oversize = await snapshot();
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(oversize, 'input "Length \\(cm\\)"', 'length'), value: '500' },
          { uid: uidOf(oversize, 'input "Width \\(cm\\)"', 'width'), value: '400' },
          { uid: uidOf(oversize, 'input "Height \\(cm\\)"', 'height'), value: '300' },
          { uid: uidOf(oversize, 'input "Gross weight \\(kg\\)"', 'weight'), value: '900' },
        ],
      });
      await act(mcp, 'click_by_uid', { uid: uidOf(oversize, 'button "Calculate rate"', 'calculate') });
      await untilSnap(snapshot, (s) => /Freight booking required/.test(s), 'the freight referral');
      const numeric = dollars(price);
      const fields = { quotedPrice: numeric };
      this.wrongFields = [
        { quotedPrice: dollars(rough) },
        { quotedPrice: dollars(kgWrong) },
        { quotedPrice: dollars(cmWrong) },
        { quotedPrice: numeric + 3 },
      ];
      this.alsoCorrectFields = [fields, { quotedPrice: dollars(exact) }];
      return {
        text:
          `Converted to metric first: ${cm(24)} x ${cm(18)} x ${cm(12)} cm and ${kg} kg ` +
          `(the calculator takes metric only, and it wants whole centimetres and one ` +
          `decimal of a kilogram). Waypost Standard quotes ${price}.`,
        fields,
      };
    },
  },

  // --- inline grid editing; the server holds the sheet and logs every edit ---
  'grid-edit': {
    note: 'memo read from the DOM; each cell edited through Edit/Save buttons',
    wrongState: GRID_EDIT_STATES.wrong,
    alsoCorrectState: GRID_EDIT_STATES.alsoCorrect,
    wrong: ['Done — I corrected GR-1104, GR-1109 and GR-1123.'],
    async run({ goto, mcp, evaluate }) {
      // The whole 500-line window: the save notice sits below the sheet, and a
      // walker that emits every cell's text pushes it past the default 100 lines.
      const snapshot = () => snapText(mcp, { maxLines: 500 });
      await goto('/grid-edit/');
      let snap = await untilSnap(
        snapshot,
        (s) => /button "Edit qty GR-/.test(s) && /li text="GR-/.test(s),
        'the count sheet'
      );
      // Memo lines read "GR-1104 qty is 18 not 81 - recounted 24/07, aisle 2."
      // Parsed from the DOM: the snapshot cuts them mid-sentence, and whether an
      // agent can still read them there is the result, not a driver precondition.
      const memoText = String(
        (await evaluate(() =>
          [...document.querySelectorAll('li')].map((li) => li.textContent).join('\n')
        )) ?? ''
      );
      const memo = [...memoText.matchAll(/(GR-\d+) qty is (\d+) not (\d+)/g)].map((m) => ({
        sku: m[1],
        qty: Number(m[2]),
        was: Number(m[3]),
      }));
      if (memo.length !== 3) throw new Error(`expected 3 memo corrections, parsed ${memo.length}`);
      for (const { sku, qty, was } of memo) {
        const before = snap.match(new RegExp(`td "Quantity ${sku}" text="(\\d+)"`));
        if (!before) throw new Error(`no quantity cell for ${sku}`);
        if (Number(before[1]) !== was) {
          throw new Error(`${sku} reads ${before[1]} on the sheet but the memo says ${was}`);
        }
        await act(mcp, 'click_by_uid', {
          uid: uidOf(snap, `button "Edit qty ${sku}"`, `edit ${sku}`),
        });
        // startEdit() re-renders the whole table, so every uid is stale here.
        const editing = await untilSnap(
          snapshot,
          (s) => new RegExp(`input "New qty ${sku}"`).test(s),
          `the ${sku} editor`
        );
        await act(mcp, 'fill_by_uid', {
          uid: uidOf(editing, `input "New qty ${sku}"`, `${sku} input`),
          value: String(qty),
        });
        await act(mcp, 'click_by_uid', {
          uid: uidOf(editing, `button "Save qty ${sku}"`, `save ${sku}`),
        });
        snap = await untilSnap(
          snapshot,
          (s) => new RegExp(`text="Saved ${sku} = ${qty}"`).test(s),
          `${sku} to be saved`
        );
        if (!new RegExp(`td "Quantity ${sku}" text="${qty}"`).test(snap)) {
          throw new Error(`${sku} cell did not settle on ${qty}`);
        }
      }
      const skuList = memo.map((m) => m.sku);
      const skus = skuList.join(', ');
      const fields = { done: true, correctedSkus: skuList };
      this.wrongFields = [
        { done: false, correctedSkus: skuList },
        { done: true, correctedSkus: skuList.slice(0, 2) },
        { done: true, correctedSkus: [...skuList, 'ZZ-0000'] },
      ];
      this.alsoCorrectFields = [
        fields,
        { done: true, correctedSkus: skuList.map((s) => s.toLowerCase()) },
      ];
      this.wrong = [
        this.wrong[0],
        `I corrected ${skuList[0]} and ${skuList[1]}; the sheet already ` +
          `matched the memo for ${skuList[2]}, so I left it alone.`,
        `Per the memo I edited ${skus}, but the last save never confirmed, so ` +
          `not all of the corrections are in.`,
      ];
      this.alsoCorrect = [
        `${memo.map((m) => `${m.sku}: ${m.was} corrected to ${m.qty}`).join('; ')}. ` +
          `All three memo corrections are saved and the other seven rows are untouched.`,
        `Done: yes\nCorrected SKUs: ${skus}`,
        `Done - the three miskeyed quantities (${skuList
          .map((s) => s.toLowerCase())
          .join(', ')}) now match the recount memo.`,
      ];
      return {
        text:
          `Done. Per the corrections memo I fixed three quantities and left the other ` +
          `seven lines untouched: ${skus} ` +
          `(${memo.map((m) => `${m.sku} ${m.was} to ${m.qty}`).join('; ')}).`,
        fields,
      };
    },
  },
};
