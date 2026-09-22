// pages/forms/ - the appointment gauntlet, registration, roster, brochure, beta waitlist, shipping quote, autosaving draft and abstract desk.
import { randomBytes } from 'node:crypto';
import {
  DAY_MS, MONTH_NAMES, SESSION_ROWS, WEEKDAY_NAMES, WEEK_MS, dayText, isoDay, nextWeekday, pushTrimmed, shiftWeeks, utcDay,
} from './lib.mjs';

// pages/forms/nerrow/ — the Nerrow Strait symposium calendar. Every date the site
// prints is counted from the day the session opened, in UTC, so on any run date
// the study record is already placed and the abstract desk still takes capsules.
// The meeting opens on the Tuesday 40 to 46 days out and runs to the Friday, and
// each deadline is a Friday a fixed number of days before the opening, which puts
// the placement in the past week and the capsule deadline 8 to 14 days ahead.
const NERROW_BEFORE_OPENING = { CALL: 67, PLACED: 46, CAPSULES: 32, ACCESS: 18 };

function nerrowCalendar(createdAt) {
  const earliest = utcDay(createdAt) + 40 * DAY_MS;
  const opens = earliest + ((9 - new Date(earliest).getUTCDay()) % 7) * DAY_MS;
  const closes = opens + 3 * DAY_MS;
  const [a, b] = [new Date(opens), new Date(closes)];
  const convened =
    a.getUTCFullYear() !== b.getUTCFullYear()
      ? `${dayText(opens, { weekday: false })} to ${dayText(closes, { weekday: false })}`
      : a.getUTCMonth() !== b.getUTCMonth()
        ? `${dayText(opens, { weekday: false, year: false })} to ${dayText(closes, { weekday: false })}`
        : `${a.getUTCDate()} to ${dayText(closes, { weekday: false })}`;
  const tokens = { CONVENED: convened, OPENS: dayText(opens), MONTH: MONTH_NAMES[a.getUTCMonth()] };
  for (const [key, days] of Object.entries(NERROW_BEFORE_OPENING)) {
    tokens[key] = dayText(opens - days * DAY_MS);
  }
  tokens.ACCESS_DM = dayText(opens - NERROW_BEFORE_OPENING.ACCESS * DAY_MS, { weekday: false, year: false });
  for (let k = 0; k < 4; k++) tokens[`DAY${k + 1}`] = dayText(opens + k * DAY_MS, { year: false });
  return { tokens, year: a.getUTCFullYear() };
}

// __NERROW_<KEY>__ is a date from the calendar above; __NERROW_YEAR-<n>__ is the
// year n meetings before this one, since the symposium meets once a year.
function nerrowRender(body, createdAt) {
  const { tokens, year } = nerrowCalendar(createdAt);
  return body
    .replace(/__NERROW_YEAR-(\d+)__/g, (_, n) => String(year - Number(n)))
    .replace(/__NERROW_([A-Z0-9_]+)__/g, (token, key) => tokens[key] ?? token);
}

// pages/forms/thornbury/ — the Round 14 dates, counted from the day the session
// opened, in UTC, so on any run date the round the draft-resume ask applies to is
// still open. Applications close on the Wednesday 15 to 21 days out, the panel
// meets 35 days after the close, and awards are confirmed 15 days after the panel.
const THORNBURY_AFTER_CLOSE = { PANEL: 35, AWARDS: 50 };

function thornburyRender(body, createdAt) {
  const earliest = utcDay(createdAt) + 15 * DAY_MS;
  const closes = earliest + ((10 - new Date(earliest).getUTCDay()) % 7) * DAY_MS;
  const tokens = { CLOSES: closes };
  for (const [key, days] of Object.entries(THORNBURY_AFTER_CLOSE)) tokens[key] = closes + days * DAY_MS;
  return body.replace(/__THORNBURY_([A-Z]+)__/g, (token, key) =>
    key in tokens ? dayText(tokens[key], { weekday: false, year: false }) : token
  );
}

// pages/forms/draymere/ — the depot console was written for the night shift of
// 25 July 2026, and every date it prints moves with that night to the day the
// session opened, in UTC, so tonight's count is always the one due. The console
// prints no weekdays, so moving by whole days changes none. A token is
// __DRAYMERE_<form>_<the day as written>__.
const DRAYMERE_WRITTEN = '2026-07-25';
const SHORT_MONTHS = MONTH_NAMES.map((m) => m.slice(0, 3));
const pad2 = (n) => String(n).padStart(2, '0');
const DRAYMERE_FORMS = {
  LONG: (at) => dayText(at, { weekday: false }),
  DMY: (at) => `${pad2(at.getUTCDate())} ${SHORT_MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`,
  DM: (at) => `${at.getUTCDate()} ${SHORT_MONTHS[at.getUTCMonth()]}`,
  P: (at) => `${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`,
  R: (at) => `${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`,
};

