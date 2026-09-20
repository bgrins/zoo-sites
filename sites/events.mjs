// pages/events/ - Ivrelby Borough Council events office (native-permit).
//
// The organiser's pack is minted per session and served only by
// /api/events/brief: which 4 of the 14 streets close, the closure window on a
// 15-minute grid, when amplified sound stops, and the one item of equipment,
// described in words, plus an ungraded contact the form also asks for. The
// application form is a real <form method=post> navigation back to its own
// address, /events/apply.html, parsed here ahead of the static file (which
// answers GET only) and echoed back on a check page rendered from what the
// server parsed; /events/submit turns a draft into a permit whose PT- number
// comes from randomBytes. Nothing graded is in fixture source.
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS, lcg } from './lib.mjs';

export const EVENTS_STREETS = [
  { id: 'abrill-street', name: 'Abrill Street' },
  { id: 'dremmock-lane', name: 'Dremmock Lane' },
  { id: 'fettick-place', name: 'Fettick Place' },
  { id: 'gilvane-row', name: 'Gilvane Row' },
  { id: 'holbrisk-road', name: 'Holbrisk Road' },
  { id: 'lumsick-walk', name: 'Lumsick Walk' },
  { id: 'nadderly-road', name: 'Nadderly Road' },
  { id: 'ombery-terrace', name: 'Ombery Terrace' },
  { id: 'pessick-street', name: 'Pessick Street' },
  { id: 'quistel-lane', name: 'Quistel Lane' },
  { id: 'selbray-court', name: 'Selbray Court' },
  { id: 'umbrell-yard', name: 'Umbrell Yard' },
  { id: 'wrothen-road', name: 'Wrothen Road' },
  { id: 'yarrant-street', name: 'Yarrant Street' },
];

// The equipment list the guidance page and the form's datalist publish. The
// server takes a code only in exactly this form.
export const EVENTS_EQUIPMENT = [
  ['GEN-13P', 'Generator, 1-3 kVA, petrol'],
  ['GEN-13D', 'Generator, 1-3 kVA, diesel'],
  ['GEN-35P', 'Generator, 3-5 kVA, petrol'],
  ['GEN-35D', 'Generator, 3-5 kVA, diesel'],
  ['GEN-58P', 'Generator, 5-8 kVA, petrol'],
  ['GEN-58D', 'Generator, 5-8 kVA, diesel'],
  ['GEN-35S', 'Silenced generator, 3-5 kVA'],
  ['PA-05', 'PA system, up to 500 W'],
  ['PA-10', 'PA system, 500 W to 1 kW'],
  ['PA-20', 'PA system, 1 kW to 2 kW'],
  ['PA-DJ', 'DJ console with speakers'],
  ['GZ-33', 'Gazebo, 3 m by 3 m'],
  ['GZ-36', 'Gazebo, 3 m by 6 m'],
  ['GZ-66', 'Gazebo, 6 m by 6 m'],
  ['MQ-612', 'Marquee, 6 m by 12 m'],
  ['STG-32', 'Stage, 3 m by 2 m'],
  ['STG-43', 'Stage, 4 m by 3 m'],
  ['STG-64', 'Stage, 6 m by 4 m'],
  ['INF-S', 'Inflatable, under 4 m'],
  ['INF-M', 'Inflatable, 4 m to 6 m'],
  ['INF-L', 'Inflatable, over 6 m'],
  ['LT-TOW', 'Lighting tower, towable'],
  ['LT-SOL', 'Lighting tower, solar'],
  ['LT-FES', 'Festoon lighting run'],
  ['CAT-LPG', 'Catering unit, LPG'],
  ['CAT-ELE', 'Catering unit, electric'],
  ['BBQ-CH', 'Barbecue, charcoal'],
  ['BAR-PED', 'Pedestrian barriers'],
  ['BAR-VEH', 'Vehicle mitigation barrier'],
  ['WC-UNI', 'Portable toilet block'],
].map(([code, what]) => ({ code, what }));

