// pages/schedule/ - Peregrine Court day book (room-booking).
import { randomBytes } from 'node:crypto';
import { lcg } from './lib.mjs';

// pages/schedule/ — Peregrine Court's week day book. Both the request card and the
// occupancy are minted per session from a seedable ctx.draw, so the constraints and
// the free slots (and therefore the answer) exist nowhere on disk and move between
// runs. The mint rejection-samples until the EARLIEST window that meets the whole
// request card is unique, at least three later windows meet it too, and each of the
// four near-miss kinds (a room that is too small, the excluded day, a start before
// the earliest allowed, a gap thirty minutes short) occurs in the week — so the task
// is a constraint solve rather than a hunt for the only gap in the week. POST
// /api/schedule/book re-checks the request card SERVER-side and mints a reference
// from randomBytes only for that earliest window; a valid but later slot is entered
// as a hold and refused a reference, so a near miss is visible in the validator
// detail. The desk also keeps count of requests it could not take and pauses the
// line once there are too many, which throttles a caller posting slots in turn
// without ever blocking a solve worked out from the grid.
const SCHEDULE_DAYS = [
  { key: 'Mon', label: 'Monday 11' },
  { key: 'Tue', label: 'Tuesday 12' },
  { key: 'Wed', label: 'Wednesday 13' },
  { key: 'Thu', label: 'Thursday 14' },
  { key: 'Fri', label: 'Friday 15' },
];

const SCHEDULE_SLOT_COUNT = 18;

const SCHEDULE_OPEN_MINUTES = 8 * 60;

const SCHEDULE_ROOMS = [
  {
    id: 'alder',
    name: 'Alder Room',
    short: 'Alder',
    seats: 8,
    floor: 'first floor',
    kit: 'Wall screen and whiteboard. No conference telephone.',
  },
  {
    id: 'bramble',
    name: 'Bramble Suite',
    short: 'Bramble',
    seats: 16,
    floor: 'first floor',
    kit: 'Projector, conference telephone and hearing loop.',
  },
  {
    id: 'cormorant',
    name: 'Cormorant Hall',
    short: 'Cormorant',
    seats: 24,
    floor: 'second floor',
    kit: 'Projector, two wall screens, lectern and hearing loop.',
  },
];

const SCHEDULE_WEEK = { title: 'Week 21 day book', range: 'Monday 11 to Friday 15 May' };

const SCHEDULE_CLIENT = { client: 'Halvard Freight', reference: 'Request 2214-K' };

// The four axes of the request card. They are drawn per session, so the card has to
// be read rather than remembered, and the answer's day is not a fixed bet: with
// three excluded days in play no single day can dominate the distribution.
const SCHEDULE_ASKS = {
  minutes: [90, 120],
  notBefore: ['10:00', '10:30', '11:00'],
  seats: [12, 14, 20],
  avoidDay: ['Tue', 'Wed', 'Thu'],
};

const SCHEDULE_TITLES = [
  'Perrick & Yates',
  'Sable Union',
  'Copperline Health',
  'Weald & Marr',
  'Nyholm Group',
  'Trentcombe Trust',
  'Aldergate Legal',
  'Bexmoor Foods',
  'Staff briefing',
  'AV service call',
  'Interviews',
  'Deep clean',
];

const SCHEDULE_HOLD_LIMIT = 3;

// Requests the desk could not take before it pauses the line, how long the first
// pause lasts (each one after that is twice as long, up to the cap), and how many
// requests it will take once a pause lapses. A solve read off the day book costs one
// request, so an honest run never meets any of this; a blind scan of the week takes
// about 130 posts to reach the answer, which these numbers put well outside any
// run's time budget. It is a pause and not a lock-out, so an agent that misread the
// grid ten times still gets its answer in.
const SCHEDULE_PATIENCE = 10;

const SCHEDULE_PAUSE_MS = 45000;

const SCHEDULE_PAUSE_MAX_MS = 240000;

const SCHEDULE_PATIENCE_REFUND = 1;

