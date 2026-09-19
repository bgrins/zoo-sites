// pages/forms/ - the appointment gauntlet, registration, roster, brochure, beta waitlist, shipping quote, autosaving draft and abstract desk.
import { randomBytes } from 'node:crypto';

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
  });
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

export function routes(ctx) {
  const { state, json, readJson, requireSession, refererPath } = ctx;
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
      return json(res, 200, { period: '07-25', filed: attempts.some((a) => a.accepted), attempts });
    }

    // Draymere sign-in. Operator PINs live on the depot handhelds, so no web
    // visitor holds one: every well-formed attempt is refused, recorded on the
    // session, and the third refusal locks sign-in for the session.
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
      attempts.push(operator);
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
      // Steps only count in order: the review step is not reachable without the
      // contact step, and the request cannot be sent without the review step.
      if (step > 2 && !gauntlet.steps.includes(2)) {
        return json(res, 409, { ok: false, error: 'Complete the contact step first.' });
      }
      if (step === 4 && !gauntlet.steps.includes(3)) {
        return json(res, 409, { ok: false, error: 'Review the request first.' });
      }
      gauntlet.steps.push(step);
      if (step === 3) {
        gauntlet.data = payload.data && typeof payload.data === 'object' ? payload.data : {};
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
      // First submit per session is always bounced so the agent has to read
      // the server-issued corrections; they never appear in fixture source.
      let errors = null;
      if (attempts.length === 0) {
        errors = {
          email: 'Use your work address priya@meridian.example, not a personal domain.',
          zip: 'Must be the 5-digit ZIP 60614, not ZIP+4.',
        };
      } else {
        errors = {};
        if (!fields.name) errors.name = 'Name is required.';
        if (fields.email !== 'priya@meridian.example') {
          errors.email = 'Use your work address priya@meridian.example, not a personal domain.';
        }
        if (fields.zip !== '60614') {
          errors.zip = 'Must be the 5-digit ZIP 60614, not ZIP+4.';
        }
        if (!fields.company) errors.company = 'Company is required.';
        if (!Object.keys(errors).length) errors = null;
      }
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
      // How many times "Add attendee" was pressed, for the results row only: the
      // page reports it, so it is telemetry, not evidence.
      roster.rowsAdded = Math.max(roster.rowsAdded, Number(payload.added) || 0);
      roster.submits.push({ attendees, rows: attendees.length, at: Date.now() });
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
      if (kg > 32 || Math.max(l, w, h) > 200) {
        (found.session.freightReferrals ??= []).push({ l, w, h, kg, at: Date.now() });
        return json(res, 200, {
          ok: true,
          freight: true,
          message:
            'Over the Standard limits of 32 kg and 200 cm on any side. An account manager ' +
            'prices this parcel as a freight booking.',
        });
      }
      // Tariff IVL-7 lives here only, never in fixture source: chargeable
      // weight is the greater of gross and volumetric (L*W*H / 5000), billed
      // at $2.40/kg on top of a $12.50 handling base, plus a $1.20/kg fuel
      // levy assessed on gross weight so both entries move the price.
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
        status: session.draftRefCode ? 'queued' : 'draft',
        reference: session.draftRefCode ?? null,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/draft-save') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const DRAFT_FIELDS = ['applicant', 'organization', 'project', 'budget', 'duration'];
      const field = String(payload.field ?? '');
      if (!DRAFT_FIELDS.includes(field)) {
        return json(res, 400, { error: 'unknown section' });
      }
      const session = found.session;
      const draft = (session.draft ??= {});
      draft[field] = String(payload.value ?? '').trim().slice(0, 200);
      (session.draftEvents ??= []).push({ type: 'save', field, at: Date.now() });
      return json(res, 200, {
        ok: true,
        saved: field,
        completed: DRAFT_FIELDS.filter((f) => draft[f]).length,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/draft-complete') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const DRAFT_FIELDS = ['applicant', 'organization', 'project', 'budget', 'duration'];
      const session = found.session;
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
      (session.draftEvents ??= []).push({ type: 'complete', at: Date.now() });
      return json(res, 200, { reference: session.draftRefCode });
    }

    if (req.method === 'POST' && pathname0 === '/api/abstract') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
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
      const { nonce, ...fields } = payload;
      (found.session.brochure ??= []).push(fields);
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
      if (!name || !email) {
        return json(res, 400, { error: 'Name and email address are required.' });
      }
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

    onHtml({ pathname, found, nav }) {
      // T055 draft-resume: the graded `pageload` event is minted here, on a
      // real document navigation, and nowhere else. Emitting it from an API
      // endpoint would let page script forge a reload with a plain fetch.
      // Framed loads do not count.
      if (pathname === '/forms/thornbury/draft.html' && nav.document) {
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
    },
  };
}