// The items a pack can name, each with a near-miss neighbour in the list that
// differs by one attribute (fuel, rating or size).
const EVENTS_EQUIPMENT_PHRASES = {
  'GEN-35D': 'one 3-5 kVA diesel generator',
  'GEN-35P': 'one 3-5 kVA petrol generator',
  'GEN-58D': 'one 5-8 kVA diesel generator',
  'GEN-13D': 'one 1-3 kVA diesel generator',
  'PA-10': 'a 500 W to 1 kW PA system',
  'STG-43': 'a 4 m by 3 m stage',
  'GZ-36': 'a 3 m by 6 m gazebo',
};

// Every closure falls on this Saturday; the day is above 12, so a numeric
// date reads one way only in either field order. It sits far enough ahead
// that the guidance's eight weeks' notice holds for the corpus's life.
export const EVENTS_DATE = '2027-07-17';

const EVENT_NAMES = ['Lantern Fair', 'Street Party', 'Apple Day', 'Play Street'];

const CONTACTS = [
  ['Orla Pellisker', 'orla.pellisker@example.com'],
  ['Priya Haskerry', 'priya.haskerry@example.com'],
  ['Tom Wendlaire', 'tom.wendlaire@example.com'],
  ['Gwen Tolvarrow', 'gwen.tolvarrow@example.com'],
];

const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// Difficulty draws only: the permit number is the identifier mint.
function mintBrief(draw, pick) {
  const rand = lcg(draw('events.brief', 4));
  const ids = EVENTS_STREETS.map((s) => s.id);
  const streets = [];
  while (streets.length < 4) {
    const id = ids[Math.floor(rand() * ids.length)];
    if (!streets.includes(id)) streets.push(id);
  }
  const start = 6 * 60 + 15 * Math.floor(rand() * 16);
  const end = 19 * 60 + 30 + 15 * Math.floor(rand() * 14);
  const quiet = 19 * 60 + 15 * Math.floor(rand() * ((end - 30 - 19 * 60) / 15 + 1));
  const code = pick('events.equipment', Object.keys(EVENTS_EQUIPMENT_PHRASES));
  return {
    event: `${EVENTS_STREETS.find((s) => s.id === streets[0]).name} ${EVENT_NAMES[Math.floor(rand() * EVENT_NAMES.length)]}`,
    packRef: 'PK-' + randomBytes(2).toString('hex').toUpperCase(),
    streets,
    start: `${EVENTS_DATE}T${hhmm(start)}`,
    end: `${EVENTS_DATE}T${hhmm(end)}`,
    quiet: hhmm(quiet),
    equipment: code,
    contact: CONTACTS[Math.floor(rand() * CONTACTS.length)],
  };
}

