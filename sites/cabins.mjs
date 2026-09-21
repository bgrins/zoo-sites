// pages/cabins/ - Tamarack Hollow, a one-cabin rental lodge (cabin-dates).
import { randomBytes } from 'node:crypto';
import { DAY_MS, lcg, utcDay } from './lib.mjs';

// The blackout layout and the nightly rate are drawn per session from a
// seedable ctx.draw, so which Friday of the season can host a four-night stay
// exists nowhere on disk and moves between runs. Every draw makes each Friday
// before the target unbookable in one of two ways: the Friday cell itself is a
// blackout date (visible at a glance), or the cell is open but a blackout falls
// on one of the three nights after it, the mid-stay trap that only a booking
// re-check or a careful read of the whole stay window catches. At least one
// trap of the mid-stay kind exists in every draw. The confirmation reference
// and the total are minted server-side on POST /api/cabins/book, which
// re-checks every night of the stay against the session's own blackout draw.
//
// The season is the calendar month after next, counted in UTC from the day the
// session opened, and the month after it, so every Friday the ask can mean is
// still ahead on any run date. The target is one of the first month's first
// four Fridays.
const CABINS_RATES = [138, 146, 149, 157];

const CABINS_NIGHTS = { min: 2, max: 14 };

const CABINS_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// `epoch` is day 0, the first of the season's first month, and every day is
// numbered from it; `fridays` are that month's first four Fridays.
function cabinsSeason(createdAt) {
  const opened = new Date(utcDay(createdAt));
  const epoch = Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth() + 2, 1);
  const end = Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth() + 4, 0);
  const first = (12 - new Date(epoch).getUTCDay()) % 7;
  return { epoch, days: (end - epoch) / DAY_MS + 1, fridays: [first, first + 7, first + 14, first + 21] };
}

const cabinsIso = (season, n) => new Date(season.epoch + n * DAY_MS).toISOString().slice(0, 10);

// Day number for a strict YYYY-MM-DD string, or null when the string is not a
// real calendar date (2026-09-31 rolls over and fails the round trip).
function cabinsNum(season, raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const n = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - season.epoch) / DAY_MS);
  return cabinsIso(season, n) === m[0] ? n : null;
}

