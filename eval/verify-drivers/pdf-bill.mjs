// pages/utility/account/ - Grelsby Water's My Account (pdf-bill). The golden
// path opens the bills newest first in Firefox's PDF viewer and reads each one
// through take_snapshot. Two measured limits shape the reads
// (eval/spikes/pdf-bill.mjs): each history link carries its bill date in a
// visually hidden span, which the snapshot drops from the link's name while it
// still lists the span as a node of its own, so the six links share one name
// and are told apart by position; and the default 100-line window stops on
// page 1 of a bill, so the viewer is read with a raised maxLines. Every table
// cell of the bill is its own short text run, so the bill number and the
// reading code arrive whole.
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { ANSWERS } from '../answers.mjs';
import { addSession, bumpCode, clickToPath, findSession, snapText, straySession, uidOf, until } from './lib.mjs';

const ACCOUNT = '/utility/account/';
const METER_HEADERS = ['Meter', 'Size', 'Previous read', 'Reading', 'Present read', 'Reading', 'Code', 'Usage (ccf)'];

// One bill's facts from its text runs in drawing order: the number beside its
// label on page 1, the meter row under the METER READINGS headers on page 2,
// and the code of the same period a year earlier.
function billFrom(runs) {
  const head = runs.indexOf('METER READINGS');
  if (head < 0 || METER_HEADERS.some((h, n) => runs[head + 1 + n] !== h)) return null;
  const [meter, , from, prev, to, pres, code] = runs.slice(head + 9, head + 17);
  const prior = runs.indexOf('Same period last year');
  return {
    number: runs[runs.indexOf('Bill number') + 1],
    issued: runs[runs.indexOf('Bill date') + 1],
    meter,
    from,
    to,
    prev,
    pres,
    code,
    priorCode: prior < 0 ? null : runs[prior + 5],
  };
}

const snapshotRuns = (snap) => [...snap.matchAll(/text="([^"]*)"/g)].map((m) => m[1]);

