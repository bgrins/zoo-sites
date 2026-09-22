// pages/forge/ - Kettleforge pull request 482 (pr-review). The defect is drawn per session.
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS } from './lib.mjs';

// pages/forge/ — Kettleforge pull request 482 in hollowmill/brine-gateway. The
// unified diff and the failing check's assertion log are NOT in fixture source:
// the page fetches both from session-gated endpoints, and which of four seeded
// sites carries the defect is drawn per session from ctx.draw, so the
// at-fault file, new-side line number and identifier all differ run to run.
// Every site not drawn is emitted in its CORRECT form, which is what makes the
// other three identifiers plausible decoys rather than dead giveaways. A second
// per-session draw decides how many filler lines sit ahead of each file's seeded
// rows, so the line numbers move run to run too and no address on this page can
// be memorised from an earlier sweep.
const FORGE_PULL = {
  repo: 'hollowmill/brine-gateway',
  number: 482,
  title: 'tariff: cache lane quotes and align rate windows',
  author: 't.ashgrove',
  head: 'tariff-cache-window',
  awaitBase: 'trunk',
  commits: 6,
};

const FORGE_DEFECTS = {
  'cache-ttl': {
    identifier: 'softTtlMs',
    check: [
      '  tariff cache',
      '    1) serves a quote that is still inside its hard TTL',
      '    + returns null once an entry passes half of the window',
      '',
      '  1) tariff cache',
      '       serves a quote that is still inside its hard TTL:',
      '',
      '      AssertionError [ERR_ASSERTION]: expected a quote cached 8 minutes ago to',
      '      still be served, the configured TTL being 900 seconds',
      '      + expected - actual',
      '',
      '      -  null',
      "      +  { laneId: 'HM-4402', total: 148.5, cached: true }",
      '',
      '      at Object.<anonymous> (test/tariff/cache.test.js:64:5)',
      '      at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ],
  },
  'cache-key': {
    identifier: 'tariffClass',
    check: [
      '  tariff cache',
      '    1) keeps STD and EXP quotes for one lane apart',
      '    + the second class reads back the first class price',
      '',
      '  1) tariff cache',
      '       keeps STD and EXP quotes for one lane apart:',
      '',
      '      AssertionError [ERR_ASSERTION]: expected the EXP quote for lane HM-4402 to',
      '      be 214.75, the STD price for the same lane and window being 148.5',
      '      + expected - actual',
      '',
      '      -  148.5',
      '      +  214.75',
      '',
      '      at Object.<anonymous> (test/tariff/cache.test.js:102:5)',
      '      at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ],
  },
  'window-unit': {
    identifier: 'WINDOW_MINUTES',
    check: [
      '  rate window',
      '    1) aligns boundaries 900 seconds apart',
      '    + consecutive boundaries land 15 seconds apart',
      '',
      '  1) rate window',
      '       aligns boundaries 900 seconds apart:',
      '',
      '      AssertionError [ERR_ASSERTION]: expected the span between two consecutive',
      '      rate window boundaries to be 900, seconds being the unit throughout',
      '      + expected - actual',
      '',
      '      -  900',
      '      +  15',
      '',
      '      at Object.<anonymous> (test/tariff/window.test.js:31:5)',
      '      at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ],
  },
  'quote-rate': {
    identifier: 'perTonne',
    check: [
      '  quote pricing',
      '    1) prices 9 units at the per-unit rate',
      '    + total comes back nine times the tonnage rate',
      '',
      '  1) quote pricing',
      '       prices 9 units at the per-unit rate:',
      '',
      '      AssertionError [ERR_ASSERTION]: expected the total for 9 units of lane',
      '      HM-4402 at 16.5 per unit to be 148.5',
      '      + expected - actual',
      '',
      '      -  148.5',
      '      +  1336.5',
      '',
      '      at Object.<anonymous> (test/tariff/quote.test.js:47:5)',
      '      at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ],
  },
};

export const FORGE_DEFECT_KEYS = Object.keys(FORGE_DEFECTS);

// Rows are [kind, text] with kind 'ctx' | 'add' | 'del'; a four-element row
// [ 'add', correctText, defectKey, buggyText ] is a seeded defect site, and a
// [ 'pad', [texts] ] row expands to the first N of those texts as added lines,
// N being the per-session draw for that file. Every pad sits ahead of that
// file's seeded rows, which is what moves the at-fault line number.
const FORGE_FILES = [
  {
    path: 'src/tariff/cache.js',
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        section: '',
        rows: [
          ['ctx', "'use strict';"],
          ['ctx', ''],
          ['ctx', "const { createHash } = require('node:crypto');"],
          ['add', "const { metrics } = require('../telemetry/metrics');"],
          ['ctx', ''],
          ['ctx', 'const DEFAULT_TTL_SECONDS = 900;'],
          ['add', 'const SOFT_TTL_RATIO = 0.5;'],
          ['add', 'const MAX_ENTRIES = 4096;'],
          [
            'pad',
            [
              'const EVICT_SAMPLE = 32;',
              'const WARN_AFTER_MISSES = 500;',
              'const MAX_KEY_CHARS = 120;',
              "const METRIC_PREFIX = 'tariff.cache';",
              'const CLOCK_SKEW_MS = 250;',
            ],
          ],
          ['add', "const KEY_PREFIX = 'tariff';"],
          ['ctx', ''],
          ['del', 'function keyFor(laneId, tariffClass) {'],
          ['del', "  return [laneId, tariffClass].join(':');"],
          ['add', '// A quote is only valid inside the rate window it was priced in, so the'],
          ['add', '// window start belongs to the identity of a cached entry.'],
          ['add', 'function keyFor(laneId, tariffClass, window) {'],
          // The two forms share their first 27 characters on purpose: that is
          // exactly what our snapshot keeps, so the omission is invisible there.
          [
            'add',
            "  return [KEY_PREFIX, laneId, tariffClass, window.start].join(':');",
            'cache-key',
            "  return [KEY_PREFIX, laneId, window.start].join(':');",
          ],
          ['add', '}'],
          ['add', ''],
          ['add', 'function digest(key) {'],
          ['add', "  return createHash('sha1').update(key).digest('hex').slice(0, 16);"],
          ['ctx', '}'],
        ],
      },
      {
        section: 'class TariffCache {',
        expandRows: [
          '',
          '// Lane quotes are read far more often than they are priced, so the gateway',
          '// keeps the last price for each lane, class and window in memory.',
          '',
        ],
        rows: [
          ['ctx', 'class TariffCache {'],
          ['del', '  constructor({ ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {'],
          ['add', '  constructor({ ttlSeconds = DEFAULT_TTL_SECONDS, onEvict = null } = {}) {'],
          ['ctx', '    this.ttlMs = ttlSeconds * 1000;'],
          ['add', '    this.softTtlMs = Math.floor(this.ttlMs * SOFT_TTL_RATIO);'],
          ['ctx', '    this.entries = new Map();'],
          ['add', '    this.onEvict = onEvict;'],
          ['add', '    this.hits = 0;'],
          ['add', '    this.misses = 0;'],
          ['ctx', '  }'],
          ['ctx', ''],
          ['del', '  get(laneId, tariffClass) {'],
          ['del', '    const entry = this.entries.get(keyFor(laneId, tariffClass));'],
          ['del', '    if (!entry) return null;'],
          ['del', '    return entry.value;'],
          ['add', '  get(laneId, tariffClass, window) {'],
          ['add', '    const entry = this.entries.get(keyFor(laneId, tariffClass, window));'],
          ['add', '    if (!entry) {'],
          ['add', '      this.misses += 1;'],
          ['add', '      return null;'],
          ['add', '    }'],
          ['add', '    const now = Date.now();'],
          [
            'add',
            '    if (now - entry.storedAt > this.ttlMs) {',
            'cache-ttl',
            '    if (now - entry.storedAt > this.softTtlMs) {',
          ],
          ['add', '      this.evict(keyFor(laneId, tariffClass, window));'],
          ['add', '      this.misses += 1;'],
          ['add', '      return null;'],
          ['add', '    }'],
          ['add', '    this.hits += 1;'],
          ['add', '    return entry.value;'],
          ['ctx', '  }'],
        ],
      },
      {
        section: 'class TariffCache {',
        expandRows: ['', '  // Prices are written back through the same key builder.', ''],
        rows: [
          ['del', '  set(laneId, tariffClass, value) {'],
          ['del', "    this.entries.set(keyFor(laneId, tariffClass), { value });"],
          ['add', '  set(laneId, tariffClass, window, value) {'],
          ['add', '    if (this.entries.size >= MAX_ENTRIES) this.evictOldest();'],
          ['add', '    this.entries.set(keyFor(laneId, tariffClass, window), {'],
          ['add', '      value,'],
          ['add', '      storedAt: Date.now(),'],
          ['add', '      window,'],
          ['add', '    });'],
          ['ctx', '  }'],
          ['add', ''],
          ['add', '  isStale(laneId, tariffClass, window) {'],
          ['add', '    const entry = this.entries.get(keyFor(laneId, tariffClass, window));'],
          ['add', '    if (!entry) return true;'],
          ['add', '    return Date.now() - entry.storedAt > this.softTtlMs;'],
          ['add', '  }'],
          ['add', ''],
          ['add', '  evict(key) {'],
          ['add', '    const entry = this.entries.get(key);'],
          ['add', '    if (!entry) return false;'],
          ['add', '    this.entries.delete(key);'],
          ['add', '    if (this.onEvict) this.onEvict(key, entry);'],
          ['add', "    metrics.increment('tariff.cache.evicted', { key: digest(key) });"],
          ['add', '    return true;'],
          ['add', '  }'],
          ['add', ''],
          ['add', '  evictOldest() {'],
          ['add', '    let oldestKey = null;'],
          ['add', '    let oldestAt = Infinity;'],
          ['add', '    for (const [key, entry] of this.entries) {'],
          ['add', '      if (entry.storedAt < oldestAt) {'],
          ['add', '        oldestAt = entry.storedAt;'],
          ['add', '        oldestKey = key;'],
          ['add', '      }'],
          ['add', '    }'],
          ['add', '    return oldestKey ? this.evict(oldestKey) : false;'],
          ['add', '  }'],
          ['ctx', '}'],
          ['ctx', ''],
          ['del', 'module.exports = { TariffCache, keyFor };'],
          ['add', 'module.exports = { TariffCache, keyFor, digest };'],
        ],
      },
    ],
  },
  {
    path: 'src/tariff/window.js',
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        section: '',
        rows: [
          ['ctx', "'use strict';"],
          ['ctx', ''],
          ['del', 'const WINDOW_SECONDS = 900;'],
          ['add', 'const WINDOW_SECONDS = 900;'],
          ['add', 'const WINDOW_MINUTES = WINDOW_SECONDS / 60;'],
          ['add', 'const GRACE_SECONDS = 30;'],
          [
            'pad',
            [
              'const MAX_SKEW_SECONDS = 5;',
              'const BOUNDARY_EPSILON = 1;',
              "const LABEL_UNIT = 'min';",
              'const MAX_WINDOWS_AHEAD = 4;',
              'const MIN_EPOCH_SECONDS = 1704067200;',
            ],
          ],
          ['ctx', ''],
          ['del', 'function windowFor(epochSeconds) {'],
          ['del', '  const start = epochSeconds - (epochSeconds % WINDOW_SECONDS);'],
          ['del', '  return { start, end: start + WINDOW_SECONDS };'],
          ['add', '// Rate windows align to absolute boundaries so two gateways pricing the same'],
          ['add', '// lane in the same minute agree on the window they charged against.'],
          ['add', 'function windowFor(epochSeconds) {'],
          [
            'add',
            '  const floor = Math.floor(epochSeconds / WINDOW_SECONDS) * WINDOW_SECONDS;',
            'window-unit',
            '  const floor = Math.floor(epochSeconds / WINDOW_MINUTES) * WINDOW_MINUTES;',
          ],
          ['add', '  return {'],
          ['add', '    start: floor,'],
          ['add', '    end: floor + WINDOW_SECONDS,'],
          ['add', '    label: `${WINDOW_MINUTES} min window from ${floor}`,'],
          ['add', '  };'],
          ['ctx', '}'],
        ],
      },
      {
        section: '',
        expandRows: [
          '',
          '// Callers hand us epoch seconds; nothing in this module takes milliseconds.',
          '',
        ],
        rows: [
          ['add', 'function isWithin(window, epochSeconds) {'],
          ['add', '  return epochSeconds >= window.start && epochSeconds < window.end + GRACE_SECONDS;'],
          ['add', '}'],
          ['add', ''],
          ['add', 'function nextBoundary(epochSeconds) {'],
          ['add', '  return windowFor(epochSeconds).end;'],
          ['add', '}'],
          ['add', ''],
          ['del', 'module.exports = { WINDOW_SECONDS, windowFor };'],
          ['add', 'module.exports = {'],
          ['add', '  WINDOW_SECONDS,'],
          ['add', '  WINDOW_MINUTES,'],
          ['add', '  GRACE_SECONDS,'],
          ['add', '  windowFor,'],
          ['add', '  isWithin,'],
          ['add', '  nextBoundary,'],
          ['add', '};'],
        ],
      },
    ],
  },
  {
    path: 'src/tariff/quote.js',
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        section: '',
        rows: [
          ['ctx', "'use strict';"],
          ['ctx', ''],
          ['del', "const { windowFor } = require('./window');"],
          ['add', "const { windowFor, isWithin } = require('./window');"],
          ['add', "const { TariffCache } = require('./cache');"],
          ['ctx', ''],
          ['add', 'const cache = new TariffCache({ ttlSeconds: 900 });'],
          [
            'pad',
            [
              'const MAX_UNITS = 9999;',
              'const QUOTE_VERSION = 3;',
              "const DEFAULT_CLASS = 'STD';",
              'const PRICE_SCALE = 100;',
              'const LOOKUP_TIMEOUT_MS = 2000;',
            ],
          ],
          ['add', ''],
          ['ctx', 'function round2(value) {'],
          ['ctx', '  return Math.round(value * 100) / 100;'],
          ['ctx', '}'],
          ['add', ''],
          ['add', 'function describeRate(rate) {'],
          ['add', '  return rate.perTonne'],
          ['add', '    ? `${rate.perUnit}/unit (${rate.perTonne}/t)`'],
          ['add', '    : `${rate.perUnit}/unit`;'],
          ['add', '}'],
        ],
      },
      {
        section: '',
        expandRows: [
          '',
          '// One quote per lane, class and window; repeat callers get the cached copy.',
          '',
        ],
        rows: [
          ['del', 'async function quoteFor(laneId, tariffClass, units, table) {'],
          ['del', '  const window = windowFor(Math.floor(Date.now() / 1000));'],
          ['del', '  const rate = await table.lookup(laneId, tariffClass, window.start);'],
          ['del', '  return { laneId, total: round2(units * rate.perUnit), window };'],
          ['add', 'async function quoteFor(laneId, tariffClass, units, table) {'],
          ['add', '  const window = windowFor(Math.floor(Date.now() / 1000));'],
          ['add', '  const cached = cache.get(laneId, tariffClass, window);'],
          ['add', '  if (cached && isWithin(window, cached.pricedAt)) {'],
          ['add', '    return { ...cached, cached: true };'],
          ['add', '  }'],
          ['add', '  const rate = await table.lookup(laneId, tariffClass, window.start);'],
          ['add', '  if (!rate) {'],
          ['add', '    throw new Error(`no tariff for lane ${laneId} class ${tariffClass}`);'],
          ['add', '  }'],
          ['add', '  const quote = {'],
          ['add', '    laneId,'],
          ['add', '    tariffClass,'],
          ['add', '    units,'],
          ['add', '    rate: describeRate(rate),'],
          [
            'add',
            '    total: round2(units * rate.perUnit),',
            'quote-rate',
            '    total: round2(units * rate.perTonne),',
          ],
          ['add', '    window,'],
          ['add', '    pricedAt: Math.floor(Date.now() / 1000),'],
          ['add', '  };'],
          ['add', '  cache.set(laneId, tariffClass, window, quote);'],
          ['add', '  return { ...quote, cached: false };'],
          ['ctx', '}'],
          ['ctx', ''],
          ['del', 'module.exports = { quoteFor };'],
          ['add', 'module.exports = { quoteFor, describeRate, cache };'],
        ],
      },
    ],
  },
];