function cabinsShort(season, n) {
  const d = new Date(season.epoch + n * DAY_MS);
  return `${CABINS_MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function cabinsMint(draw, season) {
  const { fridays } = season;
  const rand = lcg(draw('cabins', 4));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const rate = pick(CABINS_RATES);
  const targetIndex = 1 + Math.floor(rand() * (fridays.length - 1));
  const target = fridays[targetIndex];
  // One kind per earlier Friday, redrawn so at least one mid-stay trap exists
  // and, when there is room for both kinds, at least one greyed Friday too.
  const kinds = fridays.slice(0, targetIndex).map(() =>
    rand() < 0.5 ? 'midstay' : 'blackout'
  );
  if (!kinds.includes('midstay')) kinds[Math.floor(rand() * kinds.length)] = 'midstay';
  if (kinds.length >= 2 && !kinds.includes('blackout')) {
    const keep = kinds.indexOf('midstay');
    const i = Math.floor(rand() * kinds.length);
    kinds[i === keep ? (i + 1) % kinds.length : i] = 'blackout';
  }
  const blackouts = new Set();
  kinds.forEach((kind, i) => {
    const friday = fridays[i];
    if (kind === 'midstay') {
      // The Friday cell stays open; one of the three nights after it does not.
      // Nothing here can reach the next Friday (friday + 7) or grey a later
      // trap Friday's own cell, so kinds never interfere with each other.
      const night = friday + 1 + Math.floor(rand() * 3);
      blackouts.add(night);
      if (rand() < 0.4) blackouts.add(night + 1);
    } else {
      blackouts.add(friday);
      if (rand() < 0.5) blackouts.add(friday + 1);
      // The draw is taken either way, so a season whose first Friday is the
      // 1st keeps the same sequence and only drops the day before its window.
      if (rand() < 0.4 && friday > 0) blackouts.add(friday - 1);
    }
  });
  // Later noise so the rest of the season is not uniformly open; it starts a
  // week after the fourth Friday and can never touch a graded stay window.
  const runs = 2 + Math.floor(rand() * 2);
  for (let r = 0; r < runs; r++) {
    const start = fridays[3] + 7 + Math.floor(rand() * 25);
    const len = 1 + Math.floor(rand() * 3);
    for (let d = start; d < Math.min(start + len, season.days); d++) blackouts.add(d);
  }
  // By construction the target is the first Friday whose whole stay is clear
  // (its check-out day included); asserted so an edit to the mint cannot
  // silently move the answer out from under the validator.
  const clear = (f) => [0, 1, 2, 3, 4].every((k) => !blackouts.has(f + k));
  if (fridays.find((f) => clear(f)) !== target) {
    throw new Error('cabins mint: target is not the first clear Friday');
  }
  return {
    rate,
    target,
    blackouts: [...blackouts].sort((a, b) => a - b),
    trapFridays: kinds.flatMap((k, i) => (k === 'midstay' ? [fridays[i]] : [])),
  };
}

function cabinsState(session, draw) {
  if (!session.cabins) {
    const season = cabinsSeason(session.createdAt ?? Date.now());
    const minted = cabinsMint(draw, season);
    const iso = (n) => cabinsIso(season, n);
    session.cabins = {
      season,
      rate: minted.rate,
      // Day numbers relative to season.epoch; serialized to ISO only at the API.
      blackouts: minted.blackouts,
      target: iso(minted.target),
      targetCheckOut: iso(minted.target + 4),
      trapFridays: minted.trapFridays.map(iso),
      views: 0,
      attempts: [],
      rebooks: 0,
      confirmed: null,
    };
  }
  return session.cabins;
}

export function routes(ctx) {
  const { json, readJson, requireSession, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // T053 cabin-dates: the availability sheet behind pages/cabins/. The layout
    // is minted on first read and pinned to the session, so state.reset()
    // clears it between tasks and neither the blackout dates, the rate nor the
    // answer Friday exist in fixture source.
    if (req.method === 'GET' && pathname0 === '/api/cabins/availability') {
      const found = requireSession(req, res);
      if (!found) return;
      const stay = cabinsState(found.session, draw);
      const iso = (n) => cabinsIso(stay.season, n);
      stay.views += 1;
      return json(res, 200, {
        cabin: 'Tamarack Hollow',
        window: { from: iso(0), to: iso(stay.season.days - 1) },
        rate: stay.rate,
        nights: CABINS_NIGHTS,
        blackouts: stay.blackouts.map(iso),
        confirmed: stay.confirmed,
      });
    }

    // Every rule the page states is re-checked here, so the total and the
    // reference are only ever minted for a stay that genuinely clears the
    // session's blackout draw; a stay whose check-in cell is open but whose
    // second or third night is a blackout is refused with the night named.
    // A later booking replaces the reservation (a change of dates, per the
    // booking terms) and mints a fresh reference, so the validator grades the
    // reservation the session finally holds.
    if (req.method === 'POST' && pathname0 === '/api/cabins/book') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const stay = cabinsState(found.session, draw);
      const { season } = stay;
      const iso = (n) => cabinsIso(season, n);
      const checkin = cabinsNum(season, payload.checkin);
      const checkout = cabinsNum(season, payload.checkout);
      const refuse = (outcome, message, detail) => {
        stay.attempts.push({
          checkin: checkin !== null ? iso(checkin) : String(payload.checkin ?? ''),
          checkout: checkout !== null ? iso(checkout) : String(payload.checkout ?? ''),
          outcome,
          at: Date.now(),
        });
        return json(res, 200, { ok: false, outcome, message, detail });
      };
      if (checkin === null || checkout === null) {
        return refuse(
          'format',
          'Dates must be YYYY-MM-DD',
          'Both a check-in and a check-out date are needed, written as YYYY-MM-DD.'
        );
      }
      if (checkin < 0 || checkout > season.days - 1) {
        return refuse(
          'window',
          'Outside this season',
          `The cabin takes bookings from ${iso(0)} to ${iso(season.days - 1)} this season.`
        );
      }
      if (checkout <= checkin) {
        return refuse(
          'order',
          'Check-out before check-in',
          'The check-out date must fall after the check-in date.'
        );
      }
      const nights = checkout - checkin;
      if (nights < CABINS_NIGHTS.min) {
        return refuse(
          'min-nights',
          'Two-night minimum stay',
          `The cabin lets for ${CABINS_NIGHTS.min} nights at the least.`
        );
      }
      if (nights > CABINS_NIGHTS.max) {
        return refuse(
          'max-nights',
          'Fourteen-night maximum stay',
          `The cabin lets for ${CABINS_NIGHTS.max} nights at the most.`
        );
      }
      const blocked = [];
      for (let d = checkin; d < checkout; d++) {
        if (stay.blackouts.includes(d)) blocked.push(d);
      }
      if (blocked.length) {
        return refuse(
          'blackout',
          `Blackout night: ${cabinsShort(season, blocked[0])}`,
          'Every night of a stay, check-in to the morning of check-out, must be ' +
            'clear of blackout dates. Pick dates whose whole stay is open.'
        );
      }
      if (stay.confirmed) stay.rebooks += 1;
      const total = nights * stay.rate;
      const reference = 'TH-' + randomBytes(3).toString('hex').toUpperCase();
      stay.confirmed = {
        checkIn: iso(checkin),
        checkOut: iso(checkout),
        nights,
        total,
        reference,
        at: Date.now(),
      };
      stay.attempts.push({
        checkin: iso(checkin),
        checkout: iso(checkout),
        outcome: 'confirmed',
        at: Date.now(),
      });
      return json(res, 200, {
        ok: true,
        outcome: 'confirmed',
        checkIn: stay.confirmed.checkIn,
        checkOut: stay.confirmed.checkOut,
        nights,
        rate: stay.rate,
        total,
        reference,
        message: 'Reservation confirmed',
      });
    }

    return false;
  };
}