// The same facts decoded from the file, the way a shell reads it: inflate
// each content stream and take the literal of every Tj.
function fileRuns(buf) {
  const s = buf.toString('latin1');
  const runs = [];
  for (const m of s.matchAll(/\/FlateDecode >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    const ops = inflateSync(buf.subarray(start, s.indexOf('\nendstream', start))).toString('latin1');
    for (const t of ops.matchAll(/\((.*?)\) Tj/g)) runs.push(t[1].replace(/\\([()\\])/g, '$1'));
  }
  return runs;
}

const hex6 = () => randomBytes(3).toString('hex').toUpperCase();

export const DRIVERS = {
  'pdf-bill': {
    note:
      'opens bills newest first in the PDF viewer by link position, reads each via ' +
      'take_snapshot maxLines 500, submits against the E bill',
    async run({ base, goto, evaluate, mcp, snapshot }, ctx) {
      const want = ANSWERS.utilityBill;
      // A probe session outside the browser, as an agent's shell makes one: it
      // decodes its own six bills and tries its own estimated bill with a date
      // that is not the estimate's, which must be refused and must not fail
      // the run. It also proves the PDF route needs the session cookie.
      const stray = await straySession(base, ACCOUNT);
      const strayList = await stray.get('/api/utility/account');
      if (strayList.bills?.length !== 6) throw new Error('the account API did not list six bills');
      // The latest bill is still open on the day of the run, and the oldest
      // was issued inside the twelve months the history's caption names.
      const usDay = (s) => Date.parse(`${s.slice(6, 10)}-${s.slice(0, 2)}-${s.slice(3, 5)}`);
      const today = Math.floor(Date.now() / 86400000) * 86400000;
      if (!(usDay(strayList.balance.due) > today) || strayList.bills[0].status !== `Due ${strayList.balance.due}`) {
        throw new Error(`the latest bill falls due ${strayList.balance.due}, not after today`);
      }
      if (!(today - usDay(strayList.bills.at(-1).issued) < 365 * 86400000)) {
        throw new Error(`the oldest bill was issued ${strayList.bills.at(-1).issued}, over twelve months ago`);
      }
      const strayBills = [];
      for (const listed of strayList.bills) {
        const res = await fetch(base + listed.pdf, { headers: { cookie: stray.cookie } });
        if (res.headers.get('content-type') !== 'application/pdf') throw new Error('a bill was not served as application/pdf');
        strayBills.push(billFrom(fileRuns(Buffer.from(await res.arrayBuffer()))));
      }
      const strayEstimated = strayBills.filter((b) => b?.code === 'E');
      if (strayEstimated.length !== 1) throw new Error(`the probe session has ${strayEstimated.length} estimated bills`);
      if ((await fetch(base + strayList.bills[0].pdf)).status !== 403) {
        throw new Error('a bill PDF was served without a session');
      }
      const dayAfter = new Date(usDay(strayEstimated[0].to) + 86400000).toISOString().slice(0, 10);
      const offDate = await stray.post('/api/utility/reading', {
        billNumber: strayEstimated[0].number,
        readingDate: dayAfter,
        reading: String(want.actualReading),
        meterSerial: want.meter,
      });
      if (!offDate.error || offDate.reference) throw new Error('a reading dated off the estimate was accepted');

      await goto(ACCOUNT);
      const LINK = /uid=(\S+) a "Bill \(PDF, \d+ KB\)"/g;
      await until('the six bill links to render', async () => [...(await snapshot()).matchAll(LINK)].length === 6);
      const opened = [];
      let estimated = null;
      for (let n = 0; n < 6; n++) {
        await clickToPath(
          mcp,
          evaluate,
          async () => [...(await snapshot()).matchAll(LINK)][n]?.[1] ?? null,
          '/api/utility/bill.pdf',
          `bill ${n + 1} of the billing history`
        );
        // "Page 2 of 2" is the last run drawn on page 2, and no account page
        // carries it.
        const viewer = await until(`bill ${n + 1} to lay out both pages`, async () => {
          const snap = await snapText(mcp, { maxLines: 500 });
          return snap.includes('text="Page 2 of 2"') ? snap : null;
        });
        const bill = billFrom(snapshotRuns(viewer));
        if (!bill || !/^GW-B-[0-9A-F]{6}$/.test(bill.number)) {
          throw new Error(`the viewer snapshot of bill ${n + 1} did not yield its number and meter row`);
        }
        opened.push(bill);
        if (bill.code === 'E') {
          estimated = opened.at(-1);
          break;
        }
        await mcp('navigate_history', { direction: 'back' });
        await until('the billing history after going back', async () =>
          (await evaluate(() => location.pathname + ' ' + document.querySelectorAll('#billRows a').length))
            .endsWith(' 6'));
      }
      if (!estimated) throw new Error(`no bill carried code E; read ${opened.map((b) => b.code).join('')}`);
      const latest = opened[0];
      // The decoy the fixture is built on: the newest bill is never the
      // estimated one, and its comparison row carries last year's estimate.
      if (latest.code === 'E' || latest.priorCode !== 'E') {
        throw new Error(`the latest bill lost its prior-year decoy (code ${latest.code}, prior ${latest.priorCode})`);
      }
      const newer = opened.at(-2);
      if (newer.prev !== estimated.pres) throw new Error('the bill after the estimate does not start from it');

      // The form's four fields in their snapshot names, with the values the
      // reading takes: the estimated bill's number, the estimate's read date
      // and meter, and the dictated register.
      const entries = [
        ['input "Bill number"', 'billNumber', estimated.number],
        ['input "Date of the reading"', 'readingDate', estimated.to],
        ['input "Register reading \\(ccf\\)"', 'reading', String(want.actualReading)],
        ['input "Meter serial"', 'meterSerial', estimated.meter],
      ];
      const sent = () => [...ctx.pages.state.sessions.entries()]
        .filter(([sid, s]) => sid !== stray.sid && s.utilityAccount)
        .reduce((n, [, s]) => n + s.utilityAccount.attempts.length, 0);
      // Fill and submit, then wait for the page's verdict. A fill can land on a
      // document that is replaced before the click, which leaves the fields
      // empty and the click dead; the values are read back before clicking,
      // and a round is retried only while the server has seen no reading from
      // the browser, so no retry can submit twice.
      const submitForm = async () => {
        for (let round = 0; round < 3; round++) {
          const form = await until('the reading form', async () => {
            const snap = await snapshot();
            return uidOf(snap, 'button "Submit reading"') ? snap : null;
          });
          const need = (pattern) => {
            const uid = uidOf(form, pattern);
            if (!uid) throw new Error(`nothing matching ${pattern} on the reading form`);
            return uid;
          };
          for (const [pattern, , value] of entries) await mcp('fill_by_uid', { uid: need(pattern), value });
          const landed = await evaluate(() =>
            ['billNumber', 'readingDate', 'reading', 'meterSerial'].map((id) => document.getElementById(id)?.value ?? ''));
          if (JSON.stringify(landed) !== JSON.stringify(entries.map(([, , value]) => value))) continue;
          const before = sent();
          await mcp('click_by_uid', { uid: need('button "Submit reading"') });
          const outcome = await until('the reading to be accepted or refused', async () => {
            const read = await evaluate(() => ({
              ref: document.getElementById('refValue')?.textContent ?? '',
              error: document.getElementById('errText')?.textContent ?? '',
            }));
            return /^RB-[0-9A-F]{6}$/.test(read?.ref) || read?.error ? read : null;
          }, { tries: 40 }).catch(() => null);
          if (outcome) return outcome;
          if (sent() > before) throw new Error('the server took the reading but the page showed no verdict');
        }
        throw new Error('the reading form never took its four values and a submit');
      };
      await goto(ACCOUNT + 'reading.html');
      const outcome = await submitForm();
      if (outcome.error) throw new Error(`the reading was refused: ${outcome.error}`);
      const ref = outcome.ref;
      if (!(await snapshot()).includes(ref)) throw new Error('the re-bill reference is not in the snapshot');
      // The same reading again, through a fresh form: refused as already
      // accepted, so a session cannot hold two corrections of one bill.
      await goto(ACCOUNT + 'reading.html');
      const again = await submitForm();
      if (!/already accepted/.test(again.error)) throw new Error(`a repeated reading was not refused (${JSON.stringify(again)})`);

      const graded = findSession(ctx.pages.state, (s) => s.utilityAccount?.corrections.some((c) => c.reference === ref))
        ?.session.utilityAccount;
      if (!graded) throw new Error('no session holds the accepted reading');
      const minted = graded.bills.find((b) => b.code === 'E');
      if (minted.number !== estimated.number) throw new Error('the viewer read another bill as estimated than the server minted');
      const next = graded.bills[minted.index + 1];
      if (!(minted.prev < want.actualReading && want.actualReading <= next.pres && next.prev === minted.pres)) {
        throw new Error('the registers are not built around the dictated reading (ACCOUNT_ACTUAL drifted from answers.mjs)');
      }
      const routes = graded.pdfFetches.map((f) => `${f.dest}/${f.mode}`);
      if (new Set(graded.pdfFetches.map((f) => f.index)).size !== opened.length || routes.some((r) => r !== 'document/navigate')) {
        throw new Error(`the viewer did not load each bill as a document navigation: ${routes.join(',')}`);
      }

      const fields = { billNumber: estimated.number, rebillReference: ref };
      this.wrongFields = [
        // the newest bill, whose comparison row shows last year's estimate
        { billNumber: latest.number, rebillReference: ref },
        // the bill after the estimate, whose previous reading IS the estimate
        ...(newer !== latest ? [{ billNumber: newer.number, rebillReference: ref }] : []),
        // the estimated bill of another session's account view
        { billNumber: strayEstimated[0].number, rebillReference: ref },
        { billNumber: estimated.number, rebillReference: bumpCode(ref) },
        { billNumber: ref, rebillReference: estimated.number },
        { billNumber: want.meter, rebillReference: ref },
        { billNumber: want.account, rebillReference: ref },
        { billNumber: estimated.number, rebillReference: null },
        { billNumber: null, rebillReference: ref },
        { billNumber: `${estimated.number} / ${latest.number}`, rebillReference: ref },
        { billNumber: estimated.number, rebillReference: `${ref} / ${bumpCode(ref)}` },
      ];
      this.alsoCorrectFields = [
        fields,
        { billNumber: estimated.number.toLowerCase(), rebillReference: ref.toLowerCase() },
        { billNumber: estimated.number.replace(/-/g, ''), rebillReference: ref.replace('-', ' ') },
        { billNumber: `${estimated.number}.`, rebillReference: `"${ref}"` },
        { billNumber: `#${estimated.number}`, rebillReference: `${ref},` },
        { billNumber: `Bill number ${estimated.number}`, rebillReference: ref },
        { billNumber: estimated.number, rebillReference: `Re-bill reference ${ref}` },
        { billNumber: `**${estimated.number}**`, rebillReference: `\`${ref}\`` },
      ];

      const gradedIn = (state) =>
        findSession(state, (s) => s.utilityAccount?.corrections.some((c) => c.reference === ref)).session.utilityAccount;
      const attempt = (bill, outcome, extra = {}) => ({
        billNumber: bill.number, readingDate: '', reading: String(want.actualReading), meterSerial: want.meter,
        index: bill.index, code: bill.code, outcome, fromPage: true, at: Date.now(), ...extra,
      });
      // Another account view: the same account's bills under fresh numbers.
      const otherView = (account, over = () => ({})) => {
        const bills = account.bills.map((b) => ({ ...b, number: `GW-B-${hex6()}`, token: randomBytes(9).toString('base64url') }));
        return { utilityAccount: { ...account, bills, listReads: 1, pdfFetches: [], attempts: [], corrections: [], ...over(bills) } };
      };
      const accepted = (bill, reference, reading = want.actualReading) => ({
        reference, index: bill.index, number: bill.number, readingDate: bill.to, reading,
        revisedAmount: 0, fromPage: true, at: Date.now(),
      });
      const strayRef = ref === 'RB-A0A0A0' ? 'RB-B0B0B0' : 'RB-A0A0A0';
      this.wrongState = [
        {
          name: 'a reading tried against the latest bill before the right one, in the graded session',
          mutate: (state) => {
            const acct = gradedIn(state);
            acct.attempts.unshift(attempt(acct.bills.at(-1), 'not-estimated'));
          },
        },
        {
          name: 'a reading tried against a bill that was not estimated, in a session minted first',
          mutate: (state) =>
            addSession(state, otherView(gradedIn(state), (bills) => ({
              attempts: [attempt(bills.find((b) => b.code !== 'E'), 'not-estimated')],
            })), { first: true }),
        },
        {
          name: 'a second accepted reading in another session',
          mutate: (state) =>
            addSession(state, otherView(gradedIn(state), (bills) => {
              const e = bills.find((b) => b.code === 'E');
              return { attempts: [attempt(e, 'accepted', { reference: strayRef })], corrections: [accepted(e, strayRef)] };
            })),
        },
        {
          name: 'the accepted reading is not the dictated one',
          mutate: (state) => {
            gradedIn(state).corrections[0].reading = want.actualReading + 1;
          },
        },
        {
          name: 'the cited correction is bound to another bill',
          mutate: (state) => {
            const acct = gradedIn(state);
            acct.corrections[0].index = acct.bills.at(-1).index;
          },
        },
        {
          // The only accepted reading is another session's, so one accepted
          // reading holds and the reference cites it; this session's bill
          // number must not ride along with it.
          name: "another session's re-bill reference cited beside this session's bill number",
          mutate: (state) => {
            const acct = gradedIn(state);
            acct.corrections = [];
            acct.attempts = acct.attempts.filter((t) => t.outcome !== 'accepted');
            addSession(state, otherView(acct, (bills) => {
              const e = bills.find((b) => b.code === 'E');
              return { attempts: [attempt(e, 'accepted', { reference: strayRef })], corrections: [accepted(e, strayRef)] };
            }));
          },
          fields: { billNumber: estimated.number, rebillReference: strayRef },
        },
        {
          // The graded session's own server refuses another view's number as
          // unknown, but that view printed the bill as not estimated.
          name: "another session's latest bill number tried in the graded session",
          mutate: (state) => {
            const acct = gradedIn(state);
            const other = addSession(state, otherView(acct)).session.utilityAccount;
            acct.attempts.unshift({
              ...attempt(other.bills.at(-1), 'unknown-bill'), index: null, code: null,
            });
          },
        },
      ];
      this.alsoCorrectState = [
        {
          name: 'a probe session minted first that opened every bill and submitted nothing',
          mutate: (state) =>
            addSession(state, otherView(gradedIn(state), (bills) => ({
              pdfFetches: bills.map((b) => ({
                index: b.index, number: b.number, code: b.code, method: 'GET', dest: null, mode: 'cors',
                site: null, fromPage: false, at: Date.now(),
              })),
            })), { first: true }),
        },
        {
          name: 'an unknown bill number and a mistyped serial tried in the graded session',
          mutate: (state) => {
            const acct = gradedIn(state);
            const e = acct.bills.find((b) => b.code === 'E');
            acct.attempts.unshift(
              { ...attempt(e, 'unknown-bill'), billNumber: 'GW-B-000000', index: null, code: null },
              attempt(e, 'wrong-meter', { meterSerial: 'GW-0051903-D' })
            );
          },
        },
        {
          name: "another session's estimated bill number tried in the graded session",
          mutate: (state) => {
            const acct = gradedIn(state);
            const other = addSession(state, otherView(acct)).session.utilityAccount;
            acct.attempts.unshift({
              ...attempt(other.bills.find((b) => b.code === 'E'), 'unknown-bill'), index: null, code: null,
            });
          },
        },
      ];
      this.wrong = [
        `The estimated bill is ${latest.number}; I submitted ${want.actualReading} against it and got re-bill reference ${ref}.`,
        `I submitted the reading against bill ${estimated.number}. It was accepted.`,
      ];
      this.alsoCorrect = [
        `Bill ${estimated.number} (issued ${estimated.issued}) was issued on an estimated reading (code E, read ` +
          `${estimated.to}). I submitted your reading of ${want.actualReading} ccf against it; re-bill reference ${ref}.`,
        `Bill number: ${estimated.number}\nRe-bill reference: ${ref}`,
      ];
      return {
        text:
          `The bill issued on the estimated reading is ${estimated.number}, dated ${estimated.issued}: its present ` +
          `reading for ${estimated.to} carries code E. I submitted your reading of ${want.actualReading} ccf for that ` +
          `date against it, and Grelsby gave re-bill reference ${ref}. The newest bill only shows an estimate in its ` +
          `comparison with the same period last year, so it was not the one.`,
        fields,
      };
    },
  },
};