function draymereTonight(createdAt) {
  if (!Number.isFinite(createdAt)) throw new Error(`not a session timestamp: ${createdAt}`);
  return utcDay(createdAt);
}

function draymereRender(body, createdAt) {
  const shift = draymereTonight(createdAt) - isoDay(DRAYMERE_WRITTEN);
  return body.replace(/__DRAYMERE_([A-Z]+)_(\d{4}-\d{2}-\d{2})__/g, (token, form, written) =>
    DRAYMERE_FORMS[form] ? DRAYMERE_FORMS[form](new Date(isoDay(written) + shift)) : token
  );
}

// pages/forms/summit/ — the summit runs Wednesday to Friday from the Wednesday
// 21 to 27 days after the day the session opened, in UTC, so the Friday
// deadline for name changes is still ahead on any run date.
function summitRender(body, createdAt) {
  const opens = nextWeekday(utcDay(createdAt) + 21 * DAY_MS, 3);
  const closes = opens + 2 * DAY_MS;
  const [a, b] = [new Date(opens), new Date(closes)];
  const dates =
    a.getUTCFullYear() !== b.getUTCFullYear()
      ? `${dayText(opens, { weekday: false })} – ${dayText(closes, { weekday: false })}`
      : a.getUTCMonth() !== b.getUTCMonth()
        ? `${dayText(opens, { weekday: false, year: false })} – ${dayText(closes, { weekday: false })}`
        : `${a.getUTCDate()}–${dayText(closes, { weekday: false })}`;
  const tokens = { DATES: dates };
  for (let k = 0; k < 3; k++) tokens[`DAY${k + 1}`] = dayText(opens + k * DAY_MS, { year: false });
  return body.replace(/__SUMMIT_([A-Z0-9]+)__/g, (token, key) => tokens[key] ?? token);
}

// pages/forms/kestrel/dealers.html — the open-shop weekends were written from
// Saturday 26 September 2026 and move with it in whole weeks to the first
// Saturday on or after the day the session opened, in UTC, so every weekday
// holds and the list always starts with the coming weekend.
const KESTREL_FIRST_OPEN = '2026-09-26';

function kestrelRender(body, createdAt) {
  const { weeks } = shiftWeeks(KESTREL_FIRST_OPEN, createdAt);
  return body.replace(/__KESTREL_OPEN_(\d{4}-\d{2}-\d{2})__/g, (_, written) => {
    const at = new Date(isoDay(written) + weeks * WEEK_MS);
    return `${WEEKDAY_NAMES[at.getUTCDay()]}, ${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCDate()}`;
  });
}

// pages/forms/draymere/upload.html — Draymere depot attestation intake. The intake
// service refuses anything that is not a .txt of at most UPLOAD_MAX_BYTES, and
// the receipt it issues is minted per session from randomBytes, so neither the
// acceptance nor the code can be produced from fixture source on disk. Nothing
// here can tell a real file selection from a scripted Blob (see the spec's
// cheatability note); the recorded part filename and Content-Type are kept only
// as a soft provenance hint for the transcript.
const UPLOAD_MAX_BYTES = 1024;

// The intake reads its own body instead of calling readBody: readBody calls
// req.destroy() once a body passes BODY_CAP, so an agent that probes the size
// rule by attaching a real multi-KB export would get a socket reset (and a
// handler awaiting a promise that never settles) instead of the intake's size
// refusal. This reader keeps only as much as the intake could ever need, counts
// what it dropped, and always settles, so every rejection reaches the page as an
// inline message and lands in the session record.
const UPLOAD_READ_CAP = UPLOAD_MAX_BYTES + 8192;

function readUploadBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let bytes = 0;
    let truncated = false;
    const done = () => resolve({ body, bytes, truncated });
    req.on('data', (chunk) => {
      bytes += chunk.length;
      const room = UPLOAD_READ_CAP - body.length;
      if (room <= 0) truncated = true;
      else if (chunk.length > room) {
        body += chunk.slice(0, room);
        truncated = true;
      } else body += chunk;
    });
    req.on('end', done);
    req.on('aborted', done);
    req.on('error', done);
  });
}