const FORGE_PAD_MAX = 5;

// Renders the seeded diff for one session: expands each file's filler rows to
// the drawn count, numbers both gutters, builds the @@ headers from the emitted
// row counts, and reports where the drawn defect landed so the validator can
// grade an exact new-side line number it never had to hand-count.
function forgeDiffFor(defectKey, pads = []) {
  let defect = null;
  const files = FORGE_FILES.map((file, fileIndex) => {
    let additions = 0;
    let deletions = 0;
    let padLeft = pads[fileIndex] ?? 0;
    // Collapsed context between hunks is the same run of unchanged lines on both
    // sides, so each hunk's two starts are derived from the previous hunk's ends
    // plus that gap rather than hand-numbered.
    let oldCursor = 0;
    let newCursor = 0;
    const hunks = file.hunks.map((hunk) => {
      const gap = hunk.expandRows ?? [];
      const expand = gap.map((s, i) => ({
        t: 'ctx',
        oldNo: oldCursor + 1 + i,
        newNo: newCursor + 1 + i,
        s,
      }));
      const oldStart = (hunk.oldStart ?? oldCursor + gap.length + 1);
      const newStart = (hunk.newStart ?? newCursor + gap.length + 1);
      let oldNo = oldStart;
      let newNo = newStart;
      let oldCount = 0;
      let newCount = 0;
      const drawn = hunk.rows.flatMap((row) => {
        if (row[0] !== 'pad') return [row];
        const take = Math.min(padLeft, row[1].length);
        padLeft -= take;
        return row[1].slice(0, take).map((s) => ['add', s]);
      });
      const rows = drawn.map(([t, correct, key, buggy]) => {
        const s = key && key === defectKey ? buggy : correct;
        const row = { t, s, oldNo: null, newNo: null };
        if (t !== 'add') {
          row.oldNo = oldNo++;
          oldCount += 1;
        }
        if (t !== 'del') {
          row.newNo = newNo++;
          newCount += 1;
        }
        if (t === 'add') additions += 1;
        if (t === 'del') deletions += 1;
        if (key && key === defectKey) {
          defect = {
            file: file.path,
            line: row.newNo,
            identifier: FORGE_DEFECTS[key].identifier,
            key,
          };
        }
        return row;
      });
      oldCursor = oldNo - 1;
      newCursor = newNo - 1;
      return {
        // Real git omits the count when it is 1 ("@@ -36 +36,2 @@").
        header:
          `@@ -${oldCount === 1 ? oldStart : `${oldStart},${oldCount}`} ` +
          `+${newCount === 1 ? newStart : `${newStart},${newCount}`} @@` +
          (hunk.section ? ` ${hunk.section}` : ''),
        section: hunk.section,
        expand,
        rows,
      };
    });
    return { path: file.path, additions, deletions, hunks };
  });
  return { files, defect };
}