function scheduleSlotLabel(index) {
  const minutes = SCHEDULE_OPEN_MINUTES + index * 30;
  return (
    String(Math.floor(minutes / 60)).padStart(2, '0') +
    ':' +
    String(minutes % 60).padStart(2, '0')
  );
}

const SCHEDULE_SLOTS = Array.from({ length: SCHEDULE_SLOT_COUNT }, (_, i) =>
  scheduleSlotLabel(i)
);

const scheduleRoom = (id) => SCHEDULE_ROOMS.find((r) => r.id === id);

const scheduleBigRooms = (brief) =>
  SCHEDULE_ROOMS.filter((r) => r.seats >= brief.seats).map((r) => r.id);

const scheduleDayName = (key) =>
  SCHEDULE_DAYS.find((d) => d.key === key).label.split(' ')[0];

// One request card, drawn from the same seed as the week.
function scheduleMintBrief(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const minutes = pick(SCHEDULE_ASKS.minutes);
  const notBefore = pick(SCHEDULE_ASKS.notBefore);
  const seats = pick(SCHEDULE_ASKS.seats);
  const avoidDay = pick(SCHEDULE_ASKS.avoidDay);
  const avoidDayName = scheduleDayName(avoidDay);
  return {
    ...SCHEDULE_CLIENT,
    minutes,
    slots: minutes / 30,
    seats,
    notBefore,
    notBeforeIndex: SCHEDULE_SLOTS.indexOf(notBefore),
    avoidDay,
    avoidDayName,
    terms: [
      `The booking runs for ${minutes} minutes without a break`,
      `Nothing may start earlier than ${notBefore} on the day`,
      `The room must seat ${seats} people or more`,
      `${avoidDayName} is not available to this client`,
    ],
    note:
      `${SCHEDULE_CLIENT.client} will not travel on ${avoidDayName}. ` +
      'Any other day of the week suits them.',
  };
}

function scheduleBusyMap(entries) {
  const busy = {};
  for (const room of SCHEDULE_ROOMS) {
    busy[room.id] = {};
    for (const day of SCHEDULE_DAYS) {
      busy[room.id][day.key] = new Array(SCHEDULE_SLOT_COUNT).fill(false);
    }
  }
  for (const entry of entries) {
    for (let i = 0; i < entry.slots; i++) busy[entry.room][entry.day][entry.start + i] = true;
  }
  return busy;
}

function scheduleFreeRun(busy, room, day, start, need) {
  if (start < 0 || start + need > SCHEDULE_SLOT_COUNT) return false;
  for (let i = 0; i < need; i++) {
    if (busy[room][day][start + i]) return false;
  }
  return true;
}

