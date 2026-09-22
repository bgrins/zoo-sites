// Pure helpers shared by site modules. Anything that needs request or session
// plumbing belongs on ctx instead (see README.md).

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// A 32-bit LCG over [0, 1), seeded from the first four bytes it is handed, so a
// whole rejection-sampled difficulty mint replays from one ctx.draw(scope, 4).
export function lcg(bytes) {
  let seed = bytes.readUInt32BE(0);
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// A date that has to stay ahead of the run is counted in whole days from the UTC
// day its session opened (hard rule 9 in docs/authoring-fixtures.md).
export const DAY_MS = 86400000;
export const WEEK_MS = 7 * DAY_MS;
export const utcDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

// A YYYY-MM-DD day as its UTC midnight. Date.parse rolls 2026-02-30 over to
// 2 March and reads other shapes in local time, so both throw here.
export function isoDay(iso) {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(iso) : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) throw new Error(`not a YYYY-MM-DD day: ${iso}`);
  return t;
}

// The UTC day of a ms timestamp (a session's createdAt) or a Date. Anything
// else throws, where utcDay(null) would mint 1 January 1970 into a page.
function dayOf(at) {
  const ms = at instanceof Date ? at.getTime() : at;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new Error(`not a timestamp or a Date: ${at}`);
  return utcDay(ms);
}

// The first UTC day on or after the day of `at` whose weekday is `weekday`,
// 0 for Sunday as getUTCDay counts.
export function nextWeekday(at, weekday) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error(`not a weekday from 0 to 6: ${weekday}`);
  const day = dayOf(at);
  return day + ((weekday - new Date(day).getUTCDay() + 7) % 7) * DAY_MS;
}

// A fixed YYYY-MM-DD day moved by whole weeks to the first day on its weekday
// on or after the day of `at`, 0 to 6 days after it, or with `past` to the last
// one before it, 1 to 7 days before. `day` is its UTC midnight, and `weeks`,
// negative when the day moved back, moves every other date the page prints
// with it.
export function shiftWeeks(iso, at, { past = false } = {}) {
  const fixed = isoDay(iso);
  const day = nextWeekday(dayOf(at) - (past ? WEEK_MS : 0), new Date(fixed).getUTCDay());
  return { day, iso: new Date(day).toISOString().slice(0, 10), weeks: (day - fixed) / WEEK_MS };
}

// The ISO 8601 week of the UTC day of `at`, as { year, week }: a week starts
// on Monday and belongs to the year its Thursday falls in, so 1 January 2027
// is in week 53 of 2026.
export function isoWeek(at) {
  const day = dayOf(at);
  const thursday = day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  return { year, week: Math.floor((thursday - Date.UTC(year, 0, 1)) / WEEK_MS) + 1 };
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A UTC day as a British page prints it: "Friday 25 September 2026", with the
// weekday or the year left off on request.
export function dayText(ms, { weekday = true, year = true } = {}) {
  const at = new Date(ms);
  return [
    weekday ? WEEKDAY_NAMES[at.getUTCDay()] : null,
    at.getUTCDate(),
    MONTH_NAMES[at.getUTCMonth()],
    year ? at.getUTCFullYear() : null,
  ].filter((part) => part !== null).join(' ');
}

// A standing habitat (serve.mjs) never resets state, so a record one session
// grows on every request needs a ceiling. Telemetry, which a validator may
// report but never grades, is trimmed oldest-first with pushTrimmed. A record
// a validator grades is never trimmed, since a flood could push the row that
// fails a task off the front: its route refuses the request once the record
// holds SESSION_ROWS rows.
export const SESSION_ROWS = 500;

export function pushTrimmed(list, row, max = SESSION_ROWS) {
  list.push(row);
  if (list.length > max) list.splice(0, list.length - max);
}
