// pages/lexvane/ - both modes scored server-side; the words live only here.
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS } from './lib.mjs';

// pages/lexvane/index.html — BOTH modes are scored server-side. The word
// lists, the two-pass marking and the hard-mode reuse rule live here only: the
// page receives marks, never the word (a lost game is never told the answer),
// so no answer word exists in fixture source and a solve has to be played. A
// word list in the page, even base64, makes the graded word a one-request read.
const LEXVANE_EASY_WORDS = [
  'CRISP',
  'PLUMB',
  'GLINT',
  'FROND',
  'MIRTH',
  'QUAKE',
  'SWOOP',
];

const LEXVANE_HARD_WORDS = [
  'GRANITE',
  'THIMBLE',
  'ORCHARD',
  'DOLPHIN',
  'PARSLEY',
  'JUNIPER',
  'SAWDUST',
];

const LEXVANE_EASY_TRIES = 6;

const LEXVANE_HARD_TRIES = 5;

const LEXVANE_TIERS = {
  puzzles: { name: 'Puzzles only', price: '£3.49 a month' },
  full: { name: 'Full press', price: '£8.99 a month' },
};

// One session slot per mode, so easy day 0 and hard day 0 are separate games
// with separate try budgets. bindHints is the hard-mode reuse rule.
const LEXVANE_MODES = {
  easy: {
    words: LEXVANE_EASY_WORDS,
    tries: LEXVANE_EASY_TRIES,
    slot: 'lexvaneEasy',
    bindHints: false,
  },
  hard: {
    words: LEXVANE_HARD_WORDS,
    tries: LEXVANE_HARD_TRIES,
    slot: 'lexvaneHard',
    bindHints: true,
  },
};

function lexvaneMode(value) {
  return String(value ?? '') === 'hard' ? LEXVANE_MODES.hard : LEXVANE_MODES.easy;
}

function lexvaneMark(guess, answer) {
  const result = new Array(answer.length).fill('absent');
  const remaining = {};
  for (let i = 0; i < answer.length; i++) {
    if (guess[i] === answer[i]) {
      result[i] = 'correct';
    } else {
      remaining[answer[i]] = (remaining[answer[i]] ?? 0) + 1;
    }
  }
  for (let i = 0; i < answer.length; i++) {
    if (result[i] !== 'correct' && remaining[guess[i]] > 0) {
      result[i] = 'present';
      remaining[guess[i]] -= 1;
    }
  }
  return result;
}

// Everything the hard-mode rule obliges the next guess to keep: greens stay in
// their spot, and every letter ever marked green or amber must reappear.
function lexvaneHints(game) {
  const fixed = new Array(game.length).fill('');
  const reuse = new Set();
  for (const played of game.guesses) {
    for (let i = 0; i < played.marks.length; i++) {
      if (played.marks[i] === 'correct') {
        fixed[i] = played.guess[i];
        reuse.add(played.guess[i]);
      } else if (played.marks[i] === 'present') {
        reuse.add(played.guess[i]);
      }
    }
  }
  return { fixed, reuse: [...reuse].sort() };
}

function lexvaneViolation(guess, hints) {
  for (let i = 0; i < hints.fixed.length; i++) {
    if (hints.fixed[i] && guess[i] !== hints.fixed[i]) {
      return `Hard mode: keep ${hints.fixed[i]} in spot ${i + 1}.`;
    }
  }
  for (const letter of hints.reuse) {
    if (!guess.includes(letter)) {
      return `Hard mode: must reuse ${letter}.`;
    }
  }
  return null;
}

// "Not in word list" without a word list: the refusal catches strings no English
// word contains (no vowel, a letter three times running, a pair of letters that
// never meet in an English word, a keyboard or alphabet run) and nothing else.
// It is deliberately broad. A real word refused here would cost an honest solver
// turns, and a pseudo-word let through costs nothing but a try it chose to spend.
// The letter pairs are the ones absent from every word in the public-domain
// Webster's Second list, which is also what the rules were checked against.
const LEXVANE_NEVER_PAIRED = new Set(
  (
    'BX CJ CV CX DX FQ FX GQ GX HX JC JF JG JP JQ JS JV JW JX JZ KQ KX KZ MX PX PZ QB QC QD ' +
    'QF QG QH QJ QK QL QM QN QP QS QT QV QW QX QY QZ SX VB VD VF VG VH VJ VM VP VQ VT VW VX ' +
    'WV WX XJ XX ZJ ZQ ZX'
  ).split(' ')
);
const LEXVANE_RUNS = [
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 4],
  ['QWERTYUIOP', 5],
  ['ASDFGHJKL', 5],
  ['ZXCVBNM', 5],
].flatMap(([row, n]) =>
  [row, [...row].reverse().join('')].flatMap((r) =>
    Array.from({ length: r.length - n + 1 }, (_, i) => r.slice(i, i + n))
  )
);

function lexvaneIsWord(guess) {
  if (!/[AEIOUY]/.test(guess) || /^[AEIOUY]+$/.test(guess)) return false;
  if (/(.)\1\1/.test(guess) || /[^AEIOUY]{6}/.test(guess)) return false;
  for (let i = 0; i + 1 < guess.length; i++) {
    if (LEXVANE_NEVER_PAIRED.has(guess.slice(i, i + 2))) return false;
  }
  return !LEXVANE_RUNS.some((run) => guess.includes(run));
}