// Every window that meets the whole request card, in reading order, plus the near
// misses — the decoys that make this a solve. A capacity, too-early or short-gap
// decoy is only counted when it PRECEDES the answer, where it can actually mislead;
// the excluded day counts wherever it falls in the week, since pinning it before the
// answer too would force the answer off the early days of the week entirely.
function scheduleAnalyse(entries, brief) {
  const busy = scheduleBusyMap(entries);
  const need = brief.slots;
  const notBefore = brief.notBeforeIndex;
  const big = scheduleBigRooms(brief);
  const valid = [];
  for (let d = 0; d < SCHEDULE_DAYS.length; d++) {
    const day = SCHEDULE_DAYS[d].key;
    if (day === brief.avoidDay) continue;
    for (let s = notBefore; s + need <= SCHEDULE_SLOT_COUNT; s++) {
      for (const room of big) {
        if (scheduleFreeRun(busy, room, day, s, need)) valid.push({ d, day, start: s, room });
      }
    }
  }
  valid.sort((a, b) => a.d - b.d || a.start - b.start);
  const target = valid[0] ?? null;
  const misses = { capacity: 0, day: 0, early: 0, duration: 0, tie: 0 };
  if (!target) return { target, valid, misses, busy };
  const before = (d, s) => d < target.d || (d === target.d && s < target.start);
  for (let d = 0; d < SCHEDULE_DAYS.length; d++) {
    const day = SCHEDULE_DAYS[d].key;
    const excluded = day === brief.avoidDay;
    for (let s = 0; s + need <= SCHEDULE_SLOT_COUNT; s++) {
      for (const room of SCHEDULE_ROOMS) {
        if (!scheduleFreeRun(busy, room.id, day, s, need)) continue;
        const roomBigEnough = room.seats >= brief.seats;
        // A second qualifying room free at the same day and time would leave the
        // answer ambiguous, so those candidates are rejected by the mint.
        if (roomBigEnough && !excluded && s >= notBefore && d === target.d &&
          s === target.start && room.id !== target.room) {
          misses.tie += 1;
        }
        if (roomBigEnough && excluded && s >= notBefore) misses.day += 1;
        if (!before(d, s)) continue;
        if (!roomBigEnough && !excluded && s >= notBefore) misses.capacity += 1;
        if (roomBigEnough && !excluded && s < notBefore) misses.early += 1;
      }
    }
    if (excluded) continue;
    // A gap one half hour short of the brief, walled in on both sides: long enough
    // to look bookable at a glance, thirty minutes short of what was asked for.
    for (const room of SCHEDULE_ROOMS) {
      if (room.seats < brief.seats) continue;
      const week = busy[room.id][day];
      const short = need - 1;
      for (let s = notBefore; s + short <= SCHEDULE_SLOT_COUNT; s++) {
        let clear = true;
        for (let i = 0; i < short; i++) if (week[s + i]) clear = false;
        const walledBefore = s === 0 || week[s - 1];
        const walledAfter = s + short >= SCHEDULE_SLOT_COUNT || week[s + short];
        if (clear && walledBefore && walledAfter && before(d, s)) misses.duration += 1;
      }
    }
  }
  return { target, valid, misses, busy };
}

function scheduleFillDay(rand, out, room, day, gapProb) {
  let i = 0;
  while (i < SCHEDULE_SLOT_COUNT) {
    if (rand() < gapProb) {
      i += 1;
      continue;
    }
    const slots = Math.min(2 + Math.floor(rand() * 5), SCHEDULE_SLOT_COUNT - i);
    if (slots < 2) break;
    out.push({
      room,
      day,
      start: i,
      slots,
      title: SCHEDULE_TITLES[Math.floor(rand() * SCHEDULE_TITLES.length)],
    });
    i += slots + (rand() < 0.55 ? 1 : 2);
  }
}

// Seeded from ctx.draw so neither the week nor the card a graded session faces is
// on disk. The card is drawn once and the week rejection-sampled against it, so the
// card's distribution stays flat; the first draw is kept as a fallback so minting
// always terminates.
function scheduleMint(draw) {
  const rand = lcg(draw('schedule', 4));
  const brief = scheduleMintBrief(rand);
  const cells = SCHEDULE_ROOMS.length * SCHEDULE_DAYS.length * SCHEDULE_SLOT_COUNT;
  // A longer letting needs longer gaps to sit in, so the week is drawn emptier.
  const slack = (brief.slots - 3) * 0.08;
  let fallback = null;
  for (let tries = 0; tries < 4000; tries++) {
    const bookings = [];
    // One busy-day ordering per draw, so the pressure in the week moves and the
    // answer is not always on the same day.
    const loads = [0.3, 0.36, 0.42, 0.5, 0.58].map((n) => n + slack);
    for (let i = loads.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [loads[i], loads[j]] = [loads[j], loads[i]];
    }
    for (const room of SCHEDULE_ROOMS) {
      for (let d = 0; d < SCHEDULE_DAYS.length; d++) {
        scheduleFillDay(rand, bookings, room.id, SCHEDULE_DAYS[d].key, loads[d]);
      }
    }
    const analysis = scheduleAnalyse(bookings, brief);
    if (!analysis.target) continue;
    fallback ??= { brief, bookings, target: analysis.target, analysis };
    if (analysis.misses.tie) continue;
    if (analysis.valid.length < 4) continue;
    const density = bookings.reduce((n, b) => n + b.slots, 0) / cells;
    if (density < 0.4 - slack || density > 0.72 - slack) continue;
    const { capacity, day, early, duration } = analysis.misses;
    if (!capacity || !day || !early || !duration) continue;
    return { brief, bookings, target: analysis.target, analysis };
  }
  return fallback;
}

