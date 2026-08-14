// pages/fernwood/ - Fernwood Commons, the neighbourhood feed (feed-needle).
import { randomBytes } from 'node:crypto';

// The feed is served in four batches by GET /api/fernwood/feed. Batch 1 is
// fetched on page load; each later batch is reachable only through the cursor
// the previous batch handed this session, so the graded tally post - batch 4,
// loaded on the page by the third IntersectionObserver-driven fetch - is only
// ever SERVED to a session that walked the whole chain. Its author, figure and
// FW- reference are minted per session: the author and the three counts from
// the difficulty draw (seedable), the reference and the cursors from
// randomBytes, so nothing the validator grades exists in fixture source.
const FERNWOOD_BATCHES = 4;

const FERNWOOD_NEEDLE_BATCH = 4;

// Coordinators the tally post can be signed by; the draw picks one.
const FERNWOOD_AUTHORS = ['Marisol Vega', 'Ansel Okafor', 'Petra Lindqvist', 'Theo Marchetti'];

// Batch 1 carries a teaser card naming an EARLY count for the same cleanup,
// batch 3 an archive repost of the 2025 tally - the two on-feed decoys the
// wrongFields regressions pin. Their figures are drawn per session too, and
// the ranges keep both apart from the final tally: the early count sits 30-90
// bags below it and the 2025 figure in a disjoint band.
const FERNWOOD_TEASER_AUTHOR = 'Fernwood Commons Team';

const FERNWOOD_LOOKALIKE_AUTHOR = 'Doreen Whitfield';

// Fixed filler posts. Serving them from here rather than from a JSON under
// pages/ keeps the whole feed body off disk; none of it is graded.
const FERNWOOD_FILLER = [
  { author: 'Renata Kowal', when: 'Jun 17', where: 'Maple Row', title: 'Tool library summer hours',
    body: ['Open Tue and Sat, 10 to 2.', 'The ladder is back.'], ref: 'FW-4A02D7', cheers: 9 },
  { author: 'Gus Aldana', when: 'Jun 15', where: 'Old Mill', title: 'Zucchini, free, again',
    body: ['Crate on the porch rail.', 'Take two, please.'], ref: 'FW-B3391C', cheers: 21 },
  { author: 'Ida Bergstrom', when: 'Jun 14', where: 'The Green', title: 'Porch concert Friday',
    body: ['Fiddle and accordion, 7 pm.', 'Bring a folding chair.'], ref: 'FW-77C4E0', cheers: 14 },
  { author: 'Colm Feeney', when: 'Jun 12', where: 'Birchside', title: 'Grey cat found on Birch',
    body: ['No collar, very talkative.', 'Held safe at number 12.'], ref: 'FW-0D96A4', cheers: 17 },
  { author: 'Renata Kowal', when: 'Jun 10', where: 'Maple Row', title: 'Book swap cart restocked',
    body: ['Mostly mysteries this week.'], ref: 'FW-5E11B8', cheers: 6 },
  { author: 'Priya Raghunathan', when: 'Jun 8', where: 'The Green', title: 'Market moves to the lot',
    body: ['Saturdays through August.', 'Same stalls, more shade.'], ref: 'FW-C82F53', cheers: 11 },
  { author: 'Gus Aldana', when: 'Jun 6', where: 'Old Mill', title: 'Mill Lane pothole filled',
    body: ['Crew came Thursday morning.'], ref: 'FW-19ADF2', cheers: 8 },
  { author: 'Ida Bergstrom', when: 'Jun 4', where: 'Birchside', title: 'Crossing guard thanks',
    body: ['Twenty years at the corner.', 'Card at the bakery counter.'], ref: 'FW-E60B47', cheers: 33 },
  { author: 'Colm Feeney', when: 'May 31', where: 'The Green', title: 'Mural wall repainted',
    body: ['Herons this time. Go look.'], ref: 'FW-3F78CA', cheers: 19 },
  { author: 'Priya Raghunathan', when: 'May 27', where: 'Maple Row', title: 'Seed swap leftovers',
    body: ['Beans and calendula left.'], ref: 'FW-A45D09', cheers: 5 },
  { author: 'Renata Kowal', when: 'May 22', where: 'Old Mill', title: 'Rain barrels installed',
    body: ['Six along the school fence.'], ref: 'FW-92E6B1', cheers: 12 },
];

function fernwoodMintRefs(n) {
  const refs = new Set();
  while (refs.size < n) {
    refs.add('FW-' + randomBytes(3).toString('hex').toUpperCase());
  }
  return [...refs];
}

