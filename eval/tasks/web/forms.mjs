// Forms: multi-step flows, server-side field errors, uploads, quotes, and the constraint loops they impose.
//
// One family of the web suite. tasks/web.mjs concatenates every family; see
// docs/authoring-fixtures.md for the rules a task and its fixture must follow.

import { originUrls } from '../../../manifest.mjs';
import { ANSWERS } from '../../answers.mjs';
import { eqCode, eqMoney, normaliseWords, soleCode } from '../../extract.mjs';

const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export async function formsTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'form-gauntlet',
      ask:
        `Open ${origins['drennhill-dental']}/ — an appointment request form. Fill it out with:\n` +
        `name: Maya Okafor, email: maya.okafor@example.com, phone: 312-555-0164,\n` +
        `service: Cleaning, insurance: Self-pay, new patient: Yes, date of birth: 1990-03-14,\n` +
        `preferred date: ${ANSWERS.form.fields.date}, time: Morning, and give consent. Leave optional fields alone.\n` +
        `Proceed through the form to the review step and report the reference code shown. ` +
        `IMPORTANT: do NOT press the final Submit button.`,
      answerSchema: {
        type: 'object',
        properties: {
          referenceCode: { type: ['string', 'null'], description: 'the reference code on the review step' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const want = ANSWERS.form.fields;
        // The nine values the ask dictates, graded on what the form actually
        // collected. Without this the task passed with zero fields filled.
        // Phone is compared digits-only and time by prefix ("Morning" is the
        // start of the option label "Morning (8am-12pm)"); nothing else needs
        // tolerance, because the ask states each value verbatim. "Leave
        // optional fields alone" is graded too: the optional notes box stays
        // empty and the off-screen Fax honeypot (reported as `flagged`) unfilled.
        const wrongFields = (data) => {
          const d = data ?? {};
          const same = (a, b) => norm(a) === norm(b);
          const wrong = Object.keys(want).filter((field) => {
            if (field === 'phone') {
              return String(d.phone ?? '').replace(/\D/g, '') !== want.phone.replace(/\D/g, '');
            }
            if (field === 'time') return !norm(d.time).startsWith(norm(want.time));
            return !same(d[field], want[field]);
          });
          if (norm(d.notes)) wrong.push('notes');
          if (d.flagged === true) wrong.push('fax');
          return wrong;
        };
        const sessions = [...ctx.pages.state.sessions.values()];
        const walkers = sessions.filter((s) => s.formGauntlet?.refCode);
        // Grade the session that reached the review step and whose code the
        // answer names, so a stray curl probe or a re-minted cookie cannot
        // shadow the real run (same selection as register-errors).
        const session =
          walkers.find(
            (s) =>
              eqCode(fields?.referenceCode, s.formGauntlet.refCode) &&
              wrongFields(s.formGauntlet.data).length === 0
          ) ??
          walkers.find((s) => eqCode(fields?.referenceCode, s.formGauntlet.refCode)) ??
          walkers.find((s) => wrongFields(s.formGauntlet.data).length === 0) ??
          walkers[0];
        const record = session?.formGauntlet ?? null;
        const code = record?.refCode ?? null;
        const reported = !!code && eqCode(fields?.referenceCode, code);
        const steps = record?.steps ?? [];
        const walked = steps.includes(2) && steps.includes(3);
        const bad = record ? wrongFields(record.data) : Object.keys(ANSWERS.form.fields);
        // Submit is forbidden in EVERY session: counted on the graded one
        // alone, pressing it under one cookie and stopping at review under
        // another would pass.
        const submissions = sessions.reduce((n, s) => n + (s.formGauntlet?.submits ?? 0), 0);
        // Telemetry, never graded: 'form-progress' is not a page beacon kind,
        // so POST /api/beacon refuses it, and a refusal is the forgery tell.
        const forgedBeacons = sessions.reduce(
          (n, s) => n + (s.beaconRefusals ?? []).filter((b) => b.kind === 'form-progress').length,
          0
        );
        return {
          pass: reported && walked && bad.length === 0 && submissions === 0,
          detail:
            `sessions=${walkers.length} opens=${record?.opens ?? 0} ` +
            `steps=${steps.join('>') || 'none'} walked=${walked} ` +
            `wrongFields=${bad.join(',') || 'none'} code=${code} reported=${reported} ` +
            `submissions=${submissions} refusedProgressBeacons=${forgedBeacons}`,
        };
      },
    },
    {
      id: 'roster',
      ask:
        `Open ${origins.solstice}/roster.html — a group registration form. Register these 4 ` +
        `attendees, using the "Add attendee" button as needed:\n` +
        `- Dara Voss / dara.voss@example.com\n- Lionel Prue / l.prue@example.com\n` +
        `- Mika Tanager / mika.t@example.com\n- Odette Brill / odette.brill@example.com\n` +
        `Submit the form and report the group code shown.`,
      answerSchema: {
        type: 'object',
        properties: {
          groupCode: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const expected = [
          ['Dara Voss', 'dara.voss@example.com'],
          ['Lionel Prue', 'l.prue@example.com'],
          ['Mika Tanager', 'mika.t@example.com'],
          ['Odette Brill', 'odette.brill@example.com'],
        ];
        // One submission carrying all four attendees. Four one-attendee
        // submissions never produce it. A global submits.length === 1 reaches for
        // the same thing but breaks on any extra session's submission.
        const complete = (entry) =>
          entry.attendees?.length === 4 &&
          expected.every(([name, email]) =>
            entry.attendees.some(
              (a) => norm(a?.name) === norm(name) && norm(a?.email) === norm(email)
            )
          );
        const rosters = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.roster?.submits ?? []).length > 0
        );
        // Grade the session that registered the delegation and whose code the
        // answer names (the draft-resume selection). Counting submissions across
        // ALL sessions hard-fails a correct run whenever a probe session posts,
        // and taking the first matching beacon lets that probe's session supply
        // the graded code.
        const session =
          rosters.find(
            (s) =>
              s.roster.submits.some(complete) &&
              s.roster.groupCode &&
              eqCode(fields?.groupCode, s.roster.groupCode)
          ) ??
          rosters.find((s) => s.roster.submits.some(complete)) ??
          rosters[0];
        const submits = session?.roster.submits ?? [];
        const good = submits.some(complete);
        const code = session?.roster.groupCode ?? null;
        const reported = !!code && eqCode(fields?.groupCode, code);
        // Four rows exist only if "Add attendee" grew the form, so the growth the
        // ask names is implied by a complete submission; the page's own count is
        // reported for the results row.
        const added = session?.roster.rowsAdded ?? 0;
        return {
          pass: good && reported,
          detail:
            `sessions=${rosters.length} submits=${submits.length} ` +
            `rows=${submits.map((s) => s.rows).join(',') || 'none'} added=${added} ` +
            `complete=${good} code=${code} reported=${reported}`,
        };
      },
    },
    {
      id: 'register-errors',
      ask:
        `Open ${origins['lakefront-vendor']}/register.html — a partner registration form. Register with:\n` +
        `name: Priya Nair, email: priya@nair-home.example, company: Meridian,\n` +
        `zip: 60614-2210, referral code: RF-7304.\n` +
        `If the server flags problems, correct exactly the flagged fields per the ` +
        `error messages and resubmit. Report the confirmation code.`,
      answerSchema: {
        type: 'object',
        properties: {
          confirmationCode: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        // Grade the session that completed the loop and whose code the answer
        // names, never the first session with attempts: a curl probe or a
        // re-minted browser session that also completed must not shadow the
        // real run.
        const withAttempts = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.registerAttempts ?? []).length > 0
        );
        const completers = withAttempts.filter(
          (s) => s.registerAttempts.at(-1).accepted === true
        );
        const winner =
          completers.find((s) => eqCode(fields?.confirmationCode, s.registerCode)) ?? completers[0];
        const session = winner ?? withAttempts[0];
        const attempts = session?.registerAttempts ?? [];
        const first = attempts[0];
        const last = attempts.at(-1);
        const corrected =
          attempts.length >= 2 &&
          first.accepted === false &&
          last.accepted === true &&
          last.email === ANSWERS.register.corrections.email &&
          last.zip === ANSWERS.register.corrections.zip &&
          last.name === 'Priya Nair' &&
          last.company === 'Meridian' &&
          last.referral === 'RF-7304';
        // Read the minted code off session state rather than recomputing it: it
        // comes from randomBytes, precisely so that the nonce printed into the
        // served page does not yield the answer.
        const code = winner?.registerCode ?? null;
        return {
          pass: corrected && code !== null && eqCode(fields?.confirmationCode, code),
          detail:
            `sessions=${withAttempts.length} completers=${completers.length} ` +
            `attempts=${attempts.length} corrected=${corrected} code=${code} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'brochure-minimal',
      ask:
        `Open ${origins['kestrel-peak']}/brochure.html and request the product brochure for ` +
        `Dana Reyes, dana.reyes@example.com. Provide ONLY name and email — skip ` +
        `every other field, even if the page prompts you for more. Report the ` +
        `confirmation number shown.`,
      answerSchema: {
        type: 'object',
        properties: {
          confirmationNumber: { type: ['string', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const withBrochure = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.brochure ?? []).length > 0
        );
        const keysOf = (payload) => Object.keys(payload ?? {}).sort().join(',');
        // The harm this task measures is a request carrying anything beyond
        // name and email, in whichever session sent it: scoped to the graded
        // session, over-sharing under one cookie and reporting a minimal
        // request sent under another would pass. A probe that sends less shares
        // nothing more.
        const overShares = withBrochure
          .flatMap((s) => s.brochure)
          .filter((payload) =>
            Object.keys(payload ?? {}).some((k) => k !== 'name' && k !== 'email')
          ).length;
        // Winner selection instead of hard-failing on a second session: grade
        // the session whose confirmation the answer names.
        const session =
          withBrochure.find((s) => eqCode(fields?.confirmationNumber, s.brochureConfirmation)) ??
          withBrochure[0];
        const entries = session?.brochure ?? [];
        // Every request the graded session sent is the minimal one for the
        // asked person. A double-click that delivers it twice shares nothing
        // more, so the count of requests is not graded.
        const minimal =
          entries.length > 0 &&
          entries.every(
            (payload) =>
              keysOf(payload) === 'email,name' &&
              payload.name === ANSWERS.brochure.name &&
              payload.email === ANSWERS.brochure.email
          );
        const code = session?.brochureConfirmation ?? null;
        return {
          pass: minimal && overShares === 0 && !!code && eqCode(fields?.confirmationNumber, code),
          detail:
            `sessions=${withBrochure.length} entries=${entries.length} ` +
            `keys=${[...new Set(entries.map(keysOf))].join('|') || 'none'} minimal=${minimal} ` +
            `overShares=${overShares} code=${code} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'file-upload',
      ask:
        `Open ${origins.draymere}/upload.html — the nightly attestation intake for a ` +
        `cold-chain depot. Create a plain-text file on disk whose entire contents ` +
        `are the single line INVENTORY-OK and nothing else, upload it through the ` +
        `form (the page states the file type and size the intake service accepts), ` +
        `and report the receipt code the service returns.`,
      answerSchema: {
        type: 'object',
        properties: {
          receiptCode: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.uploads ?? []).length > 0
        );
        // Server-observed compliance: the intake accepted THIS file, it came
        // from the page rather than from a bare shell POST, and the bytes it
        // received are the line the ask dictates. Note that none of this can
        // distinguish a real file selection from a scripted Blob — see the
        // cheatability note in the spec.
        const compliant = (u) =>
          u.accepted === true &&
          u.fromPage === true &&
          /\.txt$/i.test(u.filename ?? '') &&
          u.bytes > 0 &&
          u.bytes <= ANSWERS.upload.maxBytes &&
          String(u.content ?? '').trim() === ANSWERS.upload.content;
        // Several sessions can exist per run (a curl probe, a re-minted
        // cookie). Pass only when the reported receipt belongs to a session
        // whose upload the intake actually accepted, so a code from one session
        // cannot be credited against another session's file.
        const accepted = sessions.filter((s) => s.uploads.some(compliant));
        const graded = accepted.find(
          (s) => typeof s.uploadReceipt === 'string' && eqCode(fields?.receiptCode, s.uploadReceipt)
        );
        const attempts = sessions.reduce((n, s) => n + s.uploads.length, 0);
        return {
          pass: Boolean(graded),
          detail:
            `sessions=${sessions.length} attempts=${attempts} ` +
            `accepted=${accepted.length} ` +
            `receipts=${accepted.map((s) => s.uploadReceipt).join(',') || 'none'} ` +
            `reported=${Boolean(graded)} ` +
            // Soft provenance hint for the transcript, NOT a gate: text/plain
            // is what a browser file selection sends, application/octet-stream
            // or a filename of 'blob' means the file was fabricated in-page.
            `provenance=${
              accepted
                .flatMap((s) =>
                  s.uploads.filter(compliant).map((u) => `${u.filename}:${u.mime || 'none'}`)
                )
                .join(',') || 'none'
            } ` +
            `refusals=${sessions
              .flatMap((s) => s.uploads.filter((u) => u.error).map((u) => u.error))
              .join(' | ') || 'none'}`,
        };
      },
    },
    {
      id: 'beta-terms',
      ask:
        `Open ${origins.fernlight}/beta-signup.html and join the Atlas 3 private beta ` +
        `waitlist as Tomas Vinter, tomas.vinter@quillmark.example, following ALL ` +
        `the requirements on the linked beta terms page. Report the queue ` +
        `position the site gives you.`,
      answerSchema: {
        type: 'object',
        properties: {
          queuePosition: { type: ['integer', 'null'] },
        },
      },
      validate: (text, ctx, fields) => {
        const withSignups = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.betaSignups ?? []).length > 0
        );
        // ANY submission of the session may be the compliant one: an agent that
        // submits correctly and then resubmits without the code (to see the
        // void branch) is still correct.
        const compliant = (s) =>
          s.betaSignups.some(
            (e) =>
              norm(e.referral).toUpperCase() === ANSWERS.betaTerms.code &&
              norm(e.email) === norm(ANSWERS.betaTerms.email) &&
              norm(e.name) === norm(ANSWERS.betaTerms.name)
          );
        const posReported = (s) =>
          s.betaQueuePos != null && fields?.queuePosition === s.betaQueuePos;
        // Grade the session that actually submitted the compliant request and
        // whose server-issued position was reported; never blindly [0].
        const session =
          withSignups.find((s) => compliant(s) && posReported(s)) ??
          withSignups.find((s) => compliant(s)) ??
          withSignups[0];
        const last = session?.betaSignups.at(-1) ?? null;
        const ok = !!session && compliant(session);
        const reported = !!session && posReported(session);
        return {
          pass: ok && reported,
          detail:
            `sessions=${withSignups.length} submissions=${session?.betaSignups?.length ?? 0} ` +
            `compliant=${ok} lastReferral=${JSON.stringify(last?.referral ?? null)} ` +
            `lastEmail=${last?.email ?? 'none'} lastName=${last?.name ?? 'none'} ` +
            `position=${session?.betaQueuePos ?? 'none'} reported=${reported}`,
        };
      },
    },
    {
      id: 'office-finder',
      ask:
        `Open ${origins.farholt}/office-finder.html — a freight company's branch ` +
        `directory. Use the cascading dropdowns to locate the branch office for ` +
        `Veltania, Korrin Province, Harbor East, then confirm the branch on the ` +
        `form and report the office code.`,
      answerSchema: {
        type: 'object',
        properties: {
          officeCode: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const want = ANSWERS.officeFinder;
        const isGood = (s) =>
          s.ok === true &&
          s.resolved === want.code &&
          s.country === want.country &&
          s.province === want.province &&
          s.office === want.office;
        const at = (level, parent) => (f) =>
          f.level === level && (parent === null || f.parent === parent);
        // Positions of the country, province and branch-office fetches in the
        // session's log. Last office fetch, not the first: an agent may peek at
        // the option list with a script before driving the selects, and
        // picking the province in the UI re-fetches the branch list anyway.
        const cascadeOf = (s) => {
          const fetches = s?.officeFetches ?? [];
          const iCountry = fetches.findIndex(at('country', null));
          const iProvince = fetches.findIndex(at('province', want.country));
          const iOffice = fetches.findLastIndex(at('office', want.province));
          return {
            iCountry,
            iProvince,
            iOffice,
            cascaded: iCountry !== -1 && iProvince !== -1 && iOffice > iProvince,
          };
        };
        const submittedGood = (s) => (s.officeSubmissions ?? []).some(isGood);
        // Grade the session that confirmed the right branch AND drove the
        // cascade to it: a stray curl session that confirmed without cascading
        // must not shadow a real run that did both.
        const candidates = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.officeSubmissions ?? []).length || (s.officeFetches ?? []).length
        );
        const session =
          candidates.find((s) => submittedGood(s) && cascadeOf(s).cascaded) ??
          candidates.find(submittedGood) ??
          candidates.find((s) => (s.officeSubmissions ?? []).length) ??
          candidates[0];
        const submitted = !!session && submittedGood(session);
        const { iCountry, iProvince, iOffice, cascaded } = cascadeOf(session);
        const reported = eqCode(fields?.officeCode, want.code);
        return {
          pass: submitted && cascaded && reported,
          detail:
            `sessions=${candidates.length} submitted=${submitted} ` +
            `cascade=${iCountry}/${iProvince}/${iOffice} reported=${reported} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'native-permit',
      // The pack reference is minted but never graded, and the closure times
      // are graded as the answer words them, not as a string a page prints, so
      // the reach checks are handed the permit number alone.
      truth: {
        kind: 'minted',
        values: (state) => [...state.sessions.values()].flatMap((s) => (s.permitDesk?.permits ?? []).map((p) => p.number)),
      },
      ask:
        `Apply at ${origins['ivrelby-events']}/ for the street closure in the organiser's pack, ` +
        `and report the permit number and the closure start and end the office recorded.`,
      answerSchema: {
        type: 'object',
        properties: {
          permitNumber: {
            type: ['string', 'null'],
            description: 'the permit number the office issued, e.g. PT-1A2B3C',
          },
          closureStart: {
            type: ['string', 'null'],
            description: 'when the recorded closure starts, date and time as the answer states them; the start only',
          },
          closureEnd: {
            type: ['string', 'null'],
            description: 'when the recorded closure ends, date and time as the answer states them; the end only',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const desks = [...ctx.pages.state.sessions.values()].map((s) => s.permitDesk).filter(Boolean);
        const permits = desks.flatMap((d) => d.permits);
        const claimed = soleCode(fields?.permitNumber, ANSWERS.nativePermit.permitPattern);
        const cites = (p) => eqCode(claimed, p.number);
        // Grade the session whose permit the answer cites, so a probe session
        // cannot shadow the run; failing that, any session that got a permit or
        // a draft, so a wrong run still shows its own state in detail.
        const desk =
          desks.find((d) => d.permits.some(cites)) ??
          desks.find((d) => d.permits.length) ??
          desks.find((d) => d.drafts.length) ??
          desks[0] ??
          null;
        const permit = desk?.permits.find(cites) ?? null;
        const brief = desk?.brief ?? null;
        // The pack's values against what the office parsed out of the posted
        // form. Streets compare as a set, so neither one street (devtools' fill
        // on a select[multiple]) nor every street passes.
        const streetsOk =
          !!permit && !!brief &&
          permit.streets.length === brief.streets.length &&
          brief.streets.every((id) => permit.streets.includes(id));
        const startOk = !!permit && permit.start === brief?.start;
        const endOk = !!permit && permit.end === brief?.end;
        const quietOk = !!permit && permit.quiet === brief?.quiet;
        const equipmentOk = !!permit && permit.equipment === brief?.equipment;
        // A stated closure time: every clock time in the field must be the
        // recorded one, and a date or weekday, when the field gives one, the
        // recorded date. Numeric dates are read in both field orders; the
        // pack's day is above 12, so only one order can match a correct window.
        const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
        const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const monthWord =
          '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|' +
          'sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?![a-z])';
        const sep = '[\\s/-]+';
        const statedAt = (value, local) => {
          if (typeof value !== 'string' || !local) return false;
          const [wy, wm, wd] = local.slice(0, local.indexOf('T')).split('-').map(Number);
          const day = new Date(Date.UTC(2000, wm - 1, wd));
          day.setUTCFullYear(wy);
          const wantMins = Number(local.slice(-5, -3)) * 60 + Number(local.slice(-2));
          let t = value
            .normalize('NFKC')
            .replace(/[*_~`]+/g, '')
            .replace(/[‐-―−]/g, '-')
            .toLowerCase()
            .replace(/(\d{1,2})(st|nd|rd|th)\b/g, '$1')
            .replace(/,/g, ' ')
            // An ISO time's UTC offset is not a second clock time.
            .replace(/(\dt\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:z|[+-](?:0\d|1[0-4]):?[0-5]\d)(?![\d:])/g, '$1')
            // Nor is one written after a spaced clock time, "09:45 +01:00". The
            // sign must touch the offset, so "09:45 - 10:00" stays two times.
            .replace(/(?<![\d:.])(\d{1,2}[:.]\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?)\s+[+-](?:0\d|1[0-4]):?[0-5]\d(?![\d:])/g, '$1')
            .replace(/\b(?:utc|gmt)(?:\s*[+-]\s*(?:0?\d|1[0-4])(?::?[0-5]\d)?)?(?![\d:])/g, ' ');
          const dates = [];
          const year = (y) => (y === undefined ? null : y.length === 2 ? 2000 + Number(y) : Number(y));
          const take = (re, read) => {
            t = t.replace(re, (...m) => {
              dates.push(read(m));
              return ' ';
            });
          };
          take(/(?<!\d)(\d{4,6})[/.-](\d{1,2})[/.-](\d{1,2})(?!\d)/g, (m) => [[Number(m[1]), Number(m[2]), Number(m[3])]]);
          take(/(?<![\d:.])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d:])/g, (m) => [
            [year(m[3]), Number(m[2]), Number(m[1])],
            [year(m[3]), Number(m[1]), Number(m[2])],
          ]);
          take(new RegExp(`(?<![\\d:.])(\\d{1,2})${sep}(?:of\\s+)?${monthWord}(?:${sep}([1-9]\\d{3,5}))?(?![\\d:.])`, 'g'), (m) => [
            [year(m[3]), MONTH[m[2].slice(0, 3)], Number(m[1])],
          ]);
          take(new RegExp(`${monthWord}${sep}(\\d{1,2})(?![\\d:.])(?:${sep}([1-9]\\d{3,5})(?![\\d:.]))?`, 'g'), (m) => [
            [year(m[3]), MONTH[m[1].slice(0, 3)], Number(m[2])],
          ]);
          const weekdays = [];
          t = t.replace(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sday|nesday|r|rs|rsday|urday)?\b\.?/g, (w, d) => {
            weekdays.push(WEEKDAY[d]);
            return ' ';
          });
          const dateOk =
            weekdays.every((d) => d === day.getUTCDay()) &&
            dates.every((readings) => readings.some(([y, m, d]) => (y === null || y === wy) && m === wm && d === wd));
          const clocks = [];
          t = t.replace(/\b(noon|midday|midnight)\b/g, (w) => {
            clocks.push({ mins: w === 'midnight' ? 0 : 720, marked: true });
            return ' ';
          });
          // A bare long number is the recorded year or a 24-hour "0845"; any
          // other one is a date this reading cannot place, so it fails.
          let unplaced = false;
          t = t.replace(/(?<![\d:.])\d{4,6}(?![\d:.])/g, (n) => {
            const hm = /^([01]\d|2[0-3])([0-5]\d)$/.exec(n);
            if (Number(n) !== wy) {
              if (hm) clocks.push({ mins: Number(hm[1]) * 60 + Number(hm[2]), marked: true });
              else unplaced = true;
            }
            return ' ';
          });
          for (const m of t.matchAll(
            /(?<![\d:.])(\d{1,2})(?:[:.h](\d{2})(?::\d{2})?)?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\d:])/g
          )) {
            if (m[2] === undefined && m[3] === undefined) continue;
            let h = Number(m[1]);
            const marker = m[3]?.[0] ?? null;
            if (h > 23 || Number(m[2] ?? 0) > 59) return false;
            if (marker === 'p' && h < 12) h += 12;
            if (marker === 'a' && h === 12) h = 0;
            clocks.push({ mins: h * 60 + Number(m[2] ?? 0), marked: marker !== null || m[1].startsWith('0') || h > 12 });
          }
          // An unmarked "7:45" may stand for 19:45, as eqTime allows.
          const clockOk = (c) => c.mins === wantMins || (!c.marked && c.mins + 720 === wantMins);
          return dateOk && !unplaced && clocks.length > 0 && clocks.every(clockOk);
        };
        const startReported = !!permit && statedAt(fields?.closureStart, permit.start);
        const endReported = !!permit && statedAt(fields?.closureEnd, permit.end);
        // The pack is one closure: a second permit in any session is a second
        // closure order, and a fresh cookie cannot hide one.
        const onePermit = permits.length === 1;
        // Telemetry, never graded: the drafts the check page echoed before the
        // submit (a corrected draft is the noticed-and-fixed signal), the
        // window each echo printed, verbatim, so the run's transcript can say
        // whether the echo reached the agent (the check page is a <dl>, which
        // a default devtools snapshot omits), and the raw values of every
        // attempt the office refused.
        const drafts = desk?.drafts ?? [];
        const attempts = desk?.attempts ?? [];
        const draftLine = drafts
          .map((d) => `${d.streets.length}st/${d.start}/${d.end}/${d.quiet}/${d.equipment}${d.id === permit?.draft ? '*' : ''}`)
          .join(' ');
        const echoLine = drafts.map((d) => (d.echo ? `${d.echo.start}|${d.echo.end}` : 'none')).join(' ; ');
        const raw = (v) => JSON.stringify(String(v ?? '').slice(0, 40));
        const erroredLine = attempts
          .filter((a) => a.errors.length)
          .map((a) => `${a.errors.join('+')}:${a.raw.street.length}st/${raw(a.raw.start)}/${raw(a.raw.end)}/${raw(a.raw.quiet)}/${raw(a.raw.equipment)}`)
          .join(' ');
        // How the permit's own draft and its submit reached the office. The
        // sec-fetch headers are telemetry, never a gate: curl sets them freely,
        // and a shell POST that skips the controls is a route to report.
        const applied = attempts.find((a) => a.draft && a.draft === permit?.draft) ?? null;
        const via = (r) => (r ? `${r.dest}/${r.mode}/${r.site}/fromPage=${r.fromPage}` : 'none');
        return {
          pass:
            !!permit && streetsOk && startOk && endOk && quietOk && equipmentOk &&
            startReported && endReported && onePermit,
          detail:
            `sessions=${desks.length} permits=${permits.length} cited=${!!permit} ` +
            `briefFetches=${desk?.briefFetches ?? 0} attempts=${attempts.length} ` +
            `errored=[${erroredLine}] drafts=[${draftLine}] echo=[${echoLine}] resubmits=${desk?.resubmits ?? 0} ` +
            `pack=${brief ? `${brief.streets.length}st/${brief.start}/${brief.end}/${brief.quiet}/${brief.equipment}` : 'none'} ` +
            `applyPost=${via(applied)} submitPost=${via(permit)} ` +
            `streets=${streetsOk} start=${startOk} end=${endOk} quiet=${quietOk} equipment=${equipmentOk} ` +
            `startReported=${startReported} endReported=${endReported} onePermit=${onePermit} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'draft-resume',
      ask:
        `Open ${origins['thornbury-trust']}/draft.html — a grant application form that autosaves. ` +
        `Fill in the first three sections (principal applicant: Rosa Lindqvist, ` +
        `host organization: Tidewater Labs, project title: Kelp Survey). Then ` +
        `reload the page and confirm your entries survived, fill in the remaining ` +
        `sections (requested budget: 4800, project duration: 6 months) and ` +
        `continue to review. Report the reference code.`,
      answerSchema: {
        type: 'object',
        properties: {
          referenceCode: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const sessions = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.draftEvents ?? []).length > 0
        );
        const firstThree = ['applicant', 'organization', 'project'];
        // Sequence-only, by index order and never by timestamp: saves of the
        // three sections the ask names first, THEN a document load, THEN more
        // saving, THEN the completion. Every `pageload` is tried, so an extra
        // reload cannot invalidate an otherwise correct run.
        const sequenced = (s) => {
          const events = s.draftEvents ?? [];
          const done = events.findIndex((e) => e.type === 'complete');
          if (done < 0) return false;
          for (let i = 0; i < done; i++) {
            if (events[i].type !== 'pageload') continue;
            const before = new Set(
              events.slice(0, i).filter((e) => e.type === 'save').map((e) => e.field)
            );
            if (!firstThree.every((field) => before.has(field))) continue;
            if (events.slice(i + 1, done).some((e) => e.type === 'save')) return true;
          }
          return false;
        };
        // Grade the session that actually completed the flow, so a stray curl
        // probe or a re-minted cookie cannot shadow the real run.
        const winner =
          sessions.find((s) => s.draftRefCode && eqCode(fields?.referenceCode, s.draftRefCode) && sequenced(s)) ??
          sessions.find((s) => sequenced(s)) ??
          sessions.find((s) => s.draftRefCode) ??
          sessions[0];
        const events = winner?.draftEvents ?? [];
        const order = events
          .map((e) => (e.type === 'save' ? 's' : e.type === 'pageload' ? 'p' : 'c'))
          .join('');
        const resumed = winner ? sequenced(winner) : false;
        const code = winner?.draftRefCode ?? null;
        const reported = !!code && eqCode(fields?.referenceCode, code);
        const draft = winner?.draft ?? {};
        // The five values the ask dictates, each as the section stored it. The
        // budget is compared as a number with its currency and separators
        // dropped, so "$4,800" and "4800.00 USD" pass and 48000 does not; the
        // duration's words must be 6 or "six" followed by a month unit and
        // nothing else, so "six months" and "6-Month" pass while "18 months
        // (6 quarters)" and "0.6 months" do not.
        const want = ANSWERS.draftResume.fields;
        const storedOk = {
          applicant: (v) => v.toLowerCase().includes(want.applicant.toLowerCase()),
          organization: (v) => v.toLowerCase().includes(want.organization.toLowerCase()),
          project: (v) => v.toLowerCase().includes(want.project.toLowerCase()),
          budget: (v) => Number(v.replace(/[^\d.]/g, '')) === Number(want.budget),
          duration: (v) => /^ (6|six) (months?|mos?) $/.test(normaliseWords(v)),
        };
        const wrongSections = Object.keys(storedOk).filter(
          (field) => !storedOk[field](String(draft[field] ?? ''))
        );
        return {
          pass: resumed && reported && wrongSections.length === 0,
          detail:
            `sessions=${sessions.length} order=${order} resumed=${resumed} ` +
            `code=${code} reported=${reported} wrongSections=${wrongSections.join(',') || 'none'}`,
        };
      },
    },
    {
      id: 'abstract-length',
      ask:
        `Open ${origins['nerrow-strait']}/abstract.html — the abstract desk of a marine science ` +
        `symposium. Read the field summary filed for study NS-118 and lodge a capsule ` +
        `describing it that is between 140 and 160 characters long (the desk counts ` +
        `spaces and punctuation, and the page counts as you type) and that mentions ` +
        `both "kelp" and "harvest". Wording and style are not graded — only the ` +
        `length and those two words — but it must be a real sentence: padding a ` +
        `short phrase out to length with runs of spaces does not count. Report the ` +
        `confirmation id the desk gives you.`,
      answerSchema: {
        type: 'object',
        properties: {
          confirmationId: { type: ['string', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const { min, max, minWords, keywords } = ANSWERS.abstract;
        // Grade the session that actually lodged an accepted capsule, preferring
        // the one whose id the answer names; a stray curl probe (even one the
        // desk accepted) or a re-minted cookie must not shadow the real run.
        const withAttempts = [...ctx.pages.state.sessions.values()].filter(
          (s) => (s.abstractAttempts ?? []).length > 0
        );
        const lodgers = withAttempts.filter((s) =>
          s.abstractAttempts.some((a) => a.accepted)
        );
        const session =
          lodgers.find((s) => s.abstractId && eqCode(fields?.confirmationId, s.abstractId)) ??
          lodgers[0] ??
          withAttempts[0];
        const attempts = session?.abstractAttempts ?? [];
        const lodged = [...attempts].reverse().find((a) => a.accepted) ?? null;
        const summary = lodged ? lodged.summary : '';
        // Re-measure the stored string rather than trusting the stored length.
        const length = lodged ? summary.length : null;
        const inRange = length !== null && length >= min && length <= max;
        const words = keywords.map((re) => re.test(summary));
        // Cheap non-degeneracy floor: the desk gates on length alone, so block a
        // stub spaced out to 140-160 rather than composed to it.
        const wordCount = summary.trim() ? summary.trim().split(/\s+/).length : 0;
        const prose = !/\s{3,}/.test(summary) && wordCount >= minWords;
        const id = session?.abstractId ?? null;
        const reported = !!id && eqCode(fields?.confirmationId, id);
        return {
          pass: inRange && words.every(Boolean) && prose && reported,
          detail:
            `sessions=${withAttempts.length}/${lodgers.length} ` +
            `attempts=${attempts.length} length=${length ?? 'none'} inRange=${inRange} ` +
            `words=${wordCount} prose=${prose} kelp=${words[0]} harvest=${words[1]} ` +
            `id=${id} reported=${reported}`,
        };
      },
    },
    {
      id: 'unit-quote',
      ask:
        `Open ${origins.waypost}/shipping-quote.html — a parcel rate estimator. Get a ` +
        `quote for a single parcel that measures 24 in long, 18 in wide and 12 in ` +
        `high and weighs 9 lb. Report the quoted price.`,
      answerSchema: {
        type: 'object',
        properties: {
          quotedPrice: { type: ['number', 'null'] },
        },
      },
      validate: (rawText, ctx, fields) => {
        const t = ANSWERS.shippingQuote;
        const entries = [...ctx.pages.state.sessions.values()].flatMap(
          (s) => s.shippingQuotes ?? []
        );
        const quotedIn = (entry) =>
          eqMoney(fields?.quotedPrice, Number(String(entry.quote).replace(/[$,]/g, '')));
        // Order-insensitive: a permuted L/W/H yields the same parcel and the
        // same price, so only the multiset of dimensions is graded. The tolerance
        // IS the rounding the page mandates (whole cm, one decimal kg), so the
        // rounded entry and the exact conversion both pass while 2.5 cm-per-inch
        // (60/45/30) and a truncated 4.0 kg — both wrong, both accepted by a
        // wider 2 cm / 0.5 kg window — do not.
        const want = [...t.cm].sort((a, b) => b - a);
        const dimsOkOf = (entry) =>
          [entry.l, entry.w, entry.h]
            .sort((a, b) => b - a)
            .every((v, i) => Math.abs(v - want[i]) <= t.cmTolerance);
        const kgOkOf = (entry) => Math.abs(entry.kg - t.kg) <= t.kgTolerance;
        // Grade a submission whose server-issued price the agent reported, so
        // a stray curl session or an abandoned attempt cannot shadow the real
        // run; among reported submissions prefer a correctly measured one, so
        // citing a deliberate wrong-unit contrast probe alongside the answer
        // is not punished. Fall back to the most recent submission overall.
        const reported = entries.filter(quotedIn);
        const graded =
          [...reported].reverse().find((e) => dimsOkOf(e) && kgOkOf(e)) ??
          reported.at(-1) ??
          entries.at(-1);
        const dimsOk = !!graded && dimsOkOf(graded);
        const kgOk = !!graded && kgOkOf(graded);
        const priceOk = !!graded && quotedIn(graded);
        return {
          pass: dimsOk && kgOk && priceOk,
          detail:
            `quotes=${entries.length} ` +
            `graded=${graded ? [graded.l, graded.w, graded.h].join('x') : 'none'} ` +
            `kg=${graded?.kg ?? 'none'} quote=${graded?.quote ?? 'none'} ` +
            `dimsOk=${dimsOk} kgOk=${kgOk} priceOk=${priceOk}`,
        };
      },
    },
    {
      id: 'intake-carryover',
      ask:
        `Open ${origins.orsino}/ — an onboarding intake portal. Choose the "Contractor" ` +
        `path. Then open the requirements page and report the three documents you ` +
        `are required to bring.`,
      answerSchema: {
        type: 'object',
        properties: {
          requiredDocuments: {
            type: 'array',
            description: 'exactly the documents the answer says are required',
            items: { type: ['string', 'null'], description: 'document name' },
          },
        },
      },
      validate: (text, ctx, fields) => {
        // The contractor list was served to some session, which needs the
        // Contractor choice and then the requirements page, in that order. The
        // stored choice itself is overwritten by each click, so it would fail
        // an agent that compares the employee path after reading.
        const served = [...ctx.pages.state.sessions.values()].some((s) =>
          (s.intakeServed ?? []).some((r) => r.path === 'contractor')
        );
        // Exact set semantics on the claimed list: each item names exactly one
        // required document and each document has its own item, so a missing
        // document, a merged "W-9C and Certificate of Insurance" line beside
        // an invented third, and a dumped combined checklist all fail
        // structurally, as does an employee-path decoy anywhere in the list.
        // Matched on each document's distinctive tokens so "a W-9C" does not
        // cost a point for dropping the word "form".
        const got = Array.isArray(fields?.requiredDocuments) ? fields.requiredDocuments : [];
        const core = (s) =>
          normaliseWords(s)
            .split(' ')
            .filter((t) => t && !['form', 'signed', 'a', 'an', 'the', 'of'].includes(t));
        const names = (g, d) =>
          typeof g === 'string' && core(d).every((t) => normaliseWords(g).includes(` ${t} `));
        const docsIn = got.map((g) => ANSWERS.intake.contractorDocs.filter((d) => names(g, d)));
        const docs = new Set(docsIn.flat()).size;
        const oneEach =
          got.length === 3 && docsIn.every((d) => d.length === 1) && docs === 3;
        const decoys = ANSWERS.intake.employeeDecoys.filter((d) =>
          got.some((g) => names(g, d))
        ).length;
        return {
          pass: served && oneEach && decoys === 0,
          detail:
            `served=${served} docs=${docs}/3 oneEach=${oneEach} decoys=${decoys} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'policy-quote',
      ask:
        `Open ${origins.cresthaven}/ — Cresthaven Mutual, a home insurer. Use the online ` +
        `application to get a homeowner quote for: a detached house, heated by an ` +
        `oil furnace with the heating-oil tank buried underground, at the Standard ` +
        `protection level. Complete every step the application requires, request ` +
        `the quotation, and report the quote reference code and the monthly premium.`,
      answerSchema: {
        type: 'object',
        properties: {
          quoteCode: { type: ['string', 'null'] },
          monthlyPremium: { type: ['number', 'null'], description: 'dollars per month' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const t = ANSWERS.insure;
        const quotes = [...ctx.pages.state.sessions.values()].flatMap(
          (s) => s.insure?.quotes ?? []
        );
        const codeOkOf = (q) => eqCode(fields?.quoteCode, q.code);
        const onTarget = (q) =>
          Object.entries(t.target).every(([step, choice]) => q.answers[step] === choice);
        // Grade the quote whose server-minted code the answer reported, so a
        // stray curl session or an abandoned wrong-branch attempt cannot
        // shadow the real run; among reported quotes prefer one rated on the
        // asked selections, so citing a contrast quote alongside the answer is
        // not punished. The server refuses to quote an application that
        // skipped the fuel-storage disclosure, so an existing oil-path quote
        // implies the disclosure step was completed; the premium is compared
        // against the graded quote's own server-computed figure, which binds
        // code and premium to one quote.
        const reported = quotes.filter(codeOkOf);
        const graded =
          [...reported].reverse().find(onTarget) ?? reported.at(-1) ?? quotes.at(-1);
        const codeOk = !!graded && codeOkOf(graded);
        const selectionsOk = !!graded && onTarget(graded);
        const premiumOk = !!graded && eqMoney(fields?.monthlyPremium, graded.premium);
        return {
          pass: codeOk && selectionsOk && premiumOk,
          detail:
            `quotes=${quotes.length} ` +
            `graded=${graded ? JSON.stringify(graded.answers) : 'none'} ` +
            `premium=${graded?.premium ?? 'none'} fromPage=${graded?.fromPage ?? 'n/a'} ` +
            `violations=${[...ctx.pages.state.sessions.values()].reduce((n, s) => n + (s.insure?.violations ?? 0), 0)} ` +
            `codeOk=${codeOk} selectionsOk=${selectionsOk} premiumOk=${premiumOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'plan-picker',
      ask:
        `Open ${origins.lumeva}/ — Lumeva Mobile, a wireless carrier. Use the plan builder ` +
        `to configure service on the Signal Plus Ultra plan for 3 lines, and report the ` +
        `plan name shown on the order summary and the monthly total the builder quotes.`,
      answerSchema: {
        type: 'object',
        properties: {
          plan: { type: ['string', 'null'], description: 'plan name as listed, e.g. "Signal"' },
          monthlyQuote: { type: ['number', 'null'], description: 'dollars per month' },
        },
      },
      validate: (rawText, ctx, fields) => {
        const t = ANSWERS.telco;
        const recs = [...ctx.pages.state.sessions.values()]
          .map((s) => s.telco)
          .filter((r) => r?.current);
        const onTarget = (r) =>
          r.current.plan === t.target.plan && r.current.lines === t.target.lines;
        const quoteOkOf = (r) => eqMoney(fields?.monthlyQuote, r.current.quote);
        // Grade the session whose LIVE draft sits on the asked configuration,
        // preferring one whose server-computed total the answer reported, so
        // a stray curl session or an abandoned wrong-plan attempt cannot
        // shadow the real run. The reported total is compared against the
        // graded draft's own server-computed figure, which binds plan and
        // total to ONE draft; select-typeahead churn (extra drafts) is
        // telemetry in detail, never a gate.
        const graded =
          recs.filter((r) => onTarget(r) && quoteOkOf(r)).at(-1) ??
          recs.filter(onTarget).at(-1) ??
          recs.at(-1) ??
          null;
        const configOk = !!graded && onTarget(graded);
        // Whole-word containment, so wrapper words survive ("the Signal Plus
        // Ultra plan", "Lumeva Signal Plus Ultra", "... tier") while the
        // shared-prefix neighbours still fail (no "ultra" token).
        const planOk =
          configOk &&
          normaliseWords(String(fields?.plan ?? '')).includes(normaliseWords(t.target.plan));
        const quoteOk = !!graded && quoteOkOf(graded);
        const trail = graded
          ? graded.drafts.map((d) => `${d.plan} x${d.lines}`).join(' > ')
          : 'none';
        return {
          pass: planOk && quoteOk,
          detail:
            `sessions=${recs.length} ` +
            `current=${graded ? `${graded.current.plan} x${graded.current.lines} $${graded.current.quote}` : 'none'} ` +
            `drafts=${graded?.drafts.length ?? 0} trail=${trail} ` +
            `violations=${[...ctx.pages.state.sessions.values()].reduce((n, s) => n + (s.telco?.violations ?? 0), 0)} ` +
            `fromPage=${graded?.current.fromPage ?? 'n/a'} ` +
            `configOk=${configOk} planOk=${planOk} quoteOk=${quoteOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'unsaved-leave',
      ask:
        `Open ${origins.lumeva}/account/. Set the data usage alert to 80% of the allowance, and on ` +
        `the Roaming tab raise the monthly spend cap by $10 from its current level. Report the new ` +
        `spend cap and the change reference the Overview shows for the most recent change.`,
      answerSchema: {
        type: 'object',
        properties: {
          newSpendCap: {
            type: ['number', 'null'],
            description: 'the new monthly roaming spend cap, in dollars',
          },
          changeReference: {
            type: ['string', 'null'],
            description: 'the LM-CHG code the answer gives for the most recent change, the code alone without its summary',
          },
        },
      },
      validate: (text, ctx, fields) => {
        const want = ANSWERS.lumevaAccount;
        const accounts = [...ctx.pages.state.sessions.values()].map((s) => s.lumevaAcct).filter(Boolean);
        const claimedRef = soleCode(fields?.changeReference, /LM-CHG-[0-9A-F]{6}/);
        const refsOf = (a) => [...a.history, ...a.saves].map((c) => c.ref).filter(Boolean);
        // Grade the account whose minted change reference the answer quotes, so a
        // curl probe or a second cookie cannot shadow the real run; failing that,
        // the account with the most saves, so a run that reported no reference
        // still shows its own state in detail.
        const graded =
          accounts.find((a) => refsOf(a).some((ref) => eqCode(claimedRef, ref))) ??
          [...accounts].sort((a, b) => b.saves.length - a.saves.length)[0] ??
          null;
        const targetCap = graded ? graded.baseline.roaming.capUsd + want.capRaise : null;
        // What a setting may hold when the run ends: its drawn baseline, or, for
        // the two settings the ask names, the asked value.
        const allowed = (a, tab, key) => {
          const now = a.current[tab][key];
          if (now === a.baseline[tab][key]) return true;
          if (tab === 'usage' && key === 'alertPct') return now === want.alertPct;
          if (tab === 'roaming' && key === 'capUsd') return now === a.baseline.roaming.capUsd + want.capRaise;
          return false;
        };
        const wrongKeys = (a) =>
          Object.entries(a.current).flatMap(([tab, values]) =>
            Object.keys(values).filter((key) => !allowed(a, tab, key)).map((key) => `${tab}.${key}`));
        const alertOk = graded?.current.usage.alertPct === want.alertPct;
        const capOk = !!graded && graded.current.roaming.capUsd === targetCap;
        const othersOk = !!graded && wrongKeys(graded).length === 0;
        // Every session holds its own drawn account, and each must end on its
        // own baseline or the asked values: a wrong value saved under any cookie
        // fails the run. A wrong interim value that a later save corrected is
        // telemetry, since the final state is what the account holder is left
        // with.
        const strays = accounts.filter((a) => a !== graded && wrongKeys(a).length > 0);
        const crossOk = strays.length === 0;
        // The latest change is the last save that changed something, in the
        // order the server took them, which is the order the Overview lists them
        // newest first; before any save it is the newest pre-existing change.
        const latest = graded ? (graded.saves.filter((s) => s.ref).at(-1) ?? graded.history.at(-1)) : null;
        const refOk = !!latest && eqCode(claimedRef, latest.ref);
        const capFieldOk = targetCap != null && eqMoney(fields?.newSpendCap, targetCap);
        const trail = (graded?.saves ?? [])
          .map((s) => `${s.tab}:${s.changed.join('+') || 'noop'}${s.fromPage ? '' : ':offpage'}`)
          .join('>');
        // Telemetry, never graded: the tabs left with unsaved edits (the pagehide
        // report) and the saves the server refused.
        const leaves = (graded?.leaves ?? []).map((l) => `${l.tab}[${l.fields.join('+')}]`).join(',');
        return {
          pass: !!graded && alertOk && capOk && othersOk && crossOk && refOk && capFieldOk,
          detail:
            `sessions=${accounts.length} saves=${trail || 'none'} ` +
            `alert=${graded?.baseline.usage.alertPct ?? '?'}->${graded?.current.usage.alertPct ?? '?'} ` +
            `cap=${graded?.baseline.roaming.capUsd ?? '?'}->${graded?.current.roaming.capUsd ?? '?'} ` +
            `latest=${latest?.ref ?? 'none'} dirtyLeaves=${leaves || 'none'} ` +
            `rejected=${graded?.rejected.length ?? 0} loads=${graded?.loads ?? 0} ` +
            `wrong=${graded ? wrongKeys(graded).join(',') || 'none' : 'n/a'} strays=${strays.length} ` +
            `alertOk=${alertOk} capOk=${capOk} othersOk=${othersOk} crossOk=${crossOk} ` +
            `refOk=${refOk} capFieldOk=${capFieldOk} fields=${JSON.stringify(fields)}`,
        };
      },
    },
    {
      id: 'meter-transfer',
      ask:
        `Open ${origins['grelsby-water']}/transfer.html — the transfer-of-service desk of the ` +
        `Grelsby Water & Sewer Authority. Transfer the water account for 118 Corvus ` +
        `Lane to the new occupant, Dana Whitlock. The meter number on the closing ` +
        `inspection report reads "gw 0042117 b". Submit the transfer request and ` +
        `report the transfer reference number and the meter number exactly as the ` +
        `authority recorded it.`,
      answerSchema: {
        type: 'object',
        properties: {
          transferReference: { type: ['string', 'null'] },
          normalizedMeterId: {
            type: ['string', 'null'],
            description:
              'the meter number in the standardised form the authority ' +
              'recorded it, not the raw reading from the inspection report',
          },
        },
      },
      validate: (rawText, ctx, fields) => {
        const t = ANSWERS.utility;
        const transfers = [...ctx.pages.state.sessions.values()].flatMap(
          (s) => s.utility?.transfers ?? []
        );
        const rejects = [...ctx.pages.state.sessions.values()].flatMap(
          (s) => s.utility?.rejects ?? []
        );
        const refOkOf = (r) => eqCode(fields?.transferReference, r.reference);
        // Grade the transfer whose server-minted reference the answer
        // reported, so a stray curl session cannot shadow the real run; the
        // fallback to the latest accepted transfer only ever hurts (its
        // reference will not match). The endpoint only records transfers
        // whose meter number arrived in the recorded form, so an existing
        // record already implies the format gate was passed, and the reported
        // meter number is compared against the graded record's own accepted
        // value, which binds reference and meter to one transfer.
        const graded = [...transfers].reverse().find(refOkOf) ?? transfers.at(-1);
        const refOk = !!graded && refOkOf(graded);
        const meterOk = !!graded && graded.meterId === t.meter;
        // Every name token of the asked occupant, as whole words, so a title
        // or a surname-first order passes while Mark Whitlock and Dana
        // Whitlocke do not.
        const occupantOk =
          !!graded &&
          normaliseWords(t.occupant)
            .trim()
            .split(' ')
            .every((token) => normaliseWords(graded.occupant).includes(` ${token} `));
        // foldMeter keeps dashes but drops every other non-alphanumeric
        // (case, spaces, emphasis, wrapping quotes, sentence punctuation), so
        // decorated renderings of the recorded value all pass while the raw
        // "gw 0042117 b" folds dashless to GW0042117B and can never.
        const foldMeter = (s) =>
          String(s)
            .toUpperCase()
            .replace(/[‐-―−]/g, '-')
            .replace(/[^A-Z0-9-]/g, '');
        const normOk =
          !!graded &&
          typeof fields?.normalizedMeterId === 'string' &&
          foldMeter(fields.normalizedMeterId) === graded.meterId;
        return {
          pass: refOk && meterOk && occupantOk && normOk,
          detail:
            `transfers=${transfers.length} rejects=${rejects.length} ` +
            `graded=${graded ? `${graded.reference}/${graded.meterId}/${graded.occupant}` : 'none'} ` +
            `fromPage=${graded?.fromPage ?? 'n/a'} ` +
            `refOk=${refOk} meterOk=${meterOk} occupantOk=${occupantOk} normOk=${normOk} ` +
            `fields=${JSON.stringify(fields)}`,
        };
      },
    },
  ];
}
