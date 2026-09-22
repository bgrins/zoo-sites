// Shared helpers for golden-path drivers: poll loops, uid extractors, snapshot
// unwraps, state-case mutations. Keep this file dependency-free and frozen
// during parallel driver work - it is a single-writer resource.

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';

// Poll until fn() returns a truthy value; throw a labelled error otherwise.
// The label reads as "timed out waiting for <label>", so phrase it as the
// thing being waited for ("the confirmation panel to render").
//
// The budget is deliberately generous: 60s, and wall-clock. Under about ten
// concurrent Firefox instances the longest drivers — biglist streams 5,000 rows
// in 20 batches — overrun a 30s budget and report a phantom fixture failure
// while passing serially. Waiting longer costs time only when something is
// genuinely broken, and a real breakage still throws this same labelled error.
//
// An explicit `tries` is honoured as given, in both directions: a driver that
// wants to give up fast (a best-effort decoy poll) passes a small number on
// purpose.
export async function until(label, fn, { tries = 240, gap = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Click a navigation link and PROVE the document changed, retrying the click if
// it did not.
//
// Raising the `until` budget above cannot fix this failure, because the run is
// not slow - it is stopped. `click_by_uid` can report a successful click that
// never navigated, which leaves the document on the old path for the whole poll
// that follows. Callers point this at plain <a href> links, so re-issuing the
// click can only navigate twice, which is why retrying is safe here and would
// NOT be safe on a form submit or any other non-idempotent control.
//
// `findUid` is re-run for EVERY attempt and must take its own fresh snapshot,
// because a uid is the thing that goes bad here: re-clicking the same uid fails
// as often as it is retried, while a re-resolved uid recovers. On 0.9.15 every
// take_snapshot invalidates the previous snapshot's uids, so a uid captured
// before an unrelated poll can already be dead by the time it is clicked; from
// 0.10 a uid dies with its node, which a re-render replaces.
//
// The location is re-read BEFORE each retry: if a click did land and the document
// changed under us, the check decides the outcome, and the click error is
// swallowed on purpose.
export async function clickToPath(mcp, evaluate, findUid, needle, label = needle) {
  const where = async () => {
    const at = await evaluate(() => location.pathname + location.search);
    return typeof at === 'string' ? at : '';
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const at = await where();
    if (at.includes(needle)) return at;
    const uid = await findUid();
    if (!uid) throw new Error(`no element to click for ${label}`);
    await Promise.resolve(mcp('click_by_uid', { uid })).catch(() => {});
    const arrived = await until(
      `navigation to ${label}`,
      async () => {
        const now = await where();
        return now.includes(needle) ? now : null;
      },
      { tries: 24 }
    ).catch(() => null);
    if (arrived) return arrived;
  }
  // Not a fixture failure and not phrased as one: four real clicks on a
  // re-resolved uid did not move the document.
  throw new Error(`click_by_uid never navigated to ${label} after 4 attempts with fresh uids`);
}

// The text of a tool result: every MCP response carries content blocks.
export function textOf(result) {
  return (result.content ?? []).map((c) => c.text).join('\n');
}

// A snapshot's text, with the options the drivers actually use (maxLines,
// selector) passed straight through.
export async function snapText(mcp, opts = {}) {
  return textOf(await mcp('take_snapshot', opts));
}

// First uid whose snapshot line matches the pattern (a regex SOURCE string,
// e.g. 'button "Sign in"'), or null. The uid group is prepended here so call
// sites never re-type it.
export function uidOf(snapshot, pattern) {
  return snapshot.match(new RegExp(`uid=(\\S+) ${pattern}`))?.[1] ?? null;
}

// A code one character away from the real one, for wrongFields pins: same
// shape, guaranteed different.
export function bumpCode(code) {
  const s = String(code);
  return s.slice(0, -1) + (s.endsWith('0') ? '1' : '0');
}

// Escape a literal for use inside a RegExp.
export function esc(literal) {
  return String(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DAY = 86400000;
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// The UTC day of ms, a Date or a YYYY-MM-DD day, or null. A day string is read
// as UTC and must exist, where Date.parse rolls 2026-02-30 over to 2 March and
// reads other shapes in local time.
function readDay(value) {
  let ms = value instanceof Date ? value.getTime() : value;
  if (typeof value === 'string') {
    ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isNaN(ms) && isoOf(ms) !== value) ms = NaN;
  }
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / DAY) * DAY : null;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];
// "Tue", "Tues" and "Tuesday" all name Tuesday.
const nameIn = (names, word) => (word.length < 3 ? -1 : names.findIndex((name) => name.startsWith(word)));
const DATE_TEXT = /^(?:([a-z]+)\.?,?\s+)?(?:(\d{1,2})\s+([a-z]+)\.?|([a-z]+)\.?\s+(\d{1,2}))(?:,?\s+(\d{4}))?$/i;

// The UTC day a page's date text names, or null: "2026-07-31", "Friday 31 July
// 2026", "Fri 31 Jul", "Fri, Jul 31" or "31 Jul". A weekday it names must be
// the day's own. A date printed without its year is read in whichever of the
// year before `near`'s, its own and the one after puts it nearest `near`,
// counting only those on the weekday it names: so an aged date reads as past,
// where reading it as its next occurrence would put it ahead forever.
export function pageDay(text, near) {
  const from = readDay(near);
  if (from === null) throw new Error(`pageDay: near is ${near}, not a timestamp, a Date or a YYYY-MM-DD day`);
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (/^\d{4}-/.test(trimmed)) return readDay(trimmed);
  const m = DATE_TEXT.exec(trimmed);
  if (!m) return null;
  const weekday = m[1] === undefined ? null : nameIn(WEEKDAYS, m[1].toLowerCase());
  const month = nameIn(MONTHS, (m[3] ?? m[4]).toLowerCase());
  const d = +(m[2] ?? m[5]);
  if (weekday === -1 || month === -1) return null;
  const year = new Date(from).getUTCFullYear();
  const days = (m[6] ? [+m[6]] : [year - 1, year, year + 1])
    .map((y) => Date.UTC(y, month, d))
    .filter((t) => new Date(t).getUTCDate() === d && (weekday === null || new Date(t).getUTCDay() === weekday));
  if (!days.length) return null;
  return days.reduce((best, t) => (Math.abs(t - from) < Math.abs(best - from) ? t : best));
}

// Reads `date` for notBeforeToday and notAfterToday: its UTC day, today's, and
// fail(limit), the error naming the page, the date and the limit it broke.
function againstToday(fn, page, date, { text, today }, gapName, gap) {
  const from = readDay(today);
  if (from === null) throw new Error(`${fn}: today is ${today}, not a timestamp, a Date or a YYYY-MM-DD day`);
  if (!Number.isInteger(gap) || gap < 0) throw new Error(`${fn}: ${gapName} is ${gap}, not a whole number of days`);
  const words = text ?? (typeof date === 'string' ? date : undefined);
  const day = typeof date === 'string' ? pageDay(date, from) : readDay(date);
  if (day === null) throw new Error(`${page}: the driver read no date from ${words === undefined ? date : `"${words}"`}`);
  const shown = words === undefined || words === isoOf(day) ? isoOf(day) : `"${words}" (${isoOf(day)})`;
  return { day, from, fail: (limit) => new Error(`${page} prints ${shown}, ${limit} (${isoOf(from)})`) };
}

// A date a site mints ahead of the run (hard rule 9 in
// docs/authoring-fixtures.md): throw unless `date`, as the driver read it off
// `page`, falls on or after today in UTC, or at least `ahead` days after it,
// and return its UTC day. `date` is ms, a Date or the page's own text, read by
// pageDay; `text`, the words the page printed, goes into the error. `today` is
// required: the session's createdAt for a date the site counts from the day the
// session opened, since the gate may have passed midnight since, or Date.now()
// for one the ask fixes.
export function notBeforeToday(page, date, { text, today, ahead = 0 } = {}) {
  const { day, from, fail } = againstToday('notBeforeToday', page, date, { text, today }, 'ahead', ahead);
  if (day < from + ahead * DAY) {
    throw fail(ahead === 0 ? 'before today' : ahead === 1 ? 'not after today' : `fewer than ${ahead} days after today`);
  }
  return day;
}

// The same for a date that must stay behind the run, such as history or an
// issue date: throw unless `date` falls on or before today, or at least
// `behind` days before it.
export function notAfterToday(page, date, { text, today, behind = 0 } = {}) {
  const { day, from, fail } = againstToday('notAfterToday', page, date, { text, today }, 'behind', behind);
  if (day > from - behind * DAY) {
    throw fail(behind === 0 ? 'after today' : behind === 1 ? 'not before today' : `fewer than ${behind} days before today`);
  }
  return day;
}

// State-case helpers. A wrongState/alsoCorrectState case's mutate(state)
// receives a COPY of the pages server's state (eval/verify.mjs), and these
// plant or find what a validator reads there.

// Plant a session the golden path never made, the way a curl probe or a
// re-minted cookie does: fresh sid and nonce, then the given per-task fields.
// It is minted last unless `first`, which mints it before every other session,
// in both Map order and createdAt, as a probe sent ahead of the run would be:
// the shape that shadows a validator reading sessions[0].
export function addSession(state, fields = {}, { first = false } = {}) {
  const sid = randomUUID();
  const others = [...state.sessions];
  const createdAt = first
    ? Math.min(Date.now(), ...others.map(([, s]) => s.createdAt ?? Infinity)) - 1
    : Date.now();
  const session = { nonce: randomBytes(12).toString('hex'), createdAt, ...fields };
  if (first) state.sessions.clear();
  state.sessions.set(sid, session);
  if (first) for (const [key, value] of others) state.sessions.set(key, value);
  return { sid, session };
}

// The first session, in mint order, that satisfies the predicate: the one a
// validator picks with sessions.values().find(). Returns { sid, session } or
// null.
export function findSession(state, predicate) {
  for (const [sid, session] of state.sessions) {
    if (predicate(session, sid)) return { sid, session };
  }
  return null;
}

// Record a beacon as POST /api/beacon does, for gates that read beaconsOf().
export function addBeacon(state, sid, kind, data = {}) {
  const beacon = { sid, kind, data, at: Date.now() };
  state.beacons.push(beacon);
  return beacon;
}

// A session outside the browser, the way a curl probe, a scripted agent or a
// re-minted cookie makes one: one HTML GET of `path` mints the cookie, and the
// page carries the nonce. Drivers use one to prove that grading picks the
// session that did the work over one that merely exists, and to reach states
// no page offers. Every later request goes over Node's fetch, which sends
// `sec-fetch-mode: cors` and no sec-fetch-site or sec-fetch-dest, so what a
// site records about a call comes down to the headers chosen here. Each choice
// is therefore an option rather than a helper's habit:
//
//   provenance   'off-page' (default): no Referer, so a site that stamps
//                provenance records every call as made off the page.
//                'referer': every API call names the minting page as its
//                Referer, as the page's own script would, still without the
//                sec-fetch-site a browser adds.
//   nonce        where the page declares it: 'NONCE' (default,
//                `const NONCE = '...'`) or 'QT_NONCE' (`window.QT_NONCE`, the
//                Quotient pages).
//   nonceHeader  'get' (default): X-Session-Nonce on GETs only, as page script
//                sends it; 'always': on POSTs as well.
//   reply        'body' (default): a call resolves to the parsed JSON body, or
//                {} when the reply is not JSON. 'response': to
//                { status, json, text, body }, json null when the reply is not
//                JSON and body json ?? {}.
//
// get(apiPath, { origin, headers }), post(apiPath, body, { origin, headers })
// and upload(apiPath, { fields, file, origin, headers }), a multipart POST with
// the nonce first, then `fields`, then `file` ({ field, filename, content,
// type }), add request headers of the caller's choosing. `origin` may name any
// listener, because sessions live in one table behind all of them; it defaults
// to `base`. open(pagePath) loads a page as a top-level document navigation and
// resolves its status, over node:http, since fetch stamps its own sec-fetch-mode
// over the one a navigation carries.
const NONCE_PATTERNS = {
  NONCE: /const NONCE = '([0-9a-f]+)'/,
  QT_NONCE: /window\.QT_NONCE = '([0-9a-f]+)'/,
};
export async function straySession(
  base,
  path,
  { provenance = 'off-page', nonce: declared = 'NONCE', nonceHeader = 'get', reply = 'body' } = {}
) {
  if (!['off-page', 'referer'].includes(provenance)) throw new Error(`unknown provenance ${provenance}`);
  if (!NONCE_PATTERNS[declared]) throw new Error(`unknown nonce declaration ${declared}`);
  if (!['get', 'always'].includes(nonceHeader)) throw new Error(`unknown nonceHeader ${nonceHeader}`);
  if (!['body', 'response'].includes(reply)) throw new Error(`unknown reply shape ${reply}`);
  const page = await fetch(base + path, { headers: { accept: 'text/html' } });
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await page.text()).match(NONCE_PATTERNS[declared])?.[1] ?? null;
  if (!cookie || !nonce) throw new Error(`no stray session for ${path}`);
  const referer = provenance === 'referer' ? { referer: base + path } : {};
  const send = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return reply === 'body' ? (json ?? {}) : { status: res.status, json, text, body: json ?? {} };
  };
  return {
    sid: cookie.replace(/^sid=/, ''),
    nonce,
    cookie,
    get: (apiPath, { origin = base, headers = {} } = {}) =>
      send(origin + apiPath, { headers: { cookie, ...referer, 'x-session-nonce': nonce, ...headers } }),
    post: (apiPath, body = {}, { origin = base, headers = {} } = {}) =>
      send(origin + apiPath, {
        method: 'POST',
        headers: {
          cookie,
          ...referer,
          ...(nonceHeader === 'always' ? { 'x-session-nonce': nonce } : {}),
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ nonce, ...body }),
      }),
    upload: (apiPath, { fields = {}, file, origin = base, headers = {} }) => {
      const form = new FormData();
      form.append('nonce', nonce);
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      if (file) {
        form.append(file.field, new Blob([file.content], { type: file.type ?? 'text/plain' }), file.filename);
      }
      return send(origin + apiPath, {
        method: 'POST',
        headers: {
          cookie,
          ...referer,
          ...(nonceHeader === 'always' ? { 'x-session-nonce': nonce } : {}),
          ...headers,
        },
        body: form,
      });
    },
    open: (pagePath) =>
      new Promise((resolve, reject) => {
        const req = http.get(
          new URL(pagePath, base),
          {
            headers: {
              cookie,
              accept: 'text/html',
              'sec-fetch-mode': 'navigate',
              'sec-fetch-dest': 'document',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          }
        );
        req.on('error', reject);
      }),
  };
}