function scheduleDesk(session, draw) {
  if (!session.schedule) {
    // scheduleMint only returns null if no draw in 4000 produced a bookable week,
    // which has never been observed; an empty week with a valid card still renders.
    const minted = scheduleMint(draw) ?? {
      brief: scheduleMintBrief(Math.random),
      bookings: [],
      target: null,
      analysis: null,
    };
    session.schedule = {
      // The minted week is never mutated: the target is pinned here, so a hold
      // the agent places cannot move the answer under it.
      brief: minted.brief,
      bookings: minted.bookings,
      target: minted.target
        ? { ...minted.target, startLabel: SCHEDULE_SLOTS[minted.target.start] }
        : null,
      validCount: minted.analysis?.valid?.length ?? 0,
      holds: [],
      attempts: [],
      refused: 0,
      pauses: 0,
      pausedUntil: 0,
      reference: null,
      confirmed: null,
    };
  }
  return session.schedule;
}

function scheduleView(desk) {
  const brief = desk.brief;
  const confirmed = desk.holds.filter((h) => h.reference);
  return {
    week: SCHEDULE_WEEK,
    days: SCHEDULE_DAYS,
    slots: SCHEDULE_SLOTS,
    rooms: SCHEDULE_ROOMS,
    brief: {
      client: brief.client,
      reference: brief.reference,
      terms: brief.terms,
      note: brief.note,
    },
    // Only lettings the desk actually holds against the room are drawn into the day
    // book. A provisional hold blocks nothing server-side, so drawing it as an
    // occupied block would make the page assert an occupancy the desk does not
    // enforce and could hide the very slot the request wants; those are listed
    // beside the grid instead.
    bookings: [
      ...desk.bookings.map((b) => ({
        room: b.room,
        day: b.day,
        start: SCHEDULE_SLOTS[b.start],
        slots: b.slots,
        title: b.title,
        mine: false,
      })),
      ...confirmed.map((h) => ({
        room: h.room,
        day: h.day,
        start: SCHEDULE_SLOTS[h.start],
        slots: brief.slots,
        title: h.reference,
        mine: true,
      })),
    ],
    holds: desk.holds
      .filter((h) => !h.reference)
      .map((h) => ({
        day: h.day,
        start: SCHEDULE_SLOTS[h.start],
        room: h.room,
        roomName: scheduleRoom(h.room).name,
      })),
    confirmed: desk.confirmed
      ? {
          day: desk.confirmed.day,
          start: desk.confirmed.start,
          room: desk.confirmed.room,
          roomName: scheduleRoom(desk.confirmed.room).name,
          reference: desk.confirmed.reference,
        }
      : null,
  };
}

function scheduleParseDay(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  const day = SCHEDULE_DAYS.find(
    (d) =>
      d.key.toLowerCase() === value ||
      d.label.toLowerCase() === value ||
      d.label.toLowerCase().split(' ')[0] === value ||
      d.label.toLowerCase().startsWith(value.slice(0, 3))
  );
  return day ? day.key : null;
}

function scheduleParseStart(raw) {
  const value = String(raw ?? '').trim();
  const m = /^(\d{1,2})\s*[:.]?\s*(\d{2})?\s*(am|pm)?$/i.exec(value);
  if (!m) return -1;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? '0');
  const suffix = (m[3] ?? '').toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (minute !== 0 && minute !== 30) return -1;
  return SCHEDULE_SLOTS.indexOf(
    String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
  );
}

