// pages/utility/ - Grelsby Water & Sewer Authority transfer desk
// (meter-transfer). The endpoint accepts a meter number only in the recorded
// format (GW-0000000-X, uppercase, dashed, zero-padded) and only for the meter
// attached to the account the page shows; the transfer reference is minted per
// session from randomBytes. The recorded meter value below never appears in
// fixture source - the page's blur-time standardiser (or the on-page format
// hint) is what produces it from the raw id the ask supplies.
import { randomBytes } from 'node:crypto';
import { round2 } from './lib.mjs';
import { PdfPage, pdfDocument } from './pdf.mjs';

const UTILITY_ACCOUNT = '44-58291-03';
const UTILITY_METER = 'GW-0042117-B';
const UTILITY_FORMAT = /^[A-Z]{2}-\d{7}-[A-Z]$/;

function utilityState(session) {
  return (session.utility ??= { transfers: [], rejects: [] });
}

export function routes(ctx) {
  const { json, readJson, requireSession, fromPage } = ctx;
  const utilityFromPage = fromPage('/utility/');
  const account = accountRoutes(ctx);
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/utility/transfer') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const record = utilityState(found.session);
      const meterId = String(payload.meterId ?? '').trim();
      const occupant = String(payload.occupant ?? '').trim();
      const reject = (status, error) => {
        record.rejects.push({ meterId, occupant, error, at: Date.now() });
        return json(res, status, { error });
      };
      if (!occupant) {
        return reject(400, 'The new account holder name is required.');
      }
      if (!UTILITY_FORMAT.test(meterId)) {
        return reject(
          422,
          'Meter number is not in the recorded form. Meters are recorded as GW-0000000-X.'
        );
      }
      if (meterId !== UTILITY_METER) {
        return reject(
          404,
          `No meter with that number is attached to account ${UTILITY_ACCOUNT}.`
        );
      }
      const transfer = {
        reference: 'TR-' + randomBytes(3).toString('hex').toUpperCase(),
        meterId,
        occupant,
        phone: String(payload.phone ?? '').trim(),
        // Legibility, never proof: curl sets these headers freely.
        fromPage: utilityFromPage(req),
        at: Date.now(),
      };
      record.transfers.push(transfer);
      return json(res, 200, {
        ok: true,
        reference: transfer.reference,
        meterId,
        occupant,
      });
    }
    return account(req, res, url, pathname0);
  };
}

// pages/utility/account/ - the My Account area (pdf-bill). Each session gets
// six bimonthly bills on one account, served as real two-page PDFs by
// /api/utility/bill.pdf behind the session cookie and a per-bill token that
// only the nonce-gated account API hands out; nothing but the PDF carries a
// bill's number or its readings. Which bill was issued on an estimated reading
// is a difficulty draw, and bill numbers, tokens and re-bill references come
// from randomBytes. ACCOUNT_ACTUAL is the reading the ask dictates: it is the
// true register value on the estimated bill's read date, so the registers are
// built around it and it is printed on no bill (the estimated bill shows the
// estimate, and the bill after it starts from the estimate).
const ACCOUNT = {
  number: '44-60317-08',
  holder: 'T. Veltrow',
  street: '27 Pumphouse Hill',
  town: 'Grelsby',
  meter: 'GW-0051903-C',
  meterSize: '5/8 in.',
  route: 'Route 4, bimonthly',
};
const ACCOUNT_ACTUAL = 4127;
// Route read dates, oldest first: bill i runs from READS[i] to READS[i + 1].
const READS = ['2025-08-26', '2025-10-27', '2025-12-29', '2026-02-26', '2026-04-28', '2026-06-26', '2026-08-27'];
// The same periods a year earlier, for each bill's usage comparison. The
// latest bill's comparison row carries the one estimate outside the six bills.
const PRIOR = ['2024-08-27', '2024-10-28', '2024-12-30', '2025-02-26', '2025-04-28', '2025-06-25', '2025-08-26'];
const RATES = { first: 3.12, firstBlock: 12, above: 3.94, fixed: 21.4, sewer: 0.72 };
const OPENING_BALANCE = 142.18;
const CODE_NAMES = { A: 'an actual reading (code A)', C: 'a reading you supplied (code C)' };

const DAY = 86400000;
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const usDate = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const grouped = (n) => n.toLocaleString('en-US');

