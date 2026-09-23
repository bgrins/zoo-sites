// pages/fernwood/ - Fernwood Commons, the neighbourhood feed (feed-needle).
import { randomBytes } from 'node:crypto';
import { pushTrimmed } from './lib.mjs';

// The feed is served in eight batches by GET /api/fernwood/feed. Batch 1 is
// fetched on page load; each later batch is reachable only through the cursor
// the previous batch handed this session, so the graded tally post - batch 4,
// loaded on the page by the third IntersectionObserver-driven fetch - is only
// ever SERVED to a session that walked the whole chain that far. Its author,
// figure and FW- reference are minted per session: the author and the three
// counts from the difficulty draw (seedable), the reference and the cursors
// from randomBytes, so nothing the validator grades exists in fixture source.
const FERNWOOD_BATCHES = 8;

const FERNWOOD_NEEDLE_BATCH = 4;

// Coordinators the tally post can be signed by; the draw picks one.
const FERNWOOD_AUTHORS = ['Marisol Vega', 'Ansel Okafor', 'Petra Lindqvist', 'Theo Marchetti'];

// Batch 1 carries a teaser card naming an EARLY count for the same cleanup,
// batch 3 an archive repost of the 2025 tally - the two on-feed decoys the
// wrongFields regressions pin. Their figures are drawn per session too, and
// the ranges keep both apart from the final tally: the early count sits 30-90
// bags below it and the 2025 figure in a disjoint band. No other post or reply
// names a bag count.
const FERNWOOD_TEASER_AUTHOR = 'Fernwood Commons Team';

const FERNWOOD_LOOKALIKE_AUTHOR = 'Doreen Whitfield';

const FERNWOOD_TEASER_REPLIES = [
  { author: 'Colm Feeney', when: '16 Jun', body: 'Thanks for chasing it up. Birchside crew are keen to see the final figure.' },
];

const FERNWOOD_NEEDLE_REPLIES = [
  { author: 'Ida Bergstrom', when: '24 May', body: 'Brilliant effort, all of you. The creek looks like a different place.' },
  { author: 'Gus Aldana', when: '25 May', body: 'Our lot from Old Mill are already asking when the autumn one is.' },
  { author: 'Renata Kowal', when: '25 May', body: 'Grabbers are all back on their hooks at the tool library. Thank you for returning them clean.' },
];

const FERNWOOD_LOOKALIKE_REPLIES = [
  { author: 'Priya Raghunathan', when: '2 Jun', body: 'I remember that one. We were soaked by ten.' },
];