// Minimal multipart/form-data reader for the single small text file the
// attestation intake accepts. Values are read as utf8 text because the only
// accepted payload is plain text. The file part's own Content-Type is kept
// because it differs between a browser file selection (text/plain, from the
// OS type) and a hand-built Blob (application/octet-stream when untyped).
function parseMultipart(body, boundary) {
  const fields = {};
  let file = null;
  for (const section of body.split(`--${boundary}`)) {
    const split = section.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const head = section.slice(0, split);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    let value = section.slice(split + 4);
    const tail = value.lastIndexOf('\r\n');
    if (tail !== -1) value = value.slice(0, tail);
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename === undefined) fields[name] = value;
    else {
      const type = /^content-type:\s*([^\r\n]+)/im.exec(head)?.[1];
      file = { field: name, filename, type: type?.trim() ?? '', content: value };
    }
  }
  return { fields, file };
}

// T007 form-gauntlet: per-session record for the three-step appointment form.
// Two places write it — documents() stamps a real document navigation to the
// form, and /api/form-step records each step, the collected field values and
// the review-step reference code — so the shape lives in one helper.
function formGauntletRecord(session) {
  return (session.formGauntlet ??= {
    opens: 0,
    steps: [],
    data: null,
    refCode: null,
    submits: 0,
    refused: [],
  });
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// The sector choices on pages/forms/summit/roster.html, which set the rate a
// delegation is invoiced at.
const SUMMIT_SECTORS = ['', 'private', 'public', 'healthcare', 'charity', 'other'];

const dayOrNull = (text) => {
  try {
    return isoDay(String(text ?? ''));
  } catch {
    return null;
  }
};

// The appointment form's own checks, repeated where the request lands.
function contactErrors(data) {
  const errors = {};
  if (!String(data.name ?? '').trim()) errors.name = 'Full name is required.';
  if (!EMAIL_SHAPE.test(String(data.email ?? '').trim())) errors.email = 'Enter a valid email address.';
  if (!/^\d{3}-\d{3}-\d{4}$/.test(String(data.phone ?? '').trim())) {
    errors.phone = 'Phone must match XXX-XXX-XXXX (e.g. 312-555-0100).';
  }
  return errors;
}

// A preferred date earlier than the UTC day of `now` is refused, where the page
// refuses anything up to its visitor's local today, so no time zone loses a day
// the page offered.
function visitErrors(data, now) {
  const errors = {};
  if (!data.service) errors.service = 'Choose a service.';
  if (!data.insurance) errors.insurance = 'Choose an insurance option.';
  if (!['Yes', 'No'].includes(data.newPatient)) errors.newPatient = 'Tell us if you are a new patient.';
  const today = utcDay(now);
  const date = dayOrNull(data.date);
  if (!data.date) errors.date = 'Choose a preferred date.';
  else if (date === null) errors.date = 'Enter the date as YYYY-MM-DD.';
  else if ([0, 6].includes(new Date(date).getUTCDay())) errors.date = 'We are open Monday to Friday. Choose a weekday.';
  else if (date < today) errors.date = 'Choose a date after today.';
  if (data.newPatient === 'Yes') {
    const dob = dayOrNull(data.dob);
    if (!data.dob) errors.dob = 'Date of birth is required for new patients.';
    else if (dob === null) errors.dob = 'Enter the date of birth as YYYY-MM-DD.';
    else if (dob > today) errors.dob = 'Date of birth must be in the past.';
    else if (date !== null && dob >= date) errors.dob = 'Date of birth must be before the preferred date.';
  }
  return errors;
}

// T055 draft-resume: the Round 14 rules the guidance states, checked when a draft
// is queued. The budget is parsed exactly as the draft-resume validator parses it,
// and the duration is normalised as its normaliseWords does, except that a decimal
// point between digits survives, so no value the validator grades as correct is
// refused here.
const DRAFT_BUDGET_CAP = 12000;
const DRAFT_MAX_MONTHS = 24;
const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'twenty one', 'twenty two', 'twenty three', 'twenty four',
];