function charges(usage) {
  const first = Math.min(usage, RATES.firstBlock);
  const above = Math.max(usage - RATES.firstBlock, 0);
  const firstCharge = round2(first * RATES.first);
  const aboveCharge = round2(above * RATES.above);
  const water = round2(firstCharge + aboveCharge);
  const sewer = round2(water * RATES.sewer);
  return { first, above, firstCharge, aboveCharge, water, fixed: RATES.fixed, sewer, total: round2(water + RATES.fixed + sewer) };
}

const NOTES = {
  A: [
    ['Leaks cost money. A running toilet can waste 200 gallons a day; call customer',
      'service if your usage rises without an explanation.'],
    ['Keep the meter pit lid clear of mulch, planters and parked vehicles so the route',
      'clerk can read your meter on the scheduled day.'],
    ['Hydrant flushing on the distribution loops can leave water discolored for a few',
      'hours. If it does, run the cold tap until it clears.'],
  ],
  C: ['Thank you for sending us your meter reading for this period. Customer readings',
    '(code C) are checked against the next actual reading on the route.'],
  E: (date) => [
    `Your meter could not be read on ${date}: the meter pit lid was obstructed. This bill`,
    'was issued on an estimated reading (code E), calculated from your usage in the same',
    'period last year. If you read the meter yourself that day, submit the reading under',
    'Submit a Meter Reading in My Account, and the bill will be recalculated from it.',
  ],
};
const FRONT_NOTES = [
  ['Payment can be made at the counter, by mail, through the night depository or',
    'through your bank’s bill-pay service. Quote your service account number.'],
  ['An account holder who expects difficulty paying should speak to the billing clerk',
    'before the due date. Budget arrangements are available.'],
];

// `estimated` is the position (oldest first, never the latest bill) of the bill
// issued on an estimate; `bytes` are 16 difficulty bytes for usage and codes.
export function mintBills(estimated, bytes) {
  const usage = READS.slice(1).map((_, i) => 24 + (bytes[i] % 17));
  const prior = READS.slice(1).map((_, i) => 22 + (bytes[6 + i] % 17));
  // The estimate repeats last year's usage for the period, 7-13 ccf off the
  // true usage, so the corrected bill visibly changes.
  const miss = 7 + (bytes[12] % 7);
  prior[estimated] = bytes[13] & 1 ? usage[estimated] + miss : usage[estimated] - miss;
  const actual = [];
  actual[estimated + 1] = ACCOUNT_ACTUAL;
  for (let j = estimated + 1; j < READS.length - 1; j++) actual[j + 1] = actual[j] + usage[j];
  for (let j = estimated; j >= 0; j--) actual[j] = actual[j + 1] - usage[j];
  const estimate = actual[estimated] + prior[estimated];
  const others = [0, 1, 2, 3, 4, 5].filter((i) => i !== estimated);
  const firstC = others[bytes[14] % others.length];
  const rest = others.filter((i) => i !== firstC);
  const secondC = rest[bytes[15] % rest.length];
  const taken = new Set();
  const bills = [];
  let payment = { amount: OPENING_BALANCE, on: '2025-09-12' };
  for (let i = 0; i < 6; i++) {
    let number;
    do number = 'GW-B-' + randomBytes(3).toString('hex').toUpperCase();
    while (taken.has(number));
    taken.add(number);
    const code = i === estimated ? 'E' : i === firstC || i === secondC ? 'C' : 'A';
    const prev = i === estimated + 1 ? estimate : actual[i];
    const pres = i === estimated ? estimate : actual[i + 1];
    const issued = addDays(READS[i + 1], 8);
    const bill = {
      index: i,
      number,
      token: randomBytes(9).toString('base64url'),
      issued,
      due: addDays(issued, 21),
      from: READS[i],
      to: READS[i + 1],
      days: daysBetween(READS[i], READS[i + 1]),
      prev,
      pres,
      code,
      usage: pres - prev,
      // The register the next reading on the route found, which bounds a
      // submitted replacement for this bill's present reading.
      nextActual: actual[i + 2] ?? null,
      previousBalance: payment.amount,
      payment,
      priorPeriod: {
        from: PRIOR[i],
        to: PRIOR[i + 1],
        days: daysBetween(PRIOR[i], PRIOR[i + 1]),
        usage: prior[i],
        code: i === 5 ? 'E' : 'A',
      },
      note: code === 'E' ? NOTES.E(usDate(READS[i + 1])) : code === 'C' ? NOTES.C : NOTES.A[i % 3],
      frontNote: FRONT_NOTES[i % 2],
    };
    bill.charges = charges(bill.usage);
    bills.push(bill);
    payment = { amount: bill.charges.total, on: addDays(issued, 11 + (bytes[i] % 6)) };
  }
  return bills;
}