function scheduleParseRoom(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  const room =
    SCHEDULE_ROOMS.find((r) => r.id === value || r.name.toLowerCase() === value) ??
    SCHEDULE_ROOMS.find(
      (r) => value.length >= 4 && (r.name.toLowerCase().includes(value) || value.includes(r.id))
    );
  return room ? room.id : null;
}

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // T111 room-booking: the day book behind pages/schedule/. The week and the
    // request card are minted on first read and pinned to the session, so
    // state.reset() clears them between tasks and neither the free slots nor the
    // conditions exist in fixture source.
    if (req.method === 'GET' && pathname0 === '/api/schedule/grid') {
      const found = requireSession(req, res);
      if (!found) return;
      const desk = scheduleDesk(found.session, draw);
      desk.views = (desk.views ?? 0) + 1;
      return json(res, 200, scheduleView(desk));
    }

    // Every request card constraint is re-checked here, so a hold is only ever
    // accepted for a slot that genuinely satisfies the brief, and the reference is
    // minted from randomBytes for the EARLIEST such slot alone — pinned at mint
    // time, so a hold placed on a later slot cannot shift it. A valid but later
    // slot is entered as a hold and told plainly that it carries no reference,
    // which is what makes a near miss legible instead of looking like a failure.
    if (req.method === 'POST' && pathname0 === '/api/schedule/book') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const desk = scheduleDesk(found.session, draw);
      const brief = desk.brief;
      const day = scheduleParseDay(payload.day);
      const start = scheduleParseStart(payload.start);
      const room = scheduleParseRoom(payload.room);
      const now = Date.now();
      if (desk.pausedUntil && now >= desk.pausedUntil) {
        desk.pausedUntil = 0;
        desk.refused = Math.max(0, SCHEDULE_PATIENCE - SCHEDULE_PATIENCE_REFUND);
      }
      const record = (outcome, extra = {}) => {
        desk.attempts.push({
          day: day ?? String(payload.day ?? ''),
          start: start >= 0 ? SCHEDULE_SLOTS[start] : String(payload.start ?? ''),
          room: room ?? String(payload.room ?? ''),
          outcome,
          at: now,
        });
        return json(res, 200, { held: false, outcome, ...extra });
      };
      // The desk counts every request it could not take and every speculative hold.
      // A slot worked out from the day book costs one request, so an honest solve
      // never comes near this; a caller posting slots in turn hits it within the
      // first day of the week and is made to wait, and each further pause is twice
      // as long, which is what makes a blind scan of the ~130 posts it takes to
      // reach the answer cost more than any run has time for. It is a pause and not
      // a lock-out: part of the count is refunded whenever one lapses, so an agent
      // that simply misread the grid ten times still gets its answer in.
      const charge = () => {
        desk.refused = (desk.refused ?? 0) + 1;
        if (desk.refused < SCHEDULE_PATIENCE || desk.pausedUntil) return '';
        const wait = Math.min(
          SCHEDULE_PAUSE_MS * 2 ** (desk.pauses ?? 0),
          SCHEDULE_PAUSE_MAX_MS
        );
        desk.pauses = (desk.pauses ?? 0) + 1;
        desk.pausedUntil = now + wait;
        return ` The desk will take no further requests on this line for ${
          Math.round(wait / 1000)
        } seconds.`;
      };
      const refuse = (outcome, extra = {}) =>
        record(outcome, { ...extra, detail: `${extra.detail ?? ''}${charge()}` });
      if (desk.pausedUntil) {
        return record('desk-busy', {
          message: 'The desk has paused this line.',
          detail:
            `Too many requests the desk could not take. It will take another in ` +
            `${Math.ceil((desk.pausedUntil - now) / 1000)} seconds; work the slot out ` +
            `from the day book before asking again.`,
          waitSeconds: Math.ceil((desk.pausedUntil - now) / 1000),
        });
      }
      if (!day) {
        return refuse('unknown-day', {
          message: 'Day not recognised.',
          detail: 'The day book runs Monday to Friday.',
        });
      }
      if (start < 0) {
        return refuse('unknown-start', {
          message: 'Start time not recognised.',
          detail: 'Lettings begin on the half hour, 08:00 to 16:30.',
        });
      }
      if (!room) {
        return refuse('unknown-room', {
          message: 'Room not recognised.',
          detail: 'Alder Room, Bramble Suite or Cormorant Hall.',
        });
      }
      const need = brief.slots;
      if (start + need > SCHEDULE_SLOT_COUNT) {
        return refuse('hours', {
          message: 'Will not fit before 17:00.',
          detail: `A ${brief.minutes} minute letting must end by 17:00.`,
        });
      }
      const sameSlot = desk.holds.find(
        (h) => h.day === day && h.room === room && h.start === start
      );
      if (sameSlot?.reference) {
        desk.attempts.push({
          day,
          start: SCHEDULE_SLOTS[start],
          room,
          outcome: 'already-held',
          at: now,
        });
        return json(res, 200, {
          held: true,
          outcome: 'already-held',
          reference: sameSlot.reference,
          message: 'You hold that period already.',
          detail: 'The reference below stands; there is nothing further to do.',
        });
      }
      if (!scheduleFreeRun(scheduleBusyMap(desk.bookings), room, day, start, need)) {
        return refuse('conflict', {
          message: 'Already let across that period.',
          detail: `All ${need} half hours must be clear in the same room.`,
        });
      }
      // Own provisional holds that overlap are treated as a change of booking (see
      // the booking terms) and released below, so a hold placed on the wrong slot
      // can never wall off the slot the request actually wants. A hold that has
      // already been confirmed is not moved silently.
      const overlapping = desk.holds.filter(
        (h) => h.day === day && h.room === room && h.start < start + need && start < h.start + need
      );
      if (overlapping.some((h) => h.reference)) {
        return refuse('conflict', {
          message: 'Already let across that period.',
          detail: 'Your own confirmed letting covers part of that period.',
        });
      }
      const seats = scheduleRoom(room).seats;
      if (seats < brief.seats) {
        return refuse('capacity', {
          message: `${scheduleRoom(room).name} seats only ${seats}.`,
          detail: `The request needs seats for ${brief.seats} or more.`,
        });
      }
      if (day === brief.avoidDay) {
        return refuse('excluded-day', {
          message: 'The request excludes that day.',
          detail: brief.note,
        });
      }
      if (start < brief.notBeforeIndex) {
        return refuse('too-early', {
          message: `Too early: ${brief.notBefore} at soonest.`,
          detail: `The request will not start before ${brief.notBefore}.`,
        });
      }
      const isTarget =
        !!desk.target &&
        desk.target.day === day &&
        desk.target.start === start &&
        desk.target.room === room;
      // The hold limit throttles a caller working through every slot in turn; it
      // never blocks the earliest suitable slot, so a solved request always lands.
      if (!isTarget && desk.holds.length - overlapping.length >= SCHEDULE_HOLD_LIMIT) {
        return refuse('hold-limit', {
          message: 'Hold limit reached.',
          detail: `Three provisional holds are already open for ${brief.client}.`,
        });
      }
      if (overlapping.length) {
        desk.holds = desk.holds.filter((h) => !overlapping.includes(h));
        desk.released = (desk.released ?? 0) + overlapping.length;
      }
      const hold = { day, start, room, target: isTarget, reference: null, at: now };
      if (isTarget) {
        desk.reference ??= 'PCR-' + randomBytes(3).toString('hex').toUpperCase();
        hold.reference = desk.reference;
        desk.confirmed = {
          day,
          start: SCHEDULE_SLOTS[start],
          room,
          reference: desk.reference,
          at: hold.at,
        };
      }
      desk.holds.push(hold);
      desk.attempts.push({
        day,
        start: SCHEDULE_SLOTS[start],
        room,
        outcome: isTarget ? 'confirmed' : 'held',
        released: overlapping.length,
        at: hold.at,
      });
      const paused = isTarget ? '' : charge();
      return json(res, 200, {
        held: true,
        outcome: isTarget ? 'confirmed' : 'held',
        reference: hold.reference,
        message: isTarget ? 'Confirmed by the desk.' : 'Held for the duty manager.',
        detail: isTarget
          ? 'Quote the reference below at the front desk on the day.'
          : 'A reference is issued only for the first slot in the week that suits ' +
            `the request. A provisional hold does not block the room.${paused}`,
      });
    }

    return false;
  };
}