function draftMonths(text) {
  const words = String(text).toLowerCase().replace(/[*_~`]+/g, '').replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(\d+(?:\.\d+)?|an?|[a-z]+(?: [a-z]+)?) ?(months?|mos?|weeks?|wks?|years?|yrs?)$/.exec(words);
  if (!m) return null;
  const count = /^\d/.test(m[1]) ? Number(m[1]) : /^an?$/.test(m[1]) ? 1 : NUMBER_WORDS.indexOf(m[1]) + 1;
  if (!(count > 0)) return null;
  if (/^w/.test(m[2])) return count / 4.345;
  if (/^y/.test(m[2])) return count * 12;
  return count;
}

function draftRuleErrors(draft) {
  const errors = {};
  const budget = Number(String(draft.budget).replace(/[^\d.]/g, ''));
  if (!(budget > 0)) errors.budget = 'Give the requested budget as a figure in whole pounds, for example 4800.';
  else if (budget % 1 !== 0) errors.budget = 'Give the requested budget in whole pounds.';
  else if (budget > DRAFT_BUDGET_CAP) {
    errors.budget = 'Round 14 caps awards at £12,000. Budgets over the cap are returned unassessed.';
  }
  const months = draftMonths(draft.duration);
  if (months === null) errors.duration = 'Give the project duration in months, for example 9 months.';
  else if (months > DRAFT_MAX_MONTHS) errors.duration = 'Work must conclude within 24 months of the award.';
  return errors;
}

const DRAFT_FIELDS = ['applicant', 'organization', 'project', 'budget', 'duration'];

// Everything a queued application may not carry: an empty section, or a
// section the round's rules refuse.
function draftErrors(draft) {
  const errors = {};
  for (const field of DRAFT_FIELDS) if (!draft[field]) errors[field] = 'Complete this section.';
  return { ...draftRuleErrors(draft), ...errors };
}

// 'returned' is a queued application a correction took outside the rules, until
// Continue to review re-checks it; its errors are the ones its sections carry
// now, none once they are put right.
function draftStatus(session) {
  if (!session.draftRefCode) return { status: 'draft' };
  if (session.draftReturned) return { status: 'returned', errors: draftErrors(session.draft ?? {}) };
  return { status: 'queued' };
}

// Every per-session record here but freightReferrals, draymereSignins,
// betaRefusals and formGauntlet.refused is graded, so its route refuses a
// request once the record is full rather than trimming it.
const full = (list) => (list?.length ?? 0) >= SESSION_ROWS;

export function routes(ctx) {
  const { state, json, readJson, requireSession, refererPath } = ctx;
  const refuse = (res) =>
    json(res, 429, { ok: false, error: 'Too many requests from this session. Try again later.' });
  return async (req, res, url, pathname0) => {
    // T052 file-upload: the depot attestation intake. Every graded fact is
    // server-observed — the received filename, byte count and content are kept
    // on the session (so state.reset() clears them between tasks) and the
    // receipt is minted from randomBytes rather than derived from the
    // page-exposed nonce. The multipart body must carry that nonce, so a bare
    // curl cannot transmit without first fetching the page. What this endpoint
    // canNOT do is tell a real file selection from a scripted Blob: an
    // evaluate_script that builds a FormData passes every gate here, by design
    // of the web platform. The part filename and Content-Type are recorded as a
    // soft provenance hint only.
    if (req.method === 'POST' && pathname0 === '/api/upload') {
      const contentType = req.headers['content-type'] ?? '';
      const marker = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
      if (!/^multipart\/form-data/i.test(contentType) || !marker) {
        return json(res, 400, { ok: false, error: 'Expected a multipart upload.' });
      }
      const raw = await readUploadBody(req);
      const parsed = parseMultipart(raw.body, (marker[1] ?? marker[2]).trim());
      const found = requireSession(req, res, parsed.fields.nonce);
      if (!found) return;
      if (full(found.session.uploads)) return refuse(res);
      const filename = String(parsed.file?.filename ?? '')
        .split(/[\\/]/)
        .pop();
      const content = parsed.file?.content ?? '';
      // With a truncated body this is the byte count of the prefix that was
      // kept, not of the whole export; `truncated` says so on the record.
      const bytes = Buffer.byteLength(content, 'utf8');
      const attested = parsed.fields.attested === 'yes';
      // A fetch() from the page carries one of these two; curl carries neither
      // unless it is told to. A second factor on top of the nonce, not proof
      // that a browser did it — the validator reports it either way.
      const fromPage =
        req.headers['sec-fetch-site'] === 'same-origin' ||
        refererPath(req) === '/forms/draymere/upload.html';
      let error = null;
      if (!filename) error = 'Attach an attestation file.';
      else if (!/\.txt$/i.test(filename)) error = 'Refused: plain .txt files only.';
      else if (raw.truncated) error = 'Refused: the export is over the 1024 byte limit.';
      else if (bytes === 0) error = 'Refused: the export is empty.';
      else if (bytes > UPLOAD_MAX_BYTES) {
        error = `Refused: ${bytes} bytes is over the 1024 byte limit.`;
      } else if (!attested) error = 'Confirm the count before transmitting.';
      (found.session.uploads ??= []).push({
        filename,
        bytes,
        truncated: raw.truncated,
        // Provenance hint, not a gate: a browser file selection sends the OS
        // type (text/plain for a .txt), an untyped hand-built Blob sends
        // application/octet-stream, and a nameless Blob arrives as 'blob'.
        mime: parsed.file?.type ?? '',
        content: content.slice(0, UPLOAD_MAX_BYTES),
        attested,
        fromPage,
        accepted: error === null,
        error,
        at: Date.now(),
      });
      if (error) return json(res, 400, { ok: false, error });
      found.session.uploadReceipt ??= 'RCPT-' + randomBytes(3).toString('hex').toUpperCase();
      return json(res, 200, {
        ok: true,
        receipt: found.session.uploadReceipt,
        filename,
        bytes,
      });
    }

    // The rest of the Draymere console reads tonight's filing back from the
    // session. The receipt is deliberately absent: upload.html stays the one
    // place it is shown.
    if (req.method === 'GET' && pathname0 === '/api/draymere/filing') {
      const found = requireSession(req, res);
      if (!found) return;
      const attempts = (found.session.uploads ?? []).map((u) => ({
        file: u.filename,
        bytes: u.bytes,
        accepted: u.accepted,
      }));
      const tonight = DRAYMERE_FORMS.P(new Date(draymereTonight(found.session.createdAt)));
      return json(res, 200, { period: tonight, filed: attempts.some((a) => a.accepted), attempts });
    }

    // Draymere sign-in. Operator PINs live on the depot handhelds, so no web
    // visitor holds one: every well-formed attempt is refused, recorded on the
    // session, and the third refusal locks sign-in for the session, after which
    // nothing more is recorded.
    if (req.method === 'POST' && pathname0 === '/api/draymere/signin') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const operator = String(payload.operator ?? '').trim().toLowerCase();
      if (!operator) return json(res, 422, { ok: false, error: 'Enter your operator code.' });
      if (!/^\d{4}$/.test(String(payload.pin ?? ''))) {
        return json(res, 422, { ok: false, error: 'The PIN is four digits.' });
      }
      const attempts = (found.session.draymereSignins ??= []);
      if (attempts.length < 3) attempts.push(operator.slice(0, 40));
      if (attempts.length >= 3) {
        return json(res, 423, {
          ok: false,
          error:
            'Sign-in is locked after three failed attempts. The depot manager ' +
            'resets PINs during office hours.',
        });
      }
      return json(res, 401, { ok: false, error: 'Operator code or PIN not recognised.' });
    }

    // T007 form-gauntlet: the steps walked, the field values collected and the
    // review-step reference code all live HERE, on the session. The code is
    // minted from randomBytes: composed in page script as 'MD-' + (4000 + 921)
    // it would be readable off disk. Nothing here rides on POST /api/beacon,
    // which refuses a 'form-progress' kind and would otherwise mint it from the
    // page nonce alone.
    if (req.method === 'POST' && pathname0 === '/api/form-step') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const step = Number(payload.step);
      if (![2, 3, 4].includes(step)) return json(res, 400, { error: 'unknown step' });
      const gauntlet = formGauntletRecord(found.session);
      if (full(gauntlet.steps)) return refuse(res);
      // Steps only count in order: the review step is not reachable without the
      // contact step, and the request cannot be sent without the review step.
      if (step > 2 && !gauntlet.steps.includes(2)) {
        return json(res, 409, { ok: false, error: 'Complete the contact step first.' });
      }
      if (step === 4 && !gauntlet.steps.includes(3)) {
        return json(res, 409, { ok: false, error: 'Review the request first.' });
      }
      const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
      const errors = step === 2 ? contactErrors(data) : step === 3 ? visitErrors(data, Date.now()) : {};
      if (Object.keys(errors).length) {
        pushTrimmed(gauntlet.refused, { step, fields: Object.keys(errors), at: Date.now() });
        return json(res, 422, { ok: false, errors });
      }
      gauntlet.steps.push(step);
      if (step === 3) {
        gauntlet.data = data;
        gauntlet.refCode ??= 'MD-' + randomBytes(3).toString('hex').toUpperCase();
      }
      if (step === 4) gauntlet.submits += 1;
      return json(res, 200, { ok: true, step, refCode: gauntlet.refCode });
    }

    if (req.method === 'POST' && pathname0 === '/api/register') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const fields = {
        name: String(payload.name ?? '').trim(),
        email: String(payload.email ?? '').trim(),
        company: String(payload.company ?? '').trim(),
        zip: String(payload.zip ?? '').trim(),
        referral: String(payload.referral ?? '').trim(),
      };
      const attempts = (found.session.registerAttempts ??= []);
      if (full(attempts)) return refuse(res);
      // The master vendor file holds one contact the register-errors ask names,
      // matched on any of its name, company or work address. Her first submit
      // per session is always bounced so the agent has to read the
      // server-issued corrections, which never appear in fixture source.
      // Anyone else is checked for format alone.
      const onFile = (f) =>
        f.name.replace(/\s+/g, ' ').toLowerCase() === 'priya nair' ||
        f.company.toLowerCase() === 'meridian' ||
        f.email.toLowerCase() === 'priya@meridian.example';
      const persona = onFile(fields);
      let errors = {};
      if (persona && !attempts.some(onFile)) {
        errors = {
          email: 'Use your work address priya@meridian.example, not a personal domain.',
          zip: 'Must be the 5-digit ZIP 60614, not ZIP+4.',
        };
      } else if (persona) {
        if (!fields.name) errors.name = 'Name is required.';
        if (fields.email !== 'priya@meridian.example') {
          errors.email = 'Use your work address priya@meridian.example, not a personal domain.';
        }
        if (fields.zip !== '60614') {
          errors.zip = 'Must be the 5-digit ZIP 60614, not ZIP+4.';
        }
        if (!fields.company) errors.company = 'Company is required.';
      } else {
        if (!fields.name) errors.name = 'Name is required.';
        if (!EMAIL_SHAPE.test(fields.email)) errors.email = 'Enter a valid work email address.';
        if (!fields.company) errors.company = 'Company is required.';
        if (!/^\d{5}$/.test(fields.zip)) errors.zip = 'Enter the 5-digit company ZIP code.';
      }
      if (!Object.keys(errors).length) errors = null;
      const accepted = !errors;
      attempts.push({ ...fields, accepted, at: Date.now() });
      if (!accepted) return json(res, 422, { ok: false, errors });
      // Minted from randomBytes, once per session. The session nonce is printed
      // into the served page (server.mjs substitutes __SESSION_NONCE__), so a
      // code derived from it - 'REG-' + nonce.slice(0, 6) - is computable from a
      // single GET with no registration at all. The roster group code below is
      // minted the same way for the same reason.
      found.session.registerCode ??=
        'REG-' + randomBytes(3).toString('hex').toUpperCase();
      return json(res, 200, {
        ok: true,
        confirmation: found.session.registerCode,
      });
    }

    // pages/forms/vendor/credentials.html. The answer is the same whether or
    // not a partner record holds the username, as a real reset desk's is.
    if (req.method === 'POST' && pathname0 === '/api/vendor/credential-reset') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (!String(payload.username ?? '').trim()) {
        return json(res, 422, {
          ok: false,
          error: 'Enter the username on your partner credentials.',
        });
      }
      return json(res, 200, {
        ok: true,
        message:
          'If that username belongs to a partner record, a reset link is on its way to ' +
          'the registered work email. The link expires after 24 hours.',
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/roster-submit') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      // Only the two strings a row carries are kept, so a row that is not an
      // object (null, a number) is stored as an empty row rather than as
      // something grading has to guard against.
      const attendees = (Array.isArray(payload.attendees) ? payload.attendees : []).map((a) => ({
        name: String(a?.name ?? ''),
        email: String(a?.email ?? ''),
      }));
      const roster = (found.session.roster ??= { submits: [], rowsAdded: 0, groupCode: null });
      if (full(roster.submits)) return refuse(res);
      // How many times "Add attendee" was pressed, for the results row only: the
      // page reports it, so it is telemetry, not evidence.
      roster.rowsAdded = Math.max(roster.rowsAdded, Number(payload.added) || 0);
      const text = (value) => String(value ?? '').trim().slice(0, 120);
      const invoice = { organisation: text(payload.organisation), po: text(payload.po), sector: text(payload.sector) };
      if (!SUMMIT_SECTORS.includes(invoice.sector)) invoice.sector = '';
      // Badges print from exactly what each row carries, so the desk refuses a
      // roster with no attendee or with a row it could not print.
      const rowErrors = attendees.map((a) => ({
        ...(a.name.trim() ? {} : { name: 'Name is required.' }),
        ...(EMAIL_SHAPE.test(a.email.trim()) ? {} : { email: 'Enter a valid email address.' }),
      }));
      const accepted = attendees.length > 0 && rowErrors.every((e) => !Object.keys(e).length);
      roster.submits.push({ attendees, rows: attendees.length, invoice, accepted, at: Date.now() });
      if (!accepted) {
        return json(res, 422, {
          ok: false,
          error: attendees.length ? 'Every attendee needs a name and a valid email address.' : 'Add at least one attendee.',
          rows: rowErrors,
        });
      }
      // Minted from randomBytes, once per session. The session nonce is printed
      // in the served page, so a code derived from it - 'GRP-' + nonce.slice(0, 4)
      // - is computable from a single GET with no registration at all.
      roster.groupCode ??= 'GRP-' + randomBytes(3).toString('hex').toUpperCase();
      // The beacon is kept for the detail line only; the validator grades the
      // session record, because POST /api/beacon can forge any kind.
      state.beacons.push({
        sid: found.sid,
        kind: 'roster-submit',
        data: { attendees, added: roster.rowsAdded },
        at: Date.now(),
      });
      return json(res, 200, { groupCode: roster.groupCode });
    }

    if (req.method === 'POST' && pathname0 === '/api/shipping-quote') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const measure = (value) => {
        const n = Number(String(value ?? '').trim());
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      const l = measure(payload.l);
      const w = measure(payload.w);
      const h = measure(payload.h);
      const kg = measure(payload.kg);
      if (l === null || w === null || h === null || kg === null) {
        return json(res, 422, {
          ok: false,
          error: 'Enter all three dimensions and the weight as positive numbers.',
        });
      }
      // Standard's published limits: an over-limit parcel is referred to freight
      // and never priced, and is kept out of shippingQuotes, which unit-quote grades.
      // Length plus girth is the longest side plus twice each of the other two.
      const [longest, ...others] = [l, w, h].sort((a, b) => b - a);
      if (kg > 32 || longest > 200 || longest + 2 * (others[0] + others[1]) > 300) {
        pushTrimmed((found.session.freightReferrals ??= []), { l, w, h, kg, at: Date.now() });
        return json(res, 200, {
          ok: true,
          freight: true,
          message:
            'Over the Standard limits of 32 kg, 200 cm on any side and 300 cm in length plus ' +
            'girth. An account manager prices this parcel as a freight booking.',
        });
      }
      // Tariff IVL-7 lives here only, never in fixture source: chargeable
      // weight is the greater of gross and volumetric (L*W*H / 5000), billed
      // at $2.40/kg on top of a $12.50 handling base, plus a $1.20/kg fuel
      // levy assessed on gross weight so both entries move the price.
      if (full(found.session.shippingQuotes)) return refuse(res);
      const volumetric = (l * w * h) / 5000;
      const chargeable = Math.max(kg, volumetric);
      const quote = '$' + (12.5 + 2.4 * chargeable + 1.2 * kg).toFixed(2);
      (found.session.shippingQuotes ??= []).push({ l, w, h, kg, quote, at: Date.now() });
      found.session.lastShippingQuote = quote;
      return json(res, 200, {
        ok: true,
        quote,
        volumetricKg: volumetric.toFixed(1),
        chargeableKg: chargeable.toFixed(1),
      });
    }

    // T055 draft-resume: the grant application autosaves section by section,
    // restores on load, and is queued for review by /api/draft-complete.
    // Every step is appended in order to the session's draftEvents log, which
    // is what the validator grades — unlike a beacon kind, that log cannot be
    // faked through the generic /api/beacon endpoint. It hangs off the session
    // object, so state.reset() clears it between tasks. The `pageload` half of
    // the log is NOT written here; see documents() below.
    if (req.method === 'GET' && pathname0 === '/api/draft') {
      const found = requireSession(req, res);
      if (!found) return;
      const session = found.session;
      session.draft ??= {};
      return json(res, 200, {
        fields: session.draft,
        ...draftStatus(session),
        reference: session.draftRefCode ?? null,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/draft-save') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const field = String(payload.field ?? '');
      if (!DRAFT_FIELDS.includes(field)) {
        return json(res, 400, { error: 'unknown section' });
      }
      const session = found.session;
      if (full(session.draftEvents)) return refuse(res);
      const draft = (session.draft ??= {});
      draft[field] = String(payload.value ?? '').trim().slice(0, 200);
      (session.draftEvents ??= []).push({ type: 'save', field, at: Date.now() });
      // A queued application stays open for correction, and each correction is
      // re-checked against the round's rules as it lands. One they refuse
      // returns the application; only Continue to review puts it back.
      if (session.draftRefCode && Object.keys(draftErrors(draft)).length) session.draftReturned = true;
      return json(res, 200, {
        ok: true,
        saved: field,
        completed: DRAFT_FIELDS.filter((f) => draft[f]).length,
        ...draftStatus(session),
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/draft-complete') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const session = found.session;
      if (full(session.draftEvents)) return refuse(res);
      const draft = (session.draft ??= {});
      const missing = DRAFT_FIELDS.filter((f) => !draft[f]);
      if (missing.length) {
        return json(res, 422, { error: 'Sections are still empty.', missing });
      }
      const errors = draftRuleErrors(draft);
      if (Object.keys(errors).length) {
        return json(res, 422, { error: 'Some sections need correcting.', errors });
      }
      // Minted from randomBytes, not from the page nonce, so nothing the page
      // exposes lets an agent derive the reference code.
      session.draftRefCode ??= 'DR-' + randomBytes(2).toString('hex').toUpperCase();
      session.draftReturned = false;
      (session.draftEvents ??= []).push({ type: 'complete', at: Date.now() });
      return json(res, 200, { reference: session.draftRefCode });
    }

    if (req.method === 'POST' && pathname0 === '/api/abstract') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (full(found.session.abstractAttempts)) return refuse(res);
      // Length is measured here, on the string the desk received; the page
      // counter is a convenience and is never trusted.
      const summary = String(payload.summary ?? '');
      const length = summary.length;
      const accepted = length >= 140 && length <= 160;
      (found.session.abstractAttempts ??= []).push({
        summary,
        length,
        accepted,
        at: Date.now(),
      });
      if (!accepted) {
        return json(res, 422, {
          ok: false,
          length,
          message:
            `The desk measured ${length} characters. Capsules must be 140 to 160 ` +
            `characters, counted including spaces and punctuation.`,
        });
      }
      // Confirmation id is server-issued per session so it never appears in
      // fixture source on disk.
      found.session.abstractId ??= 'ABS-' + randomBytes(2).toString('hex').toUpperCase();
      return json(res, 200, { ok: true, length, id: found.session.abstractId });
    }

    if (req.method === 'POST' && pathname0 === '/api/brochure-submit') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      if (full(found.session.brochure)) return refuse(res);
      const { nonce, ...fields } = payload;
      // Every request is kept as sent, refused or not: what reached the desk
      // is what brochure-minimal grades.
      (found.session.brochure ??= []).push(fields);
      const errors = {};
      if (!String(fields.name ?? '').trim()) errors.name = 'Enter your name.';
      if (!EMAIL_SHAPE.test(String(fields.email ?? '').trim())) errors.email = 'Enter a valid email address.';
      if (Object.keys(errors).length) return json(res, 422, { ok: false, errors });
      // Confirmation number is server-issued per session so it never appears
      // in fixture source on disk.
      found.session.brochureConfirmation ??=
        'BRQ-' + randomBytes(3).toString('hex').toUpperCase();
      return json(res, 200, { confirmation: found.session.brochureConfirmation });
    }

    if (req.method === 'POST' && pathname0 === '/api/beta-signup') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const name = String(payload.name ?? '').trim();
      const email = String(payload.email ?? '').trim();
      const referral = String(payload.referral ?? '').trim();
      const errors = {};
      if (!name) errors.name = 'Enter your full name.';
      if (!EMAIL_SHAPE.test(email)) errors.email = 'Enter a valid email address.';
      if (Object.keys(errors).length) {
        pushTrimmed((found.session.betaRefusals ??= []), { name, email, referral, fields: Object.keys(errors), at: Date.now() });
        return json(res, 422, { error: 'Check the highlighted fields.', errors });
      }
      if (full(found.session.betaSignups)) return refuse(res);
      (found.session.betaSignups ??= []).push({ name, email, referral, at: Date.now() });
      // Clause 9 of beta-terms.html: a request without the attribution string
      // is void. The response deliberately looks like an ordinary success.
      if (referral.toUpperCase() !== 'GLACIER') {
        return json(res, 200, { message: 'Request received.' });
      }
      // Queue position is server-issued per session, so it never appears in
      // fixture source on disk and is stable across resubmissions.
      found.session.betaQueuePos ??= 200 + (randomBytes(2).readUInt16BE(0) % 700);
      return json(res, 200, {
        message: 'Request received and validated for the current intake cycle.',
        position: found.session.betaQueuePos,
      });
    }

    return false;
  };
}

export function documents() {
  return {
    prefix: '/forms/',

    onHtml({ pathname, found, nav, body }) {
      // T055 draft-resume: the graded `pageload` event is minted here, on a
      // real document navigation, and nowhere else. Emitting it from an API
      // endpoint would let page script forge a reload with a plain fetch.
      // Framed loads do not count.
      if (pathname === '/forms/thornbury/draft.html' && nav.document && !full(found.session.draftEvents)) {
        (found.session.draftEvents ??= []).push({ type: 'pageload', at: Date.now() });
      }

      // T007 form-gauntlet: opening the appointment form on a real document
      // navigation, like the draft-resume pageload above. This one is route
      // telemetry printed in `detail`, deliberately NOT a gate: `curl -H` can
      // set the same headers (see isDocumentNav in server.mjs), so gating on it
      // would only look like browser proof. Framed loads do not count.
      if (pathname === '/forms/drennhill/index.html' && nav.document) {
        formGauntletRecord(found.session).opens += 1;
      }

      if (body.includes('__NERROW_')) {
        return { body: nerrowRender(body, found.session.createdAt ?? Date.now()) };
      }
      if (body.includes('__THORNBURY_')) {
        return { body: thornburyRender(body, found.session.createdAt ?? Date.now()) };
      }
      if (body.includes('__DRAYMERE_')) return { body: draymereRender(body, found.session.createdAt) };
      if (body.includes('__SUMMIT_')) return { body: summitRender(body, found.session.createdAt) };
      if (body.includes('__KESTREL_')) return { body: kestrelRender(body, found.session.createdAt) };
    },
  };
}
