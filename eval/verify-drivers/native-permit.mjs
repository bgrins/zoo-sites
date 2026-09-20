// pages/events/ - Ivrelby Borough Council events office (native-permit).
import { ANSWERS } from '../answers.mjs';
import { addSession, bumpCode, clickToPath, findSession, straySession, textOf, uidOf, until } from './lib.mjs';

// The window firefox-devtools-mcp 0.9.15 stored for an ISO fill of 07:30 and
// 19:45 on the pack's date (eval/spikes/native-permit.mjs), and the office's
// own rendering of it. The wrong cases use these constants rather than the
// live run, so a tool release that fixes the fill leaves the gate sound.
const CORRUPT = {
  start: '7071-02-02T07:07',
  end: '7071-02-02T07:19',
  startShown: 'Thu 2 Feb 7071, 07:07',
  endShown: 'Thu 2 Feb 7071, 07:19',
};

const date = ANSWERS.nativePermit.date;
const [Y, M, D] = date.split('-').map(Number);
const weekday = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const longDay = `${DAYS[weekday]} ${D} ${MONTHS[M - 1]} ${Y}`;
const shortDay = `${DAYS[weekday].slice(0, 3)} ${D} ${MONTHS[M - 1].slice(0, 3)} ${Y}`;
const nextDay = `${DAYS[(weekday + 1) % 7]} ${D + 1} ${MONTHS[M - 1]} ${Y}`;