// Fixed filler posts, newest first. Serving them from here rather than from a
// JSON under pages/ keeps the whole feed body off disk; none of it is graded.
const FERNWOOD_FILLER = [
  { author: 'Renata Kowal', when: '17 Jun', where: 'Maple Row', title: 'Tool library summer hours',
    body: [
      'From this week the tool library is open Tuesdays and Saturdays, 10 to 2, through to the end of August.',
      'The long ladder is back from its adventure on Birchside, and the plant sale paid for a new pair of loppers.',
    ], ref: 'FW-4A02D7', cheers: 9,
    replies: [
      { author: 'Colm Feeney', when: '17 Jun', body: 'Could the hedge trimmer stay out till Sunday on a long weekend? Asking for the whole of Birch Street.' },
      { author: 'Renata Kowal', when: '18 Jun', body: 'Colm, yes, if it is booked by Friday.' },
    ] },
  { author: 'Gus Aldana', when: '15 Jun', where: 'Old Mill', title: 'Courgettes, free, again',
    body: [
      'The allotment has outdone itself again. There is a crate of courgettes on my front wall at the corner of Mill Lane; take two, take four, but please take them before they turn into marrows.',
    ], ref: 'FW-B3391C', cheers: 21,
    replies: [
      { author: 'Ida Bergstrom', when: '15 Jun', body: 'Took three. Courgette soup on the Green tonight.' },
      { author: 'Priya Raghunathan', when: '15 Jun', body: 'Is the yellow one a courgette or a squash? Asking before I cook it.' },
      { author: 'Gus Aldana', when: '16 Jun', body: 'Courgette, Priya. The squash come in September.' },
    ] },
  { author: 'Ida Bergstrom', when: '14 Jun', where: 'The Green', title: 'Porch concert Friday',
    body: [
      'The Halvorsens are playing fiddle and accordion on their porch this Friday from 7 pm, weather permitting.',
      'Bring a folding chair and something to share. If it rains we move under the bandstand on the Green.',
    ], ref: 'FW-77C4E0', cheers: 14, replies: [] },
  { author: 'Colm Feeney', when: '12 Jun', where: 'Birchside', title: 'Grey cat found on Birch',
    body: [
      'A grey cat with white socks turned up in our garden on Birch Street this morning. No collar, very talkative, and clearly used to being fed.',
      'She is safe with us at number 12 for now. If she is yours, knock, or leave a note in the green box.',
    ], ref: 'FW-0D96A4', cheers: 17,
    replies: [
      { author: 'Priya Raghunathan', when: '12 Jun', body: 'She has been doing the rounds on Maple Row too. Very keen on the bakery bins.' },
      { author: 'Colm Feeney', when: '13 Jun', body: 'Still no knock at the door. She has claimed the armchair in the meantime.' },
    ] },
  { author: 'Renata Kowal', when: '10 Jun', where: 'Maple Row', title: 'Book swap trolley restocked',
    body: [
      'The book swap trolley outside the tool library is full again: mostly mysteries this week, plus a stack of old gardening magazines. Take what you like and bring something back when you can.',
    ], ref: 'FW-5E11B8', cheers: 6, replies: [] },
  { author: 'Priya Raghunathan', when: '8 Jun', where: 'The Green', title: 'Market moves to the car park',
    body: [
      "From this Saturday the farmers' market sets up in the church car park instead of along the Green, and it stays there through August.",
      'Same stalls and the same hours, with a lot more shade for the bread table.',
    ], ref: 'FW-C82F53', cheers: 11,
    replies: [
      { author: 'Gus Aldana', when: '8 Jun', body: 'Does the egg stall come too?' },
      { author: 'Priya Raghunathan', when: '9 Jun', body: 'It does, Gus. Same corner, by the lychgate.' },
    ] },
  { author: 'Gus Aldana', when: '6 Jun', where: 'Old Mill', title: 'Mill Lane pothole filled',
    body: [
      'The council crew came on Thursday morning and filled the big pothole at the bottom of Mill Lane. Thanks to everyone who phoned it in; it took eleven calls, but it is done.',
    ], ref: 'FW-19ADF2', cheers: 8, replies: [] },
  { author: 'Ida Bergstrom', when: '4 Jun', where: 'Birchside', title: 'Thank you, Mrs Oduya',
    body: [
      'Mrs Oduya is retiring after twenty years as lollipop lady at the Birch Street crossing, and the corner will not be the same without her.',
      'There is a card for her at the bakery counter until Friday. Sign it if she ever walked your children across.',
    ], ref: 'FW-E60B47', cheers: 33,
    replies: [
      { author: 'Renata Kowal', when: '4 Jun', body: 'She walked both of mine across, and then their friends. Signed.' },
      { author: 'Colm Feeney', when: '5 Jun', body: 'The school is doing a proper send-off on her last Friday at 3.' },
    ] },
  { author: 'Colm Feeney', when: '31 May', where: 'The Green', title: 'Mural wall repainted',
    body: [
      'The art club has repainted the mural wall behind the community hall. Herons this time, with a very good kingfisher low down on the left. Go and look.',
    ], ref: 'FW-3F78CA', cheers: 19, replies: [] },
  { author: 'Priya Raghunathan', when: '27 May', where: 'Maple Row', title: 'Seed swap leftovers',
    body: [
      'Runner beans and calendula are still left over from the seed swap. They are in envelopes at the tool library, free to anyone who will plant them.',
    ], ref: 'FW-A45D09', cheers: 5, replies: [] },
  { author: 'Renata Kowal', when: '22 May', where: 'Old Mill', title: 'Water butts installed',
    body: [
      'Six new water butts went in along the school fence this week, paid for out of the association grant. The school garden club has promised to look after them.',
    ], ref: 'FW-92E6B1', cheers: 12, replies: [] },
  { author: 'Colm Feeney', when: '20 May', where: 'The Green', title: 'Hedgehog house by the bandstand',
    body: [
      'Year 5 built a hedgehog house in their woodwork sessions, and it now sits under the holly by the bandstand.',
      'Please keep dogs on leads round that corner for a few weeks while it settles in.',
    ], ref: 'FW-6C0E91', cheers: 27,
    replies: [
      { author: 'Ida Bergstrom', when: '20 May', body: 'Saw one trundling past the hall steps last night, so word is out.' },
    ] },
  { author: 'Priya Raghunathan', when: '18 May', where: 'Maple Row', title: 'Lost: blue scooter helmet',
    body: [
      'A small blue scooter helmet with dinosaur stickers went missing between the school gate and Maple Row on Friday afternoon.',
      'If it turns up, the green box outside the tool library will do nicely.',
    ], ref: 'FW-D1473B', cheers: 3, replies: [] },
  { author: 'Gus Aldana', when: '16 May', where: 'Old Mill', title: 'Creek cleanup: crews wanted',
    body: [
      'The spring cleanup of Alder Creek is next Saturday. Crews meet at the footbridge at 9 and work down to the weir; gloves and grabbers come from the tool library.',
      'Wellies are the one thing we cannot lend. Put your name down at the bakery counter so the coordinators know how many crews to plan for.',
    ], ref: 'FW-28F5AC', cheers: 22,
    replies: [
      { author: 'Renata Kowal', when: '16 May', body: 'Tool library will open at 8 on the day for anyone collecting grabbers.' },
      { author: 'Colm Feeney', when: '17 May', body: 'Birchside is sending two crews. We will bring the tea urn.' },
    ] },
  { author: 'Ida Bergstrom', when: '14 May', where: 'The Green', title: 'Bunting back on the bandstand',
    body: [
      'The bunting from the hall cupboard is up on the bandstand again. Two strings are torn; if anyone has a sewing machine and a free evening, they are on the hall piano.',
    ], ref: 'FW-F90B26', cheers: 7, replies: [] },
  { author: 'Renata Kowal', when: '11 May', where: 'Maple Row', title: 'A second strimmer',
    body: [
      'Thanks to the plant sale the tool library has a second strimmer. It lives on the left-hand hook, and its charger lives in the drawer below, where it will stay if everyone is kind.',
    ], ref: 'FW-3B6D48', cheers: 10, replies: [] },
  { author: 'Colm Feeney', when: '9 May', where: 'Birchside', title: 'The swifts are back',
    body: [
      'Two pairs of swifts are back under the eaves of the old chapel on Birchside. The boxes the association put up last spring have their first tenants.',
    ], ref: 'FW-A70C5E', cheers: 24,
    replies: [
      { author: 'Priya Raghunathan', when: '9 May', body: 'Heard them screaming over the Green at dusk. Summer is here.' },
    ] },
  { author: 'Priya Raghunathan', when: '7 May', where: 'The Green', title: 'Quiz night at the hall',
    body: [
      'Quiz night at the community hall is on the last Friday of the month. Teams of up to six, doors at 7, and the kitchen is doing jacket potatoes.',
    ], ref: 'FW-5D2E17', cheers: 13, replies: [] },
  { author: 'Gus Aldana', when: '5 May', where: 'Old Mill', title: 'Mill race footpath reopened',
    body: [
      'The footpath along the mill race is open again after the winter repairs. The new boardwalk by the sluice is a lot less bouncy than the old one.',
    ], ref: 'FW-C4491A', cheers: 16, replies: [] },
  { author: 'Ida Bergstrom', when: '2 May', where: 'Birchside', title: 'Bin day after the bank holiday',
    body: [
      'With Monday a bank holiday, Birchside and Maple Row bins go out on Tuesday this week. The garden waste round runs a day behind too.',
    ], ref: 'FW-19E7D0', cheers: 4, replies: [] },
  { author: 'Renata Kowal', when: '30 Apr', where: 'Maple Row', title: 'Plant sale: thank you',
    body: [
      'The plant sale cleared every tray by lunchtime. Thank you to everyone who potted up cuttings over the winter, and to the school for the loan of their trestle tables.',
    ], ref: 'FW-8E3B72', cheers: 18,
    replies: [
      { author: 'Gus Aldana', when: '30 Apr', body: 'The tomato seedlings went in ten minutes. Next year, twice as many.' },
    ] },
  { author: 'Colm Feeney', when: '27 Apr', where: 'The Green', title: 'Found: house keys by the bench',
    body: [
      'A set of house keys on a red lanyard was left on the bench by the war memorial. They are behind the bakery counter; describe the keyring to claim them.',
    ], ref: 'FW-0F6A93', cheers: 2, replies: [] },
  { author: 'Priya Raghunathan', when: '24 Apr', where: 'Old Mill', title: 'Two allotment plots free',
    body: [
      'Two plots on the Old Mill allotments have come free. The waiting list is kept by the allotment society, not the association, so write to them rather than to the stewards.',
    ], ref: 'FW-B8C215', cheers: 9, replies: [] },
  { author: 'Gus Aldana', when: '21 Apr', where: 'Old Mill', title: 'Duck race is back',
    body: [
      'The duck race on the mill race is back for the summer fair in July. Ducks are a pound each from the bakery, and every penny goes to the hall roof.',
    ], ref: 'FW-4D9F60', cheers: 15, replies: [] },
  { author: 'Ida Bergstrom', when: '18 Apr', where: 'The Green', title: 'Hall spring clean done',
    body: [
      "Many hands made light work of the hall's spring clean. The stage curtains are back up, and the piano has been tuned for the first time in three years.",
    ], ref: 'FW-E2A847', cheers: 11, replies: [] },
  { author: 'Renata Kowal', when: '15 Apr', where: 'Maple Row', title: 'Tool library needs volunteers',
    body: [
      'The tool library needs two more volunteers for the Saturday shift. It is mostly signing things out and back in, and the kettle is included.',
    ], ref: 'FW-7A1C3D', cheers: 6,
    replies: [
      { author: 'Priya Raghunathan', when: '15 Apr', body: 'I can do alternate Saturdays from May.' },
    ] },
  { author: 'Colm Feeney', when: '11 Apr', where: 'Birchside', title: 'Streetlight out on Birch Street',
    body: [
      'The streetlight outside number 30 has been out for a week. I have reported it to the council; if you walk that way after dark, take a torch.',
    ], ref: 'FW-93B05E', cheers: 5, replies: [] },
];