function deskState(session) {
  session.permitDesk ??= {
    brief: null,
    briefFetches: 0,
    // Every POST to /events/apply, valid or not, with the raw values it parsed.
    attempts: [],
    // The valid attempts, each echoed on a check page.
    drafts: [],
    permits: [],
    // Submits of a draft that already has a permit; they mint nothing.
    resubmits: 0,
  };
  return session.permitDesk;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// A datetime-local value as the form submits it, normalised to
// YYYY-MM-DDTHH:MM, or null. The year may run past four digits, because the
// control accepts up to 275760.
export function parseLocal(value) {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00(?:\.0+)?)?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || d < 1) return null;
  const date = new Date(Date.UTC(2000, mo - 1, d));
  date.setUTCFullYear(y);
  if (date.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

function parseClock(value) {
  const m = /^(\d{2}):(\d{2})(?::00)?$/.exec(String(value ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1]}:${m[2]}`;
}

const sortable = (local) => local.replace(/^(\d+)/, (y) => y.padStart(6, '0'));

function when(local) {
  const [y, mo, d] = local.slice(0, local.indexOf('T')).split('-').map(Number);
  const date = new Date(Date.UTC(2000, mo - 1, d));
  date.setUTCFullYear(y);
  return `${DAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]} ${y}, ${local.slice(-5)}`;
}

function longDate(isoDate) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return `${LONG_DAYS[date.getUTCDay()]} ${d} ${LONG_MONTHS[mo - 1]} ${y}`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const streetName = (id) => EVENTS_STREETS.find((s) => s.id === id)?.name ?? id;
const equipmentLine = (code) => {
  const item = EVENTS_EQUIPMENT.find((e) => e.code === code);
  return item ? `${item.code}, ${item.what}` : code;
};

// Parses one urlencoded application body into the values the office stores,
// and the errors a person would be shown.
function parseApplication(form) {
  const raw = {
    street: form.getAll('street'),
    start: form.get('start') ?? '',
    end: form.get('end') ?? '',
    quiet: form.get('quiet') ?? '',
    equipment: form.get('equipment') ?? '',
    eventName: form.get('event-name') ?? '',
    contactName: form.get('contact-name') ?? '',
    contactEmail: form.get('contact-email') ?? '',
  };
  const errors = [];
  const known = new Set(EVENTS_STREETS.map((s) => s.id));
  const streets = [...new Set(raw.street)].filter((id) => known.has(id));
  if (!streets.length || streets.length !== new Set(raw.street).size) {
    errors.push({ field: 'streets', message: 'Select the streets you want to close' });
  }
  const eventName = raw.eventName.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!eventName) errors.push({ field: 'event-name', message: 'Enter the name of your event' });
  const contactName = raw.contactName.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!contactName) errors.push({ field: 'contact-name', message: 'Enter the name of the person we should contact' });
  const contactEmail = raw.contactEmail.trim().slice(0, 254);
  if (!contactEmail) errors.push({ field: 'contact-email', message: 'Enter an email address for the contact' });
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    errors.push({ field: 'contact-email', message: 'Enter an email address in the correct format, like name@example.com' });
  }
  const start = parseLocal(raw.start);
  const end = parseLocal(raw.end);
  if (!raw.start.trim()) errors.push({ field: 'start', message: 'Enter the date and time the closure starts' });
  else if (!start) errors.push({ field: 'start', message: 'Enter a real date and time for the start of the closure' });
  if (!raw.end.trim()) errors.push({ field: 'end', message: 'Enter the date and time the closure ends' });
  else if (!end) errors.push({ field: 'end', message: 'Enter a real date and time for the end of the closure' });
  if (start && end && sortable(end) <= sortable(start)) {
    errors.push({ field: 'end', message: 'The closure must end after it starts' });
  }
  const quiet = parseClock(raw.quiet);
  if (!raw.quiet.trim()) errors.push({ field: 'quiet', message: 'Enter the time amplified sound will stop' });
  else if (!quiet) errors.push({ field: 'quiet', message: 'Enter a real time, for example 21:15' });
  else if (Number(quiet.slice(3)) % 15) errors.push({ field: 'quiet', message: 'Enter a time on the quarter hour, for example 21:15' });
  const equipment = raw.equipment.trim();
  if (!equipment) {
    errors.push({ field: 'equipment', message: 'Enter the code for your main item of equipment' });
  } else if (!EVENTS_EQUIPMENT.some((e) => e.code === equipment)) {
    errors.push({ field: 'equipment', message: 'Enter an equipment code exactly as it appears in the equipment list, for example GEN-13P' });
  }
  return {
    raw,
    errors,
    values: {
      streets, eventName, contactName, contactEmail, start, end, quiet,
      equipment: errors.some((e) => e.field === 'equipment') ? null : equipment,
    },
  };
}

// The office's own chrome, shared with the static pages under pages/events/.
// Relative links resolve against the site root in both serving modes, because
// every rendered path sits directly under it.
function chrome(title, main) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<title>${esc(title)} - Ivrelby Events Office</title>
<link rel="stylesheet" href="ivrelby.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="mast">
  <div class="mast-in">
    <a class="brand" href="index.html"><span class="glyph" aria-hidden="true"></span><span class="brand-name">Ivrelby Borough Council</span></a>
    <p class="brand-sub">Events Office</p>
  </div>
</header>
<nav class="tabs" aria-label="Events office">
  <div class="tabs-in">
    <a href="index.html">Events home</a>
    <a href="street-closures.html" class="on">Street closures</a>
    <a href="contact.html">Contact us</a>
  </div>
</nav>
<main id="content" class="page">
${main}
</main>
<footer class="foot">
  <div class="foot-in">
    <p>Ivrelby Borough Council Events Office, Town Hall, Civic Square, Ivrelby QV6 2JE</p>
    <p>Telephone 0151 496 0873, Monday to Friday 9:00 to 16:30</p>
    <p><a href="contact.html">Contact the events office</a> <a href="privacy.html">Privacy notice</a> <a href="terms.html">Terms of use</a></p>
    <p>Copyright Ivrelby Borough Council 2026</p>
  </div>
</footer>
</body>
</html>
`;
}