// A datetime-local value in the order firefox-devtools-mcp has to type it:
// fill_by_uid sends keystrokes, and Firefox's en-US control reads them as
// MM/DD/YYYY hh:mm AM, so an ISO value lands as a wrong date (CORRUPT above)
// without an error.
function typedOrder(local) {
  const [date, clock] = local.split('T');
  const [y, m, d] = date.split('-');
  const [h, min] = clock.split(':').map(Number);
  return `${m}/${d}/${y} ${String(h % 12 || 12).padStart(2, '0')}:${String(min).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const tokens = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/,/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !['one', 'a'].includes(w))
  );
const sameTokens = (a, b) => a.size === b.size && [...a].every((w) => b.has(w));

export const DRIVERS = {
  'native-permit': {
    note: 'fills the select and the datetimes naively first, reads the corruption off the check page (an includeAll snapshot, because the page is a <dl>), fixes them through Change (option clicks from an includeAll snapshot, typed-order datetimes), then submits once',
    wrong: ['I applied for the street closure and the permit number is PT-000000.'],
    async run({ mcp, goto, evaluate, snapshot }, ctx) {
      const state = ctx.pages.state;
      const deskOf = (pred) => [...state.sessions.values()].map((s) => s.permitDesk).find((d) => d && pred(d));

      // A probe session outside the browser: it reads its own pack and leaves
      // a draft it never submits. Grading must pick the session whose permit
      // the answer cites, and a draft in another session is not a permit.
      const stray = await straySession(ctx.pages.url, '/events/start.html');
      const strayPack = await stray.get('/api/events/brief');
      if (!strayPack.packRef) throw new Error('the probe session got no organiser pack');
      const strayForm = new URLSearchParams({
        nonce: stray.nonce,
        'event-name': strayPack.event,
        'contact-name': strayPack.contact,
        'contact-email': strayPack.contactEmail,
      });
      strayForm.append('street', 'abrill-street');
      for (const [k, v] of [['start', `${date}T08:00`], ['end', `${date}T20:00`], ['quiet', '19:00'], ['equipment', 'GEN-13P']]) {
        strayForm.append(k, v);
      }
      const strayApply = await fetch(`${ctx.pages.url}/events/apply.html`, {
        method: 'POST',
        headers: { cookie: stray.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: strayForm.toString(),
      });
      if (!/Check your answers/.test(await strayApply.text())) throw new Error('the probe session draft was not echoed');

      // Values are checked against an includeAll snapshot: whether the
      // default one carries them is the surface's result to report, not the
      // fixture's to guarantee.
      const full = async () => textOf(await mcp('take_snapshot', { includeAll: true, maxLines: 400 }));
      await goto('/events/');
      await clickToPath(
        mcp,
        evaluate,
        async () => uidOf(await snapshot(), 'a "Start your application"'),
        'start.html',
        'the application start page'
      );
      await until('the organiser pack to render', () =>
        evaluate(() => document.querySelectorAll('#pack-body .kv').length > 0 && !!document.getElementById('pack-ref').textContent)
      );
      const packSnap = await full();
      const pack = await evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('#pack-body .kv')].map((row) => [
            row.querySelector('.k').textContent,
            row.querySelector('ul')
              ? [...row.querySelectorAll('li')].map((li) => li.textContent)
              : row.querySelector('.v').textContent,
          ])
        )
      );
      const streets = pack['Streets to close'];
      const [from, to] = pack['Road closed'].split(' to ');
      const soundOff = pack['Amplified sound off by'];
      if (pack.Date !== longDay || streets?.length !== 4) {
        throw new Error(`unexpected pack ${JSON.stringify(pack)}`);
      }
      // Every value the form needs is on the page.
      for (const value of [...streets, from, to, soundOff, pack.Equipment, pack.Event, pack.Contact, pack['Contact email']]) {
        if (!packSnap.includes(value)) throw new Error(`pack value "${value}" is not in the includeAll snapshot`);
      }
      const packRef = (await evaluate(() => document.getElementById('pack-ref').textContent)).replace(/^Pack /, '');
      const brief = deskOf((d) => d.brief?.packRef === packRef)?.brief;
      if (!brief) throw new Error('the browser session has no pack server-side');

      // The equipment phrase names one entry of the published list.
      await goto('/events/street-closures.html');
      const listed = await evaluate(() =>
        [...document.querySelectorAll('.codes li')].map((li) => [li.querySelector('.code').textContent, li.querySelector('.what').textContent])
      );
      const matches = listed.filter(([, what]) => sameTokens(tokens(what), tokens(pack.Equipment)));
      if (matches.length !== 1) throw new Error(`equipment "${pack.Equipment}" matched ${matches.length} codes`);
      const code = matches[0][0];
      const listSnap = await full();
      if (!listSnap.includes(code)) throw new Error(`equipment code ${code} is not in the guidance includeAll snapshot`);

      await goto('/events/start.html');
      await clickToPath(mcp, evaluate, async () => uidOf(await snapshot(), 'a "Start now"'), 'apply.html', 'the application form');
      const form = await until('the application form', async () => {
        const s = await snapshot();
        return uidOf(s, 'select "Streets to close"') ? s : null;
      });
      const field = (snap, label) => {
        const uid = uidOf(snap, `\\S+ "${label}"`);
        if (!uid) throw new Error(`no "${label}" field in the snapshot`);
        return uid;
      };
      const fill = (uid, value) => mcp('fill_by_uid', { uid, value });
      const values = () =>
        evaluate(() => ({
          streets: [...document.getElementById('streets').selectedOptions].map((o) => o.textContent),
          start: document.getElementById('start').value,
          end: document.getElementById('end').value,
          quiet: document.getElementById('quiet').value,
          equipment: document.getElementById('equipment').value,
        }));
      const drafts = () => deskOf((d) => d.brief === brief).drafts.length;
      const cont = async (snap, label) => {
        const before = drafts();
        await mcp('click_by_uid', { uid: uidOf(snap, 'button "Continue"') });
        await until(label, async () => drafts() > before && /Check your answers/.test(await evaluate(() => document.title)));
        return snapshot();
      };

      // The naive route: one fill per control, ISO datetimes.
      await fill(field(form, 'Event name'), pack.Event);
      await fill(field(form, 'Contact name'), pack.Contact);
      await fill(field(form, 'Contact email'), pack['Contact email']);
      await fill(field(form, 'Streets to close'), streets.join(', '));
      await fill(field(form, 'Closure starts'), `${date}T${from}`);
      await fill(field(form, 'Closure ends'), `${date}T${to}`);
      await fill(field(form, 'Amplified sound stops'), soundOff);
      await fill(field(form, 'Equipment code'), code);
      // What the naive fill does is the spike's to measure. This driver needs
      // a corrupted first draft to prove the check page makes it legible, so a
      // fill that landed correctly (a fixed tool) is overwritten with the
      // corruption the spike recorded: the one evaluate here that writes.
      const naive = await values();
      if (naive.streets.length !== 1 || naive.start.startsWith(date) || naive.end.startsWith(date)) {
        await evaluate(`() => {
          for (const o of document.getElementById('streets').options) o.selected = o.textContent === ${JSON.stringify(streets[0])};
          document.getElementById('start').value = ${JSON.stringify(CORRUPT.start)};
          document.getElementById('end').value = ${JSON.stringify(CORRUPT.end)};
        }`);
      }
      await cont(await snapshot(), 'the first check page');
      // The corruption is legible on the page: the check page names a single
      // street and a date that is not the pack's.
      const first = deskOf((d) => d.brief === brief).drafts.at(-1);
      if (first.streets.length !== 1 || first.start.startsWith(date) || first.end.startsWith(date)) {
        throw new Error(`the first draft is not the corrupted one: ${JSON.stringify(first)}`);
      }
      const shownStreets = () => evaluate(() => [...document.querySelectorAll('.cya-list li')].map((li) => li.textContent));
      const check1 = await full();
      if (!check1.includes(first.echo.start) || !check1.includes(first.echo.end) || (await shownStreets()).length !== 1) {
        throw new Error('the first check page does not show the corrupted draft');
      }

      // Change: the form comes back holding the draft; fix the streets by
      // clicking options (each click toggles one in a select[multiple]) and
      // type the datetimes in the control's own order.
      await clickToPath(mcp, evaluate, async () => uidOf(await snapshot(), 'a "Change"'), 'change=1', 'the Change link');
      await until('the form to prefill from the draft', async () => (await values()).streets.length === 1);
      for (const name of streets) {
        const selected = (await values()).streets;
        if (selected.includes(name)) continue;
        const all = textOf(await mcp('take_snapshot', { includeAll: true, maxLines: 400 }));
        // includeAll prints an option as: option value="<id>" text="<name>"
        const option = uidOf(all, `option [^\n]*text="${name}"`);
        if (!option) throw new Error(`no option uid for ${name} in the includeAll snapshot`);
        await mcp('click_by_uid', { uid: option });
      }
      const fixSnap = await snapshot();
      await fill(field(fixSnap, 'Closure starts'), typedOrder(`${date}T${from}`));
      await fill(field(fixSnap, 'Closure ends'), typedOrder(`${date}T${to}`));
      const fixed = await values();
      const want = { streets: [...streets].sort(), start: `${date}T${from}`, end: `${date}T${to}`, quiet: soundOff, equipment: code };
      if (JSON.stringify({ ...fixed, streets: [...fixed.streets].sort() }) !== JSON.stringify(want)) {
        throw new Error(`the corrected form does not hold the pack: ${JSON.stringify(fixed)}`);
      }
      await cont(fixSnap, 'the second check page');
      if ((await shownStreets()).length !== 4) throw new Error('the second check page does not list four streets');
      const check2All = await full();
      for (const value of [...streets, `${shortDay}, ${from}`, `${shortDay}, ${to}`, soundOff, pack.Contact, pack['Contact email']]) {
        if (!check2All.includes(value)) throw new Error(`the check page lacks "${value}"`);
      }

      const permitsBefore = deskOf((d) => d.brief === brief).permits.length;
      // A snapshot re-issues uids, so the button's comes from the latest one.
      await mcp('click_by_uid', { uid: uidOf(await snapshot(), 'button "Submit application"') });
      const done = await until('the confirmation page', async () => {
        if (deskOf((d) => d.brief === brief).permits.length === permitsBefore) return null;
        const s = await snapshot();
        return /PT-[0-9A-F]{6}/.test(s) ? s : null;
      });
      const permitNumber = done.match(/PT-[0-9A-F]{6}/)[0];
      const recorded = await evaluate(() => ({
        start: document.getElementById('recorded-start').textContent,
        end: document.getElementById('recorded-end').textContent,
      }));
      const doneAll = await full();
      if (!doneAll.includes(recorded.start) || !doneAll.includes(recorded.end)) {
        throw new Error('the recorded window is not in the confirmation includeAll snapshot');
      }
      const permit = deskOf((d) => d.brief === brief).permits.at(-1);
      if (permit.number !== permitNumber || permit.dest !== 'document') {
        throw new Error(`permit ${JSON.stringify(permit)} is not the confirmed navigation`);
      }

      const fields = { permitNumber, closureStart: recorded.start, closureEnd: recorded.end };
      const shift = (hhmm, minutes) => {
        const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + minutes;
        return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      };
      const pmStart = `${Number(from.slice(0, 2))}:${from.slice(3)}pm`;
      const month3 = MONTHS[M - 1].slice(0, 3);
      const mm = String(M).padStart(2, '0');
      this.wrongFields = [
        { ...fields, permitNumber: bumpCode(permitNumber) },
        { ...fields, permitNumber: null },
        { ...fields, permitNumber: `not ${permitNumber}` },
        { ...fields, closureStart: recorded.end, closureEnd: recorded.start },
        { ...fields, closureEnd: `${shortDay}, ${shift(to, 15)}` },
        { ...fields, closureStart: `${nextDay}, ${from}` },
        { ...fields, closureStart: `${Y}/${mm}/${D + 1} ${from}` },
        { ...fields, closureStart: `${D + 1}-${month3}-${Y} ${from}` },
        { ...fields, closureStart: `${DAYS[(weekday + 1) % 7]}, ${from}` },
        { ...fields, closureStart: `${D} ${MONTHS[M - 1]} ${Y}, ${pmStart}` },
        // The start devtools' ISO fill stores.
        { ...fields, closureStart: CORRUPT.start },
        { ...fields, closureEnd: null },
        { ...fields, closureStart: `${from} to ${to}` },
        { ...fields, closureStart: `${from}-${to}` },
        { ...fields, closureStart: `${from} - ${to}` },
        // The end's hour is past any UTC offset, so this is a second clock time.
        { ...fields, closureStart: `${date} ${from} +${to}` },
      ];
      const h12 = (hhmm) => `${Number(hhmm.slice(0, 2)) % 12 || 12}:${hhmm.slice(3)}${Number(hhmm.slice(0, 2)) < 12 ? 'am' : 'pm'}`;
      this.alsoCorrectFields = [
        fields,
        { permitNumber: permitNumber.toLowerCase() + '.', closureStart: `${date}T${from}`, closureEnd: `${date}T${to}:00` },
        { permitNumber: `Permit ${permitNumber}`, closureStart: `${longDay.replace(/ (\d+) /, ' $1th ')} at ${h12(from)}`, closureEnd: h12(to) },
        { permitNumber, closureStart: typedOrder(`${date}T${from}`), closureEnd: typedOrder(`${date}T${to}`) },
        { permitNumber, closureStart: from, closureEnd: `${to} on ${D}/${mm}/${Y}` },
        { permitNumber, closureStart: `${MONTHS[M - 1]} ${D}, ${Y}, ${h12(from).toUpperCase()}`, closureEnd: `${MONTHS[M - 1]} ${D}, ${Y}, ${h12(to)}` },
        // A non-breaking hyphen, as GPT-family answers often write one.
        { ...fields, permitNumber: permitNumber.replace('-', '\u2011') },
        { permitNumber, closureStart: `${date}T${from}:00+01:00`, closureEnd: `${date}T${to}:00+01:00` },
        { permitNumber, closureStart: `${shortDay}, ${from} (UTC+01:00)`, closureEnd: `${shortDay}, ${to} GMT` },
        { permitNumber, closureStart: `${date} ${from} +01:00`, closureEnd: `${date} ${to}:00 +0100` },
        { permitNumber, closureStart: `${h12(from)} +01:00 on ${longDay}`, closureEnd: `${longDay}, ${to} −01:00` },
        { permitNumber, closureStart: `${from.replace(':', '')} on ${D} ${MONTHS[M - 1]} ${Y}`, closureEnd: `${Y}/${mm}/${D} ${to}` },
        { permitNumber, closureStart: `${D}-${month3}-${Y} ${from}`, closureEnd: to.replace(':', '') },
      ];

      // State cases, each on a copy of the golden state.
      const graded = (s) => findSession(s, (x) => x.permitDesk?.permits.some((p) => p.number === permitNumber)).session.permitDesk;
      const gradedPermit = (s) => graded(s).permits.find((p) => p.number === permitNumber);
      const otherNumber = permitNumber === 'PT-A0A0A0' ? 'PT-B0B0B0' : 'PT-A0A0A0';
      const deskWith = (permits, extra = {}) => ({
        permitDesk: {
          brief: { ...brief },
          briefFetches: 1,
          attempts: [],
          drafts: permits.map((p) => ({ id: p.draft, streets: p.streets, start: p.start, end: p.end, quiet: p.quiet, equipment: p.equipment, eventName: p.eventName, at: Date.now() })),
          permits,
          resubmits: 0,
          ...extra,
        },
      });
      const copyOf = (p, over = {}) => ({ ...p, streets: [...p.streets], draft: 'd0d0d0d0', number: otherNumber, ...over });
      const allStreets = ['abrill-street', 'dremmock-lane', 'fettick-place', 'gilvane-row', 'holbrisk-road', 'lumsick-walk', 'nadderly-road',
        'ombery-terrace', 'pessick-street', 'quistel-lane', 'selbray-court', 'umbrell-yard', 'wrothen-road', 'yarrant-street'];
      const decoy = { 'GEN-35D': 'GEN-35P', 'GEN-35P': 'GEN-35D', 'GEN-58D': 'GEN-58P', 'GEN-13D': 'GEN-13P', 'PA-10': 'PA-20', 'STG-43': 'STG-64', 'GZ-36': 'GZ-66' }[brief.equipment];
      this.wrongState = [
        {
          name: 'a second permit for the same closure in another session',
          mutate: (s) => addSession(s, deskWith([copyOf(gradedPermit(s))])),
        },
        {
          name: 'a second permit minted in a session before the run',
          mutate: (s) => addSession(s, deskWith([copyOf(gradedPermit(s))]), { first: true }),
        },
        {
          name: 'a second permit from another draft in the graded session',
          mutate: (s) => graded(s).permits.push(copyOf(gradedPermit(s))),
        },
        { name: 'every street selected', mutate: (s) => { gradedPermit(s).streets = [...allStreets]; } },
        { name: 'one street short', mutate: (s) => { gradedPermit(s).streets = gradedPermit(s).streets.slice(1); } },
        {
          name: 'one street swapped for another',
          mutate: (s) => {
            const p = gradedPermit(s);
            p.streets = [...p.streets.slice(1), allStreets.find((id) => !p.streets.includes(id))];
          },
        },
        {
          name: 'the window stored from an ISO fill',
          mutate: (s) => Object.assign(gradedPermit(s), { start: CORRUPT.start, end: CORRUPT.end }),
        },
        { name: 'the end a quarter hour late', mutate: (s) => { gradedPermit(s).end = `${date}T${shift(to, 15)}`; } },
        // The answer reports exactly what the office recorded, so only the
        // pack comparisons (startOk, endOk) can fail these.
        {
          name: 'the corrupted window recorded and reported as recorded',
          mutate: (s) => Object.assign(gradedPermit(s), { start: CORRUPT.start, end: CORRUPT.end }),
          fields: { permitNumber, closureStart: CORRUPT.startShown, closureEnd: CORRUPT.endShown },
        },
        {
          name: 'the start a quarter hour late, reported as recorded',
          mutate: (s) => { gradedPermit(s).start = `${date}T${shift(from, 15)}`; },
          fields: { ...fields, closureStart: `${shortDay}, ${shift(from, 15)}` },
        },
        {
          name: 'the end a quarter hour late, reported as recorded',
          mutate: (s) => { gradedPermit(s).end = `${date}T${shift(to, 15)}`; },
          fields: { ...fields, closureEnd: `${shortDay}, ${shift(to, 15)}` },
        },
        { name: 'quiet hours a quarter hour early', mutate: (s) => { gradedPermit(s).quiet = shift(soundOff, -15); } },
        { name: 'the near-miss equipment code', mutate: (s) => { gradedPermit(s).equipment = decoy; } },
        {
          // Binds the permit to its own session's pack: the same permit held by
          // a session whose pack is different closes the wrong streets.
          name: 'the cited permit in a session whose pack names other streets',
          mutate: (s) => {
            const desk = graded(s);
            desk.brief = { ...desk.brief, streets: allStreets.filter((id) => !desk.brief.streets.includes(id)).slice(0, 4) };
          },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a probe session that read its own pack and left a draft',
          mutate: (s) => addSession(s, deskWith([], { drafts: [{ id: 'e0e0e0e0', ...brief, eventName: 'x', at: Date.now() }] }), { first: true }),
        },
        { name: 'the streets recorded in another order', mutate: (s) => { gradedPermit(s).streets.reverse(); } },
        { name: 'the same draft submitted twice, pointing at one permit', mutate: (s) => { graded(s).resubmits += 1; } },
        {
          // Sec-fetch headers are telemetry: the same values posted from a
          // shell, as curl would, still close the right streets.
          name: 'the permit applied for and submitted by fetch from outside the page',
          mutate: (s) => {
            const desk = graded(s);
            const p = gradedPermit(s);
            const shell = { dest: null, mode: 'cors', site: null, fromPage: false };
            Object.assign(desk.attempts.find((a) => a.draft === p.draft), shell);
            Object.assign(p, shell);
          },
        },
      ];
      this.wrong = [
        ...this.wrong,
        `I applied for the closure. Permit ${permitNumber}; the office recorded ${CORRUPT.start} to ${recorded.end}.`,
      ];
      this.alsoCorrect = [
        `Permit number ${permitNumber}. The office recorded the closure from ${recorded.start} to ${recorded.end}.`,
      ];
      return {
        text:
          `I applied for the street closure in the organiser's pack (${streets.join(', ')}). The office issued ` +
          `permit ${permitNumber} and recorded the closure from ${recorded.start} to ${recorded.end}, with ` +
          `amplified sound stopping at ${soundOff} and equipment ${code}. The first attempt kept one street and ` +
          `stored a wrong date; I corrected both on the form before submitting.`,
        fields,
      };
    },
  },
};