const FERNWOOD_FIXED_REFS = new Set(FERNWOOD_FILLER.map((p) => p.ref));

function fernwoodMintRefs(n) {
  const refs = new Set();
  while (refs.size < n) {
    const ref = 'FW-' + randomBytes(3).toString('hex').toUpperCase();
    if (!FERNWOOD_FIXED_REFS.has(ref)) refs.add(ref);
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
      cursors: Object.fromEntries(
        Array.from({ length: FERNWOOD_BATCHES - 1 }, (_, i) => [i + 2, randomBytes(6).toString('hex')])
      ),
      // { batch, via, y, at } for every batch actually served - route
      // telemetry for the detail line (via/y are client-named: legibility,
      // never proof).
      requests: [],
      maxBatch: 0,
      badCursor: 0,
      // Ungraded: the refs this session has cheered, one key per served post.
      cheered: {},
    };
  }
  return session.fernwood;
}

// A post as the feed and the permalink page receive it. The cheer count
// includes this session's own cheer.
function fernwoodPost(p, feed) {
  const cheered = feed.cheered?.[p.ref] === true;
  return {
    author: p.author,
    when: p.when,
    where: p.where,
    title: p.title,
    body: p.body,
    ref: p.ref,
    cheers: p.cheers + (cheered ? 1 : 0),
    cheered,
    replies: p.replies.length,
  };
}