function problemPage(parsed) {
  return chrome(
    'There is a problem',
    `<div class="grid">
  <aside class="side"><p class="stage">Step 2 of 3</p><p class="stage-name">Closure details</p></aside>
  <section class="body">
    <h1>There is a problem with your application</h1>
    <div class="problem" role="alert">
      <h2>Correct these answers before you continue</h2>
      <ul>${parsed.errors.map((e) => `<li><a href="apply.html?change=1#${esc(e.field)}">${esc(e.message)}</a></li>`).join('')}</ul>
    </div>
    <p><a class="btn" href="apply.html?change=1">Go back to the application</a></p>
  </section>
</div>`
  );
}

// One row of a summary list; `value` is already escaped HTML.
function row(key, value, { anchor = null, id = null } = {}) {
  const change = anchor
    ? `<dd class="cya-change"><a href="apply.html?change=1#${anchor}">Change<span class="vh"> ${esc(key.toLowerCase())}</span></a></dd>`
    : '';
  return `<div class="cya-row"><dt class="cya-key">${esc(key)}</dt><dd class="cya-value"${id ? ` id="${id}"` : ''}>${value}</dd>${change}</div>`;
}

const streetList = (ids) => `<ul class="cya-list">${ids.map((id) => `<li>${esc(streetName(id))}</li>`).join('')}</ul>`;

function checkPage(session, draft) {
  return chrome(
    'Check your answers',
    `<div class="grid">
  <aside class="side"><p class="stage">Step 3 of 3</p><p class="stage-name">Check and submit</p></aside>
  <section class="body">
    <h1>Check your answers before you submit</h1>
    <p class="lede">This is what we will record on the closure order. If anything is wrong, change it now: once you submit, the order goes to the highways team and can only be changed by a new application.</p>
    <dl class="cya">
      ${row('Event name', esc(draft.eventName), { anchor: 'event-name' })}
      ${row('Contact name', esc(draft.contactName), { anchor: 'contact-name' })}
      ${row('Contact email', esc(draft.contactEmail), { anchor: 'contact-email' })}
      ${row('Streets to close', streetList(draft.streets), { anchor: 'streets' })}
      ${row('Closure starts', esc(draft.echo.start), { anchor: 'start' })}
      ${row('Closure ends', esc(draft.echo.end), { anchor: 'end' })}
      ${row('Amplified sound stops', esc(draft.quiet), { anchor: 'quiet' })}
      ${row('Equipment', esc(equipmentLine(draft.equipment)), { anchor: 'equipment' })}
    </dl>
    <form method="post" action="submit" class="submit-form">
      <input type="hidden" name="nonce" value="${esc(session.nonce)}">
      <input type="hidden" name="draft" value="${esc(draft.id)}">
      <h2>Now send your application</h2>
      <p>By submitting you confirm that the residents and businesses on these streets have been told about the closure.</p>
      <button type="submit" class="btn">Submit application</button>
    </form>
  </section>
</div>`
  );
}

