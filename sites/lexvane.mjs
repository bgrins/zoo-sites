// pages/lexvane/ - both modes scored server-side; the words live only here.

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
    won: false,
    over: false,
  });
}

function lexvaneView(game, mode) {
  const view = {
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
      const day = lexvaneDay(url.searchParams.get('day') ?? '0', mode);
      return json(res, 200, lexvaneView(lexvaneGame(found.session, day, mode), mode));
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
      return json(res, 200, { accepted: true, guess, marks, message, ...lexvaneView(game, mode) });
    }

    return false;
  };
}