// Every post in a batch, with its replies. Batches 1 to 4 carry the three
// minted posts; batches 5 to 8 are older filler, four posts each.
function fernwoodBatch(feed, batch) {
  const f = FERNWOOD_FILLER;
  if (batch === 1) {
    return [
      f[0],
      {
        author: feed.teaser.author, when: '16 Jun', where: 'The Green',
        title: 'Tally week recap',
        body: [
          'A few people have asked where the creek cleanup numbers ended up.',
          `On the day, the early count from the drop-off points was ${feed.teaser.count} bags. ` +
            "The final tally, once every bin was weighed, is in the coordinators' post further down the feed.",
        ],
        ref: feed.teaser.ref, cheers: 26, replies: FERNWOOD_TEASER_REPLIES,
      },
      f[1],
      f[2],
    ];
  }
  if (batch === 2) return [f[3], f[4], f[5], f[6]];
  if (batch === 3) {
    return [
      f[7],
      {
        author: feed.lookalike.author, when: '2 Jun', where: 'Fernwood Archive',
        title: 'From the archive: 2025 tally',
        body: [
          `Going through the association folder for the newsletter, I found last year's sheet: the 2025 creek tally was ${feed.lookalike.count} bags, in a wet year with a small crew.`,
          "Posting it so we have something to hold this spring's count up against.",
        ],
        ref: feed.lookalike.ref, cheers: 15, replies: FERNWOOD_LOOKALIKE_REPLIES,
      },
      f[8],
    ];
  }
  if (batch === FERNWOOD_NEEDLE_BATCH) {
    return [
      f[9],
      {
        author: feed.needle.author, when: '24 May', where: 'Alder Creek',
        title: 'Creek cleanup: final tally',
        body: [
          `Every bin from Saturday has now been weighed and counted, and the final tally for this spring's Alder Creek cleanup comes to ${feed.needle.count} bags, the most the association has hauled out of the creek in a single day.`,
          'Thank you to every crew, to the tool library for the grabbers, and to the bakery for keeping us fed. Photos go up at the next association meeting.',
        ],
        ref: feed.needle.ref, cheers: 48, replies: FERNWOOD_NEEDLE_REPLIES,
      },
      f[10],
    ];
  }
  const from = 11 + (batch - 5) * 4;
  return f.slice(from, from + 4);
}