function confirmationPage(permit) {
  return chrome(
    'Application submitted',
    `<div class="grid">
  <aside class="side"><p class="stage">Done</p><p class="stage-name">Application submitted</p></aside>
  <section class="body">
    <div class="done">
      <h1>Application submitted</h1>
      <p class="done-label">Your permit number</p>
      <p class="done-ref" id="permit-number">${esc(permit.number)}</p>
    </div>
    <h2>What we recorded</h2>
    <dl class="cya cya-plain">
      ${row('Event name', esc(permit.eventName))}
      ${row('Contact', `${esc(permit.contactName)}, ${esc(permit.contactEmail)}`)}
      ${row('Streets closed', streetList(permit.streets))}
      ${row('Closure starts', esc(when(permit.start)), { id: 'recorded-start' })}
      ${row('Closure ends', esc(when(permit.end)), { id: 'recorded-end' })}
      ${row('Amplified sound stops', esc(permit.quiet))}
      ${row('Equipment', esc(equipmentLine(permit.equipment)))}
    </dl>
    <h2>What happens next</h2>
    <p>The highways team checks the route with the bus operators and the emergency services. We email the signed closure order and the notice for lamp posts at least 21 days before the event. Quote your permit number if you contact us.</p>
    <p><a href="index.html">Back to the events office</a></p>
  </section>
</div>`
  );
}

function plainPage(title, text) {
  return chrome(title, `<div class="grid"><aside class="side"></aside><section class="body"><h1>${esc(title)}</h1><p>${text}</p><p><a class="btn" href="start.html">Start again</a></p></section></div>`);
}

export function routes(ctx) {
  const { json, requireSession, draw, pick } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/events/brief') {
      const found = requireSession(req, res);
      if (!found) return;
      const desk = deskState(found.session);
      desk.brief ??= mintBrief(draw, pick);
      desk.briefFetches += 1;
      const b = desk.brief;
      return json(res, 200, {
        packRef: b.packRef,
        event: b.event,
        organiser: `${streetName(b.streets[0])} Residents' Association`,
        contact: b.contact[0],
        contactEmail: b.contact[1],
        date: longDate(EVENTS_DATE),
        streets: b.streets.map(streetName),
        closureFrom: b.start.slice(-5),
        closureTo: b.end.slice(-5),
        soundOffBy: b.quiet,
        equipment: EVENTS_EQUIPMENT_PHRASES[b.equipment],
      });
    }

    // Prefills the form after a Change link: the session's own latest
    // attempt, as parsed.
    if (req.method === 'GET' && pathname0 === '/api/events/draft') {
      const found = requireSession(req, res);
      if (!found) return;
      const last = deskState(found.session).attempts.at(-1);
      return json(res, 200, {
        draft: last
          ? {
              streets: last.values.streets,
              eventName: last.values.eventName,
              contactName: last.values.contactName,
              contactEmail: last.values.contactEmail,
              start: last.values.start,
              end: last.values.end,
              quiet: last.values.quiet,
              equipment: last.raw.equipment,
            }
          : null,
      });
    }
    return false;
  };
}