// A bill's two pages: the summary with its payment stub, then the meter
// readings, the code key, the usage comparison and the charges.
export function billPdf(bill, account = ACCOUNT) {
  const R = 570;
  const L = 42;
  const label = { size: 7.5, gray: 0.35 };
  const p1 = new PdfPage();
  p1.circle(66, 742, 17, { width: 1.4, gray: 0.1 })
    .text(66, 738, 'GW', { font: 'F2', size: 11, align: 'center', gray: 0.1 })
    .text(92, 748, 'GRELSBY WATER & SEWER AUTHORITY', { font: 'F2', size: 12 })
    .text(92, 736, 'Works Yard, 4 Aqueduct Road, Grelsby', { size: 8 })
    .text(92, 726, 'Customer service (802) 555-0122 · Mon–Fri 8:30 a.m.–4:00 p.m.', { size: 8 })
    .box(372, 688, 198, 76, { fill: 0.94, stroke: 0.6 })
    .text(380, 752, 'WATER AND SEWER BILL', { font: 'F2', size: 9.5 });
  [['Bill number', bill.number], ['Bill date', usDate(bill.issued)], ['Service account', account.number],
    ['Payment due', usDate(bill.due)]].forEach(([k, v], n) => {
    p1.text(380, 738 - n * 12, k, label).text(562, 738 - n * 12, v, { font: 'F2', size: 8.5, align: 'right' });
  });
  p1.rule(L, 676, R, 676, { width: 0.8 });
  [['Account holder', account.holder], ['Service address', `${account.street}, ${account.town}`],
    ['Billing period', `${usDate(bill.from)} – ${usDate(bill.to)} (${bill.days} days)`]].forEach(([k, v], n) => {
    p1.text(L, 660 - n * 26, k, label).text(L, 649 - n * 26, v, { size: 9.5 });
  });
  p1.text(340, 660, 'Meter', label).text(340, 649, account.meter, { font: 'F3', size: 9.5 })
    .text(340, 634, 'Usage this period', label).text(340, 623, `${bill.usage} ccf (readings on page 2)`, { size: 9.5 });
  p1.text(L, 566, 'SUMMARY OF CHARGES', { font: 'F2', size: 9 }).rule(L, 560, R, 560);
  const c = bill.charges;
  const rows = [
    ['Previous balance', money(bill.previousBalance)],
    [`Payment received ${usDate(bill.payment.on)} – thank you`, `-${money(bill.payment.amount)}`],
    ['Balance forward', money(round2(bill.previousBalance - bill.payment.amount))],
    [`Water consumption, ${bill.usage} ccf`, money(c.water)],
    [`Fixed service charge, ${account.meterSize} meter`, money(c.fixed)],
    [`Sanitary sewer surcharge (${Math.round(RATES.sewer * 100)}% of water)`, money(c.sewer)],
  ];
  rows.forEach(([k, v], n) => p1.text(L, 544 - n * 14, k, { size: 9 }).text(R, 544 - n * 14, v, { size: 9, align: 'right' }));
  p1.rule(L, 456, R, 456)
    .text(L, 444, 'Current charges', { font: 'F2', size: 9 }).text(R, 444, money(c.total), { font: 'F2', size: 9, align: 'right' })
    .box(L, 410, R - L, 24, { fill: 0.9 })
    .text(L + 8, 418, `AMOUNT DUE BY ${usDate(bill.due)}`, { font: 'F2', size: 10.5 })
    .text(R - 8, 418, money(c.total), { font: 'F2', size: 10.5, align: 'right' })
    .box(L, 300, R - L, 84, { stroke: 0.6 })
    .text(L + 10, 368, 'MESSAGES', { font: 'F2', size: 8 });
  bill.frontNote.forEach((line, n) => p1.text(L + 10, 352 - n * 12, line, { size: 8.5 }));
  p1.text(306, 210, 'Detach and return this portion with your payment', { size: 7, align: 'center', gray: 0.35 })
    .rule(L, 200, R, 200, { dash: [3, 3], gray: 0.4 })
    .text(L, 178, 'GRELSBY WATER & SEWER AUTHORITY', { font: 'F2', size: 9 })
    .text(L, 166, 'Works Yard, 4 Aqueduct Road, Grelsby', { size: 8 })
    .text(L, 128, account.holder, { size: 9.5 })
    .text(L, 116, account.street, { size: 9.5 })
    .text(L, 104, account.town, { size: 9.5 });
  [['Service account', account.number], ['Bill number', bill.number], ['Amount due', money(c.total)],
    ['Due date', usDate(bill.due)]].forEach(([k, v], n) => {
    p1.text(372, 178 - n * 14, k, label).text(R, 178 - n * 14, v, { font: 'F2', size: 9, align: 'right' });
  });
  p1.text(372, 110, 'Amount enclosed', label).rule(470, 108, R, 108, { gray: 0.3 })
    .text(306, 40, 'Page 1 of 2', { size: 7, align: 'center', gray: 0.35 });

  const p2 = new PdfPage();
  p2.text(L, 750, 'Grelsby Water & Sewer Authority', { font: 'F2', size: 9 })
    .text(R, 750, `Service account ${account.number}`, { size: 8, align: 'right' })
    .text(R, 739, `Bill number ${bill.number}`, { size: 8, align: 'right' })
    .rule(L, 730, R, 730, { width: 0.8 })
    .text(L, 708, 'METER READINGS', { font: 'F2', size: 9 }).rule(L, 702, R, 702);
  const cols = [[L, 'Meter'], [132, 'Size'], [176, 'Previous read'], [300, 'Reading', 'right'],
    [320, 'Present read'], [442, 'Reading', 'right'], [462, 'Code'], [R, 'Usage (ccf)', 'right']];
  cols.forEach(([x, t, a]) => p2.text(x, 690, t, { ...label, align: a ?? 'left' }));
  const cells = [account.meter, account.meterSize, usDate(bill.from), grouped(bill.prev), usDate(bill.to),
    grouped(bill.pres), bill.code, String(bill.usage)];
  cells.forEach((t, n) => {
    const [x, , a] = cols[n];
    p2.text(x, 674, t, { font: n === 0 ? 'F3' : n === 6 ? 'F2' : 'F1', size: 9, align: a ?? 'left' });
  });
  p2.rule(L, 664, R, 664, { gray: 0.6 })
    .text(L, 652, 'Readings are in hundreds of cubic feet (ccf). The code describes the present reading.', { size: 7.5, gray: 0.35 })
    .text(L, 622, 'READING CODES', { font: 'F2', size: 9 }).rule(L, 616, R, 616);
  [['A', 'Actual reading taken by the route clerk'],
    ['C', 'Customer reading, submitted by the account holder'],
    ['E', 'Estimated: the meter could not be read, and usage was estimated from the same period last year']]
    .forEach(([k, v], n) => p2.text(L, 602 - n * 12, k, { font: 'F2', size: 8.5 }).text(L + 18, 602 - n * 12, v, { size: 8.5 }));
  p2.text(L, 552, 'USAGE COMPARISON', { font: 'F2', size: 9 }).rule(L, 546, R, 546);
  [[L, 'Period'], [176, 'From'], [256, 'To'], [370, 'Days', 'right'], [450, 'Usage (ccf)', 'right'], [470, 'Code']]
    .forEach(([x, t, a]) => p2.text(x, 534, t, { ...label, align: a ?? 'left' }));
  [['This period', bill.from, bill.to, bill.days, bill.usage, bill.code],
    ['Same period last year', ...Object.values(bill.priorPeriod)]].forEach(([k, from, to, days, used, code], n) => {
    const y = 520 - n * 13;
    p2.text(L, y, k, { size: 9 }).text(176, y, usDate(from), { size: 9 }).text(256, y, usDate(to), { size: 9 })
      .text(370, y, String(days), { size: 9, align: 'right' }).text(450, y, String(used), { size: 9, align: 'right' })
      .text(470, y, code, { font: 'F2', size: 9 });
  });
  p2.text(L, 470, 'CHARGES DETAIL', { font: 'F2', size: 9 }).rule(L, 464, R, 464);
  [[`Consumption, first ${RATES.firstBlock} ccf`, `${c.first} ccf x ${money(RATES.first)}`, money(c.firstCharge)],
    [`Consumption, above ${RATES.firstBlock} ccf`, `${c.above} ccf x ${money(RATES.above)}`, money(c.aboveCharge)],
    [`Fixed service charge, ${account.meterSize} meter (bimonthly)`, '', money(c.fixed)],
    ['Sanitary sewer surcharge', `${Math.round(RATES.sewer * 100)}% of ${money(c.water)}`, money(c.sewer)]]
    .forEach(([k, basis, v], n) => {
      const y = 450 - n * 13;
      p2.text(L, y, k, { size: 9 }).text(442, y, basis, { size: 9, align: 'right' }).text(R, y, v, { size: 9, align: 'right' });
    });
  p2.rule(L, 392, R, 392)
    .text(L, 380, 'Current charges', { font: 'F2', size: 9 }).text(R, 380, money(c.total), { font: 'F2', size: 9, align: 'right' })
    .text(L, 346, 'MESSAGES FOR THIS ACCOUNT', { font: 'F2', size: 9 }).rule(L, 340, R, 340);
  bill.note.forEach((line, n) => p2.text(L, 326 - n * 12, line, { size: 8.5 }));
  p2.text(306, 40, 'Page 2 of 2', { size: 7, align: 'center', gray: 0.35 });
  return pdfDocument([p1, p2], {
    info: { Title: 'Water and Sewer Bill', Author: 'Grelsby Water & Sewer Authority', Producer: 'GWSA Billing' },
    created: new Date(`${bill.issued}T06:00:00Z`),
  });
}