function forgeState(session, modes = {}, draw) {
  if (!session.forge) {
    // One draw per session: which of the four sites is served in its buggy form,
    // and how many filler lines each file carries ahead of its seeded rows.
    // modes.forgeDefect pins the drawn defect (same pattern as auctionDraw) so
    // repeat runs stop comparing tokens across variants of unequal difficulty.
    const drawn = draw('forge', 1 + FORGE_FILES.length);
    const key = FORGE_DEFECT_KEYS.includes(modes.forgeDefect)
      ? modes.forgeDefect
      : FORGE_DEFECT_KEYS[drawn[0] % FORGE_DEFECT_KEYS.length];
    const pads = FORGE_FILES.map((_file, i) => drawn[i + 1] % (FORGE_PAD_MAX + 1));
    const built = forgeDiffFor(key, pads);
    session.forge = {
      key,
      pads,
      files: built.files,
      defect: built.defect,
      diffFetches: 0,
      checkFetches: 0,
      comments: [],
      reviews: [],
      offPage: 0,
    };
  }
  return session.forge;
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, draw } = ctx;
  const fromForge = fromPage('/forge/pulls/482/');
  return async (req, res, url, pathname0) => {
    // Kettleforge PR 482. The diff and the failing check's assertion log are
    // released only through these session-gated reads, so neither the at-fault
    // line nor the symptom text exists under pages/. forgeState() draws the
    // defect site once per session, so the Checks tab and the Files changed tab
    // always describe the same defect.
    if (req.method === 'GET' && pathname0 === '/api/forge/diff') {
      const found = requireSession(req, res);
      if (!found) return;
      const forge = forgeState(found.session, state.modes, draw);
      forge.diffFetches += 1;
      return json(res, 200, {
        pull: FORGE_PULL,
        files: forge.files.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          hunks: file.hunks,
        })),
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/forge/checks') {
      const found = requireSession(req, res);
      if (!found) return;
      const forge = forgeState(found.session, state.modes, draw);
      forge.checkFetches += 1;
      return json(res, 200, {
        headSha: 'c41f9ad',
        checks: [
          { name: 'lint / eslint', status: 'pass', duration: '38s' },
          { name: 'build / node-20', status: 'pass', duration: '1m 12s' },
          { name: 'unit / gateway', status: 'pass', duration: '2m 04s' },
          {
            name: 'unit / tariff',
            status: 'fail',
            duration: '1m 47s',
            failed: 1,
            passed: 213,
            log: FORGE_DEFECTS[forge.key].check,
          },
          { name: 'contract / pact', status: 'skip', duration: '--' },
        ],
      });
    }

    // The session's submitted reviews, for the Conversation tab. Read-only, and
    // it never mints forge state: seeded draws are counted per scope, so a
    // visit here before the diff must not move the session's defect draw.
    if (req.method === 'GET' && pathname0 === '/api/forge/reviews') {
      const found = requireSession(req, res);
      if (!found) return;
      const reviews = found.session.forge?.reviews ?? [];
      return json(res, 200, {
        reviewer: 'r.vandermolen',
        reviews: reviews.map((r) => ({
          id: r.id,
          verdict: r.verdict,
          summary: r.summary,
          comments: r.comments.map((c) => ({ file: c.file, line: c.line, body: c.body })),
        })),
      });
    }

    // A submitted review is the graded artifact: verdict plus the line comments
    // it carries. Recorded on the session (so state.reset() clears it) with a
    // randomBytes review id, and a soft provenance flag for reviews that did not
    // come from the Files changed page.
    if (req.method === 'POST' && pathname0 === '/api/forge/review') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const forge = forgeState(found.session, state.modes, draw);
      if (forge.reviews.length >= SESSION_ROWS || forge.comments.length >= SESSION_ROWS) {
        return json(res, 429, { ok: false, error: 'Review limit reached for this pull request.' });
      }
      const verdict = String(payload?.verdict ?? '').toLowerCase();
      if (!['comment', 'approve', 'changes'].includes(verdict)) {
        return json(res, 400, {
          ok: false,
          error: 'Choose Comment, Approve or Request changes.',
        });
      }
      const raw = Array.isArray(payload?.comments)
        ? payload.comments
        : payload?.file
          ? [{ file: payload.file, line: payload.line, body: payload.body }]
          : [];
      const comments = raw.slice(0, 40).map((c) => ({
        file: String(c?.file ?? '').slice(0, 200),
        line: Number.parseInt(c?.line, 10),
        body: String(c?.body ?? '').slice(0, 2000),
      }));
      if (verdict !== 'approve' && comments.length === 0 && !String(payload?.summary ?? '').trim()) {
        return json(res, 400, {
          ok: false,
          error: 'A review that is not an approval needs a summary or at least one line comment.',
        });
      }
      // Legibility, never proof: curl sets these headers freely.
      const fromPage = fromForge(req);
      if (!fromPage) forge.offPage += 1;
      const review = {
        id: 'RV-' + randomBytes(2).toString('hex').toUpperCase(),
        verdict,
        summary: String(payload?.summary ?? '').slice(0, 2000),
        comments,
        fromPage,
        at: Date.now(),
      };
      forge.reviews.push(review);
      forge.comments.push(...comments);
      return json(res, 200, {
        ok: true,
        reviewId: review.id,
        verdict,
        comments: comments.length,
        state: verdict === 'changes' ? 'Changes requested' : verdict === 'approve' ? 'Approved' : 'Commented',
      });
    }

    return false;
  };
}