// The post with this ref among the batches this session has been served, or
// null: the permalink page reaches no post the cursor chain has not.
function fernwoodServed(feed, ref) {
  for (let batch = 1; batch <= feed.maxBatch; batch++) {
    const post = fernwoodBatch(feed, batch).find((p) => p.ref === ref);
    if (post) return post;
  }
  return null;
}

export function routes(ctx) {
  const { json, readJson, requireSession, draw } = ctx;
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
        posts: fernwoodBatch(feed, batch).map((p) => fernwoodPost(p, feed)),
        next:
          batch < FERNWOOD_BATCHES
            ? { batch: batch + 1, cursor: feed.cursors[batch + 1] }
            : null,
        caughtUp: batch === FERNWOOD_BATCHES,
      });
    }

    // Ungraded: a post's permalink page. It serves no batch, so it leaves
    // maxBatch, the validator's gate, where the feed put it.
    if (req.method === 'GET' && pathname0 === '/api/fernwood/thread') {
      const found = requireSession(req, res);
      if (!found) return;
      const feed = fernwoodState(found.session, draw);
      const post = fernwoodServed(feed, String(url.searchParams.get('ref') ?? '').toUpperCase());
      if (!post) return json(res, 404, { error: 'That post is not on the Commons.' });
      return json(res, 200, { post: fernwoodPost(post, feed), replies: post.replies });
    }

    // Ungraded: a cheer toggles on a served post.
    if (req.method === 'POST' && pathname0 === '/api/fernwood/cheer') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload.nonce);
      if (!found) return;
      const feed = fernwoodState(found.session, draw);
      const post = fernwoodServed(feed, String(payload.ref ?? '').toUpperCase());
      if (!post) return json(res, 404, { error: 'That post is not on the Commons.' });
      feed.cheered ??= {};
      if (feed.cheered[post.ref]) delete feed.cheered[post.ref];
      else feed.cheered[post.ref] = true;
      const view = fernwoodPost(post, feed);
      return json(res, 200, { ref: view.ref, cheered: view.cheered, cheers: view.cheers });
    }

    return false;
  };
}