function accountState(session, ctx) {
  if (session.utilityAccount) return session.utilityAccount;
  const estimated = ctx.pick('utility.estimated-bill', [0, 1, 2, 3, 4]);
  return (session.utilityAccount = {
    estimated,
    bills: mintBills(estimated, ctx.draw('utility.bills', 16)),
    listReads: 0,
    pdfFetches: [],
    attempts: [],
    corrections: [],
  });
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// MM/DD/YYYY as the form asks, and the ISO and written-month forms a reader
// might type instead; null for anything else.
function readingDate(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let y, m, d;
  let hit;
  if ((hit = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, m, d, y] = hit;
  else if ((hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = hit;
  else if ((hit = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/))) [, m, d, y] = [hit[0], MONTHS.indexOf(hit[1]) + 1, hit[2], hit[3]];
  else if ((hit = s.match(/^(\d{1,2}) ([a-z]{3})[a-z]*\.?,? (\d{4})$/))) [, d, m, y] = [hit[0], hit[1], MONTHS.indexOf(hit[2]) + 1, hit[3]];
  else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number(m) >= 1 && !Number.isNaN(Date.parse(iso)) && addDays(iso, 0) === iso ? iso : null;
}
const foldCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function accountRoutes(ctx) {
  const { json, readJson, getSession, requireSession, fromPage } = ctx;
  // Legibility, never proof: curl sets these headers freely.
  const accountFromPage = fromPage('/utility/account/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/utility/account') {
      const found = requireSession(req, res);
      if (!found) return;
      const acct = accountState(found.session, ctx);
      acct.listReads++;
      const latest = acct.bills.at(-1);
      return json(res, 200, {
        account: { ...ACCOUNT, premises: `${ACCOUNT.street}, ${ACCOUNT.town}` },
        balance: { amount: latest.charges.total, due: usDate(latest.due) },
        lastPayment: { amount: latest.payment.amount, on: usDate(latest.payment.on) },
        bills: [...acct.bills].reverse().map((b, n) => ({
          issued: usDate(b.issued),
          from: usDate(b.from),
          to: usDate(b.to),
          amount: b.charges.total,
          status: n === 0 ? `Due ${usDate(b.due)}` : 'Paid',
          pdf: `/api/utility/bill.pdf?b=${b.token}`,
          kb: Math.max(1, Math.round(billPdf(b).length / 1024)),
        })),
      });
    }

    // A plain link, so no nonce: the session cookie and a token only the
    // account API hands out gate it. Every fetch is recorded with the
    // headers that tell a document navigation (the viewer, or a download)
    // from an in-page fetch; telemetry only.
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname0 === '/api/utility/bill.pdf') {
      const found = getSession(req);
      if (!found) return json(res, 403, { error: 'session required' });
      const acct = found.session.utilityAccount;
      const bill = acct?.bills.find((b) => b.token === url.searchParams.get('b'));
      if (!bill) return json(res, 404, { error: 'No bill was found at that address. Open it again from My Account.' });
      const body = billPdf(bill);
      acct.pdfFetches.push({
        index: bill.index,
        number: bill.number,
        code: bill.code,
        method: req.method,
        dest: req.headers['sec-fetch-dest'] ?? null,
        mode: req.headers['sec-fetch-mode'] ?? null,
        site: req.headers['sec-fetch-site'] ?? null,
        fromPage: accountFromPage(req),
        at: Date.now(),
      });
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': body.length,
        'content-disposition': `inline; filename="grelsby-water-bill-${bill.issued}.pdf"`,
        'cache-control': 'private, no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (req.method === 'POST' && pathname0 === '/api/utility/reading') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const acct = accountState(found.session, ctx);
      const entered = {
        billNumber: String(payload.billNumber ?? '').trim(),
        readingDate: String(payload.readingDate ?? '').trim(),
        reading: String(payload.reading ?? '').trim(),
        meterSerial: String(payload.meterSerial ?? '').trim(),
      };
      const bill = entered.billNumber
        ? acct.bills.find((b) => foldCode(b.number) === foldCode(entered.billNumber)) ?? null
        : null;
      // Every attempt is kept, because grading counts attempts against a bill
      // that was not estimated, in every session.
      const attempt = {
        ...entered,
        index: bill?.index ?? null,
        code: bill?.code ?? null,
        outcome: null,
        fromPage: accountFromPage(req),
        at: Date.now(),
      };
      acct.attempts.push(attempt);
      const refuse = (status, outcome, error) => {
        attempt.outcome = outcome;
        return json(res, status, { error });
      };
      if (!entered.billNumber) return refuse(400, 'incomplete', 'Enter the bill number printed at the top of the bill.');
      if (!bill) return refuse(404, 'unknown-bill', `No bill with that number has been issued on account ${ACCOUNT.number}.`);
      if (bill.code !== 'E') {
        return refuse(409, 'not-estimated',
          `Bill ${bill.number} was issued on ${CODE_NAMES[bill.code]}. Only a bill issued on an estimated ` +
            'reading can be recalculated from a reading you submit; to dispute this bill, call customer service.');
      }
      const done = acct.corrections.find((r) => r.index === bill.index);
      if (done) {
        return refuse(409, 'duplicate', `A reading for bill ${bill.number} was already accepted (re-bill reference ${done.reference}).`);
      }
      if (!entered.readingDate || !entered.reading || !entered.meterSerial) {
        return refuse(400, 'incomplete', 'Complete every field before submitting the reading.');
      }
      const serial = foldCode(entered.meterSerial).match(/^([A-Z]{2})(\d{1,7})([A-Z])$/);
      if (!serial || `${serial[1]}-${serial[2].padStart(7, '0')}-${serial[3]}` !== ACCOUNT.meter) {
        return refuse(422, 'wrong-meter', 'That meter serial is not the meter on this account. Enter it as printed on the bill.');
      }
      const date = readingDate(entered.readingDate);
      if (!date) return refuse(422, 'bad-date', 'Enter the reading date as MM/DD/YYYY.');
      if (date !== bill.to) {
        return refuse(422, 'wrong-date', 'A replacement reading must be dated the day of the estimated reading printed on the bill.');
      }
      const digits = entered.reading.replace(/[,\s]/g, '');
      if (!/^\d{1,6}$/.test(digits)) return refuse(422, 'bad-reading', 'Enter the register reading in whole ccf, digits only.');
      const reading = Number(digits);
      if (reading < bill.prev) {
        return refuse(422, 'implausible', 'That reading is lower than the previous reading on this bill. Check the digits.');
      }
      if (bill.nextActual !== null && reading > bill.nextActual) {
        return refuse(422, 'implausible', 'That reading is higher than the next actual reading on the account. Check the digits.');
      }
      const revised = charges(reading - bill.prev);
      const correction = {
        reference: 'RB-' + randomBytes(3).toString('hex').toUpperCase(),
        index: bill.index,
        number: bill.number,
        readingDate: date,
        reading,
        revisedAmount: revised.total,
        fromPage: attempt.fromPage,
        at: attempt.at,
      };
      acct.corrections.push(correction);
      attempt.outcome = 'accepted';
      attempt.reference = correction.reference;
      return json(res, 200, {
        ok: true,
        reference: correction.reference,
        billNumber: bill.number,
        readingDate: usDate(date),
        reading,
        usage: reading - bill.prev,
        previousAmount: bill.charges.total,
        revisedAmount: revised.total,
      });
    }
    return false;
  };
}