function fernwoodState(session, draw = (_scope, n) => randomBytes(n)) {
  if (!session.fernwood) {
    const bytes = draw('fernwood', 4);
    const needleCount = 300 + (bytes[0] * 256 + bytes[1]) % 200;
    const [needleRef, teaserRef, lookalikeRef] = fernwoodMintRefs(3);
    session.fernwood = {
      needle: {
        author: FERNWOOD_AUTHORS[bytes[2] % FERNWOOD_AUTHORS.length],
        count: needleCount,
        ref: needleRef,
      },
      teaser: {
        author: FERNWOOD_TEASER_AUTHOR,
        count: needleCount - (30 + bytes[3] % 61),
        ref: teaserRef,
      },
      lookalike: {
        author: FERNWOOD_LOOKALIKE_AUTHOR,
        count: 200 + (bytes[2] * 256 + bytes[3]) % 90,
        ref: lookalikeRef,
      },
      cursors: {
        2: randomBytes(6).toString('hex'),
        3: randomBytes(6).toString('hex'),
        4: randomBytes(6).toString('hex'),
      },
      // { batch, via, y, at } for every batch actually served - route
      // telemetry for the detail line (via/y are client-named: legibility,
      // never proof).
      requests: [],
      maxBatch: 0,
      badCursor: 0,
    };
  }
  return session.fernwood;
}

function fernwoodPost(p) {
  return {
    author: p.author,
    when: p.when,
    where: p.where,
    title: p.title,
    body: p.body,
    ref: p.ref,
    cheers: p.cheers,
  };
}

function fernwoodBatchPosts(feed, batch) {
  const f = FERNWOOD_FILLER;
  if (batch === 1) {
    return [
      fernwoodPost(f[0]),
      {
        author: feed.teaser.author, when: 'Jun 16', where: 'The Green',
        title: 'Tally week on the feed',
        body: [`Early count: ${feed.teaser.count} bags`, 'Final tally posts below.'],
        ref: feed.teaser.ref, cheers: 26,
      },
      fernwoodPost(f[1]),
      fernwoodPost(f[2]),
    ];
  }
  if (batch === 2) return [f[3], f[4], f[5], f[6]].map(fernwoodPost);
  if (batch === 3) {
    return [
      fernwoodPost(f[7]),
      {
        author: feed.lookalike.author, when: 'Jun 2', where: 'Fernwood Archive',
        title: 'From the archive: 2025 tally',
        body: [`2025 creek tally: ${feed.lookalike.count} bags`, 'A wet year, a good crew.'],
        ref: feed.lookalike.ref, cheers: 15,
      },
      fernwoodPost(f[8]),
    ];
  }
  return [
    fernwoodPost(f[9]),
    {
      author: feed.needle.author, when: 'May 24', where: 'Alder Creek',
      title: 'Creek cleanup: final tally',
      body: [`Final tally: ${feed.needle.count} bags`, 'Thank you, every crew.'],
      ref: feed.needle.ref, cheers: 48,
    },
    fernwoodPost(f[10]),
  ];
}

export function routes(ctx) {
  const { json, requireSession, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // feed-needle: the batch API behind pages/fernwood/. Batches past the
    // first need the cursor the previous batch handed THIS session, so the
    // tally post cannot be jumped to; a request that names a stale or guessed
    // cursor is refused and counted.
    if (req.method === 'GET' && pathname0 === '/api/fernwood/feed') {
      const found = requireSession(req, res);
      if (!found) return;
      const feed = fernwoodState(found.session, draw);
      const batch = Number(url.searchParams.get('batch'));
      if (!Number.isInteger(batch) || batch < 1 || batch > FERNWOOD_BATCHES) {
        return json(res, 400, { error: 'no such batch' });
      }
      if (batch > 1 && url.searchParams.get('cursor') !== feed.cursors[batch]) {
        feed.badCursor += 1;
        return json(res, 400, { error: 'bad or missing cursor' });
      }
      const y = Number(url.searchParams.get('y'));
      feed.requests.push({
        batch,
        via: (url.searchParams.get('via') ?? '').slice(0, 24) || null,
        y: Number.isFinite(y) ? Math.round(y) : null,
        at: Date.now(),
      });
      feed.maxBatch = Math.max(feed.maxBatch, batch);
      return json(res, 200, {
        batch,
        posts: fernwoodBatchPosts(feed, batch),
        next:
          batch < FERNWOOD_BATCHES
            ? { batch: batch + 1, cursor: feed.cursors[batch + 1] }
            : null,
        caughtUp: batch === FERNWOOD_BATCHES,
      });
    }

    return false;
  };
}