// Only in-range day indexes exist, so each word has exactly one game key and
// one five-try budget: out-of-range or junk days fall back to day 0 rather than
// wrapping, which would alias day 10/17/24 onto day 3 with a fresh slate each.
function lexvaneDay(value, mode) {
  const asked = Number(value);
  return Number.isInteger(asked) && asked >= 0 && asked < mode.words.length ? asked : 0;
}

function lexvaneGame(session, day, mode) {
  const games = (session[mode.slot] ??= {});
  const word = mode.words[day];
  return (games[day] ??= {
    day,
    word,
    length: word.length,
    guesses: [],
    violations: [],
    nonWords: [],
    won: false,
    over: false,
  });
}

// The session's own record for one mode, finished games only, in day order.
// A streak is consecutive won days ending at the latest finished day.
function lexvaneStats(session, mode) {
  const games = Object.values(session[mode.slot] ?? {})
    .filter((g) => g.over)
    .sort((a, b) => a.day - b.day);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const g of games) {
    run = g.won ? (prev !== null && prev.won && prev.day === g.day - 1 ? run + 1 : 1) : 0;
    best = Math.max(best, run);
    prev = g;
  }
  const won = games.filter((g) => g.won).length;
  return { played: games.length, won, streak: run, best };
}

function lexvaneView(game, mode) {
  const view = {
    day: game.day,
    length: game.length,
    tries: mode.tries,
    guessNumber: game.guesses.length,
    triesLeft: mode.tries - game.guesses.length,
    played: game.guesses.map((p) => ({ guess: p.guess, marks: p.marks })),
    won: game.won,
    over: game.over,
  };
  if (!mode.bindHints) return view;
  const hints = lexvaneHints(game);
  return { ...view, fixed: hints.fixed, reuse: hints.reuse };
}

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/lexvane/state') {
      const found = requireSession(req, res);
      if (!found) return;
      const mode = lexvaneMode(url.searchParams.get('mode'));
      const asked = url.searchParams.get('day') ?? '0';
      const day = lexvaneDay(asked, mode);
      return json(res, 200, {
        ...lexvaneView(lexvaneGame(found.session, day, mode), mode),
        available: Number(asked) === day,
        stats: lexvaneStats(found.session, mode),
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/lexvane/guess') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const mode = lexvaneMode(payload?.mode);
      const game = lexvaneGame(found.session, lexvaneDay(payload?.day, mode), mode);
      const guess = String(payload?.guess ?? '')
        .trim()
        .toUpperCase();
      const reject = (reason) =>
        json(res, 200, { accepted: false, reason, ...lexvaneView(game, mode) });
      if (game.over) {
        return reject('This puzzle is finished.');
      }
      if (guess.length !== game.length || !/^[A-Z]+$/.test(guess)) {
        return reject(`Guesses must be ${game.length} letters.`);
      }
      if (game.guesses.some((p) => p.guess === guess)) {
        return reject(`Already guessed ${guess}.`);
      }
      if (game.nonWords.length >= SESSION_ROWS || game.violations.length >= SESSION_ROWS) {
        return json(res, 429, { error: 'Too many guesses for this puzzle. Come back tomorrow.' });
      }
      if (!lexvaneIsWord(guess)) {
        game.nonWords.push({ guess, at: Date.now() });
        return reject(`Not in word list: ${guess}. That one is free.`);
      }
      // Hard mode only: a guess that drops a revealed hint is refused outright
      // and does NOT spend one of the five tries, so every counted guess obeyed
      // the rule.
      if (mode.bindHints) {
        const violation = lexvaneViolation(guess, lexvaneHints(game));
        if (violation) {
          game.violations.push({ guess, reason: violation, at: Date.now() });
          return reject(violation);
        }
      }
      const marks = lexvaneMark(guess, game.word);
      game.guesses.push({ guess, marks, at: Date.now() });
      if (guess === game.word) {
        game.won = true;
        game.over = true;
      } else if (game.guesses.length >= mode.tries) {
        game.over = true;
      }
      const message = game.won
        ? `Solved in ${game.guesses.length} ${game.guesses.length === 1 ? 'guess' : 'guesses'}.`
        : game.over
          ? 'Out of guesses.'
          : '';
      return json(res, 200, {
        accepted: true,
        guess,
        marks,
        message,
        ...lexvaneView(game, mode),
        stats: lexvaneStats(found.session, mode),
      });
    }

    // Ungraded: a subscription starts with a payment link sent to the address.
    if (req.method === 'POST' && pathname0 === '/api/lexvane/subscribe') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const email = String(payload.email ?? '').trim();
      const tierKey = String(payload.tier ?? '');
      const tier = Object.hasOwn(LEXVANE_TIERS, tierKey) ? LEXVANE_TIERS[tierKey] : null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
        return json(res, 400, { error: 'Enter the email address the subscription should go to.' });
      }
      if (!tier) return json(res, 400, { error: 'Choose one of the two tiers.' });
      const sub = (found.session.lexvaneSubscribe ??= {
        reference: 'MP-' + randomBytes(3).toString('hex').toUpperCase(),
      });
      Object.assign(sub, { email, tier: tier.name, at: Date.now() });
      return json(res, 200, { ok: true, reference: sub.reference, email, tier: tier.name, price: tier.price });
    }

    return false;
  };
}