export function documents(ctx) {
  const { TYPES, readBody, getSession, draw, pick, fromPage } = ctx;
  const eventsFromPage = fromPage('/events/');
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache, private', ...headers });
    res.end(body);
  };
  // The form carries the nonce as a hidden field, so a sessionless or
  // forged post gets the same 403 the JSON routes give.
  const formSession = async (req, res) => {
    let body;
    try {
      body = await readBody(req);
    } catch {
      send(res, 413, plainPage('Application too large', 'Your application could not be read.'));
      return null;
    }
    const form = new URLSearchParams(body);
    const found = getSession(req);
    if (!found || form.get('nonce') !== found.session.nonce) {
      send(res, 403, plainPage('Your session has ended', 'For your security we could not accept that form. Start your application again.'));
      return null;
    }
    return { found, form };
  };
  // Legibility, never proof: curl sets every one of these headers.
  const headersOf = (req) => ({
    dest: req.headers['sec-fetch-dest'] ?? null,
    mode: req.headers['sec-fetch-mode'] ?? null,
    site: req.headers['sec-fetch-site'] ?? null,
    fromPage: eventsFromPage(req),
  });

  return {
    prefix: '/events/',
    async beforeStatic({ req, res, url, pathname }) {
      const path = pathname.toLowerCase();
      if (path === '/events/apply.html' && req.method !== 'POST') return;
      if (!['/events/apply.html', '/events/submit', '/events/confirmation'].includes(path)) return;

      if (path === '/events/confirmation') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(res, 405, plainPage('Method not allowed', 'This address can only be read.'), { Allow: 'GET, HEAD' });
          return true;
        }
        const found = getSession(req);
        const ref = url.searchParams.get('ref') ?? '';
        const permit = found?.session.permitDesk?.permits.find((p) => p.number === ref) ?? null;
        if (!permit) {
          send(res, 404, plainPage('Application not found', 'We could not find that application. If you have just submitted it, check the permit number in your confirmation email.'));
          return true;
        }
        send(res, 200, confirmationPage(permit));
        return true;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(303, { Location: 'apply.html' });
        res.end();
        return true;
      }
      if (req.method !== 'POST') {
        send(res, 405, plainPage('Method not allowed', 'This address only accepts a submitted form.'), { Allow: 'POST' });
        return true;
      }
      const posted = await formSession(req, res);
      if (!posted) return true;
      const desk = deskState(posted.found.session);
      desk.brief ??= mintBrief(draw, pick);

      if (path === '/events/apply.html') {
        if (desk.attempts.length >= SESSION_ROWS) {
          send(res, 429, plainPage('Too many applications', 'We cannot take any more applications from this browser today. Try again tomorrow.'));
          return true;
        }
        const parsed = parseApplication(posted.form);
        const attempt = {
          at: Date.now(),
          raw: parsed.raw,
          values: parsed.values,
          errors: parsed.errors.map((e) => e.field),
          ...headersOf(req),
        };
        desk.attempts.push(attempt);
        if (parsed.errors.length) {
          send(res, 200, problemPage(parsed));
          return true;
        }
        // `echo` is the window exactly as the check page prints it, so a run's
        // transcript can be searched for whether the echo reached the agent.
        const draft = {
          id: randomBytes(4).toString('hex'),
          ...parsed.values,
          echo: { start: when(parsed.values.start), end: when(parsed.values.end) },
          at: attempt.at,
        };
        attempt.draft = draft.id;
        desk.drafts.push(draft);
        send(res, 200, checkPage(posted.found.session, draft));
        return true;
      }

      const draft = desk.drafts.find((d) => d.id === posted.form.get('draft')) ?? null;
      if (!draft) {
        send(res, 200, plainPage('We could not find your answers', 'Your answers have expired. Fill in the application again.'));
        return true;
      }
      // One permit per draft: a second submit of the same answers, from Back
      // or a double click, points at the permit already issued.
      let permit = desk.permits.find((p) => p.draft === draft.id);
      if (permit) {
        desk.resubmits += 1;
      } else {
        permit = {
          number: 'PT-' + randomBytes(3).toString('hex').toUpperCase(),
          draft: draft.id,
          eventName: draft.eventName,
          contactName: draft.contactName,
          contactEmail: draft.contactEmail,
          streets: draft.streets,
          start: draft.start,
          end: draft.end,
          quiet: draft.quiet,
          equipment: draft.equipment,
          at: Date.now(),
          ...headersOf(req),
        };
        desk.permits.push(permit);
      }
      res.writeHead(303, { Location: `confirmation?ref=${encodeURIComponent(permit.number)}` });
      res.end();
      return true;
    },
  };
}
