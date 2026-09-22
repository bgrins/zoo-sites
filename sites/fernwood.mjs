// pages/fernwood/ - Fernwood Commons, the neighbourhood feed (feed-needle).
import { randomBytes } from 'node:crypto';
import { pushTrimmed } from './lib.mjs';

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
    body: [
      'From this week the tool library is open Tuesdays and Saturdays, 10 to 2, through the end of August.',
      'The long ladder is back from its adventure on Birchside, and the plant sale paid for a new pair of loppers.',
    ], ref: 'FW-4A02D7', cheers: 9 },
  { author: 'Gus Aldana', when: 'Jun 15', where: 'Old Mill', title: 'Zucchini, free, again',
    body: [
      'The garden has outdone itself again. There is a crate of zucchini on my porch rail at the corner of Mill Lane; take two, take four, but please take them before they turn into marrows.',
    ], ref: 'FW-B3391C', cheers: 21 },
  { author: 'Ida Bergstrom', when: 'Jun 14', where: 'The Green', title: 'Porch concert Friday',
    body: [
      'The Halvorsens are playing fiddle and accordion on their porch this Friday from 7 pm, weather permitting.',
      'Bring a folding chair and something to share. If it rains we move under the bandstand on the Green.',
    ], ref: 'FW-77C4E0', cheers: 14 },
  { author: 'Colm Feeney', when: 'Jun 12', where: 'Birchside', title: 'Grey cat found on Birch',
    body: [
      'A grey cat with white socks turned up in our yard on Birch Street this morning. No collar, very talkative, and clearly used to being fed.',
      'She is safe with us at number 12 for now. If she is yours, knock, or leave a note in the green box.',
    ], ref: 'FW-0D96A4', cheers: 17 },
  { author: 'Renata Kowal', when: 'Jun 10', where: 'Maple Row', title: 'Book swap cart restocked',
    body: [
      'The book swap cart outside the tool library is full again: mostly mysteries this week, plus a stack of old gardening magazines. Take what you like and bring something back when you can.',
    ], ref: 'FW-5E11B8', cheers: 6 },
  { author: 'Priya Raghunathan', when: 'Jun 8', where: 'The Green', title: 'Market moves to the lot',
    body: [
      'From this Saturday the farmers market sets up in the church lot instead of along the Green, and it stays there through August.',
      'Same stalls and the same hours, with a lot more shade for the bread table.',
    ], ref: 'FW-C82F53', cheers: 11 },
  { author: 'Gus Aldana', when: 'Jun 6', where: 'Old Mill', title: 'Mill Lane pothole filled',
    body: [
      'The city crew came on Thursday morning and filled the big pothole at the bottom of Mill Lane. Thanks to everyone who phoned it in; it took eleven calls, but it is done.',
    ], ref: 'FW-19ADF2', cheers: 8 },
  { author: 'Ida Bergstrom', when: 'Jun 4', where: 'Birchside', title: 'Crossing guard thanks',
    body: [
      'Mrs. Oduya is retiring after twenty years at the Birch Street crossing, and the corner will not be the same without her.',
      'There is a card for her at the bakery counter until Friday. Sign it if she ever walked your kids across.',
    ], ref: 'FW-E60B47', cheers: 33 },
  { author: 'Colm Feeney', when: 'May 31', where: 'The Green', title: 'Mural wall repainted',
    body: [
      'The art club has repainted the mural wall behind the community hall. Herons this time, with a very good kingfisher low down on the left. Go and look.',
    ], ref: 'FW-3F78CA', cheers: 19 },
  { author: 'Priya Raghunathan', when: 'May 27', where: 'Maple Row', title: 'Seed swap leftovers',
    body: [
      'Runner beans and calendula are still left over from the seed swap. They are in envelopes at the tool library, free to anyone who will plant them.',
    ], ref: 'FW-A45D09', cheers: 5 },
  { author: 'Renata Kowal', when: 'May 22', where: 'Old Mill', title: 'Rain barrels installed',
    body: [
      'Six new rain barrels went in along the school fence this week, paid for out of the association grant. The school garden club has promised to look after them.',
    ], ref: 'FW-92E6B1', cheers: 12 },
];

function fernwoodMintRefs(n) {
  const refs = new Set();
  while (refs.size < n) {
    refs.add('FW-' + randomBytes(3).toString('hex').toUpperCase());
  }
  return [...refs];
}

function fernwoodState(session, draw) {
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
        title: 'Tally week recap',
        body: [
          'A few people have asked where the creek cleanup numbers ended up.',
          `On the day, the early count from the drop-off points was ${feed.teaser.count} bags. ` +
            "The final tally, once every bin was weighed, is in the coordinators' post further down the feed.",
        ],
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
        body: [
          `Going through the association folder for the newsletter, I found last year's sheet: the 2025 creek tally was ${feed.lookalike.count} bags, in a wet year with a small crew.`,
          "Posting it so we have something to hold this spring's count up against.",
        ],
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
      body: [
        `Every bin from Saturday has now been weighed and counted, and the final tally for this spring's Alder Creek cleanup comes to ${feed.needle.count} bags, the most the association has hauled out of the creek in a single day.`,
        'Thank you to every crew, to the tool library for the grabbers, and to the bakery for keeping us fed. Photos go up at the next association meeting.',
      ],
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
      pushTrimmed(feed.requests, {
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
