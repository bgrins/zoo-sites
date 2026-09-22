// Golden path for the Fernwood Commons neighbourhood feed
// (pages/fernwood/, task feed-needle). See probes.mjs for the contract.
import { addSession, bumpCode, clickToPath, esc, findSession, straySession, uidOf, until } from './lib.mjs';

const FEED_NEEDLE_TITLE = 'Creek cleanup: final tally';

// The coordinators the per-session draw can sign the tally post with; used
// only to assert the fixture precondition still holds.
const FEED_AUTHORS = ['Marisol Vega', 'Ansel Okafor', 'Petra Lindqvist', 'Theo Marchetti'];

// Every rendered card, read from the DOM. The post bodies are written the way
// neighbours write, so the figures sit mid-sentence past the snapshot's text
// cap; whether a surface still delivers them is what feed-needle reports, so
// the driver reads them with evaluate rather than demanding it.
const readCards = (evaluate) =>
  evaluate(() =>
    [...document.querySelectorAll('article.card')].map((c) => ({
      author: c.querySelector('.name')?.textContent ?? '',
      avatar: c.querySelector('span.avatar')?.textContent ?? null,
      title: c.querySelector('h1, h2')?.textContent ?? '',
      body: [...c.querySelectorAll('p')].map((p) => p.textContent).join(' '),
      ref: /Ref (FW-[0-9A-F]{6})/.exec(c.querySelector('.cardfoot')?.textContent ?? '')?.[1] ?? null,
    }))
  );

function feedCard(cards, bodyRe) {
  const card = cards.find((c) => bodyRe.test(c.body));
  if (!card || !card.ref) return null;
  const count = Number(bodyRe.exec(card.body)[1]);
  return Number.isFinite(count) ? { author: card.author, count, ref: card.ref } : null;
}

const NEEDLE_RE = /final tally for this spring's Alder Creek cleanup comes to (\d+) bags/;
const TEASER_RE = /early count from the drop-off points was (\d+) bags/;
const LOOKALIKE_RE = /2025 creek tally was (\d+) bags/;

export const DRIVERS = {
  'feed-needle': {
    note:
      'scrolls with evaluate window.scrollTo (no scroll tool exists) so each sentinel ' +
      'IntersectionObserver fires, and reads the cards with evaluate: the tally figure sits ' +
      'mid-sentence in a neighbour-written post, past the snapshot text cap; first cheers ' +
      'the top card on its permalink page, an ungraded control',
    wrong:
      'The final tally post is by Fernwood Commons Team: 238 bags. ' +
      'Its reference code is FW-000000.',
    alsoCorrectState: [
      {
        name: 'a stray session minted first reads batch 1 of its own feed',
        mutate(state) {
          const { session } = findSession(state, (s) => s.fernwood);
          const f = session.fernwood;
          const other = (post) => ({ ...post, ref: bumpCode(post.ref), count: post.count + 1 });
          addSession(
            state,
            {
              fernwood: {
                ...f,
                needle: other(f.needle),
                teaser: other(f.teaser),
                lookalike: other(f.lookalike),
                requests: [{ batch: 1, via: null, y: null, at: Date.now() }],
                maxBatch: 1,
                badCursor: 0,
              },
            },
            { first: true }
          );
        },
      },
    ],
    async run({ base, goto, evaluate, mcp, snapshot }, ctx) {
      await goto('/fernwood/');
      const status = () => evaluate(() => document.getElementById('status')?.textContent ?? '');
      // Batch 1 renders from the session-gated fetch; poll for the teaser card.
      let cards = [];
      const firstBatch = () =>
        until('the batch-1 teaser card to render', async () => {
          cards = await readCards(evaluate);
          return cards.some((c) => TEASER_RE.test(c.body));
        });
      await firstBatch();
      const initialsOf = (name) =>
        name
          .split(' ')
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
      const unchipped = cards.find((c) => c.avatar !== initialsOf(c.author));
      if (unchipped) throw new Error(`${unchipped.author}'s card has avatar ${JSON.stringify(unchipped.avatar)}`);
      // Off the graded path: the first card's date opens its own page, where a
      // cheer registers with the server and survives the trip back to the feed.
      const [top] = cards;
      const topDate = await evaluate(() => document.querySelector('article.card .meta a')?.textContent ?? '');
      await clickToPath(
        mcp,
        evaluate,
        async () => uidOf(await snapshot(), `a "${esc(topDate)}"`),
        `post.html?ref=${top.ref}`,
        "the top card's permalink"
      );
      const post = await until('the permalink page to render its post', async () => {
        const [card] = await readCards(evaluate);
        return card?.ref === top.ref ? card : null;
      });
      if (post.title !== top.title || post.author !== top.author) {
        throw new Error(`the permalink page renders another post: ${JSON.stringify(post)}`);
      }
      const cheers = () =>
        evaluate(() => ({
          pressed: document.querySelector('article.card .cheer')?.getAttribute('aria-pressed') ?? null,
          count: parseInt(document.querySelector('article.card .cheers')?.textContent ?? '', 10),
        }));
      const before = await cheers();
      if (before.pressed !== 'false') throw new Error(`the post starts cheered: ${JSON.stringify(before)}`);
      const cheerUid = uidOf(await snapshot(), 'button "Cheer"');
      if (!cheerUid) throw new Error('no Cheer button on the permalink page');
      await mcp('click_by_uid', { uid: cheerUid });
      const after = await until('the cheer to register', async () => {
        const now = await cheers();
        return now.pressed === 'true' ? now : null;
      });
      if (after.count !== before.count + 1) {
        throw new Error(`a cheer moved the count from ${before.count} to ${after.count}`);
      }
      await goto('/fernwood/');
      await firstBatch();
      const kept = await cheers();
      if (kept.pressed !== 'true' || kept.count !== after.count) {
        throw new Error(`the feed lost the cheer: ${JSON.stringify(kept)}`);
      }
      const teaser = feedCard(cards, TEASER_RE);
      if (!teaser) throw new Error('the batch-1 teaser card never rendered');
      if (cards.some((c) => c.title === FEED_NEEDLE_TITLE)) {
        throw new Error('the tally post is visible before any scrolling');
      }
      // Older batches load when the sentinel enters the viewport: scroll to the
      // bottom, wait for the feed to grow (never a fixed sleep), repeat.
      let caughtUp = /all caught up/.test(await status());
      let seen = cards.length;
      for (let i = 0; i < 12 && !caughtUp; i++) {
        await evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        await until('scrolling to load another batch', async () => {
          cards = await readCards(evaluate);
          if (/all caught up/.test(await status())) {
            caughtUp = true;
            return true;
          }
          if (cards.length > seen) {
            seen = cards.length;
            return true;
          }
          return false;
        }, { tries: 40, gap: 200 });
      }
      if (!caughtUp) throw new Error('the feed never reached its last batch');
      cards = await readCards(evaluate);
      if (cards.length !== 30) throw new Error(`the full feed holds ${cards.length} posts, not 30`);
      const needle = feedCard(cards, NEEDLE_RE);
      if (!needle) throw new Error('the tally card is missing from the full feed');
      if (cards.find((c) => c.ref === needle.ref)?.title !== FEED_NEEDLE_TITLE) {
        throw new Error('the tally figure is not on the final-tally post');
      }
      if (!FEED_AUTHORS.includes(needle.author)) {
        throw new Error(`unexpected tally author "${needle.author}"`);
      }
      // The two on-feed decoys the wrongFields pin must still be present and
      // must still disagree with the graded figure, or the regressions below
      // assert nothing.
      const lookalike = feedCard(cards, LOOKALIKE_RE);
      if (!lookalike) throw new Error('the archive lookalike card is missing');
      if (teaser.count === needle.count || lookalike.count === needle.count) {
        throw new Error('a decoy count collides with the final tally');
      }
      // The permalink page reads through the same session: the tally post
      // answers once the feed has served it.
      const permalink = await evaluate(`() => {
        const card = [...document.querySelectorAll('article.card')]
          .find((c) => (c.querySelector('.cardfoot')?.textContent ?? '').includes(${JSON.stringify(needle.ref)}));
        return card?.querySelector('.meta a')?.getAttribute('href') ?? null;
      }`);
      if (permalink !== `post.html?ref=${needle.ref}`) {
        throw new Error(`the tally card's permalink is ${permalink}`);
      }
      const read = await evaluate(`async () => {
        const r = await fetch('/api/fernwood/thread?ref=${needle.ref}', { headers: { 'X-Session-Nonce': NONCE } });
        return { status: r.status, post: r.ok ? (await r.json()).post : null };
      }`);
      if (read.status !== 200 || read.post?.author !== needle.author || !NEEDLE_RE.test(read.post.body.join(' '))) {
        throw new Error(`the tally post's permalink answered ${JSON.stringify(read)}`);
      }
      // A post read serves no batch, so the permalink is no way around the
      // cursor chain the validator's gate counts.
      const stray = await straySession(base, '/fernwood/', { reply: 'response' });
      await stray.get('/api/fernwood/feed?batch=1');
      const served = await stray.get('/api/fernwood/thread?ref=FW-4A02D7');
      const unserved = await stray.get('/api/fernwood/thread?ref=FW-A45D09');
      const strayFeed = ctx.pages.state.sessions.get(stray.sid)?.fernwood;
      if (served.status !== 200 || unserved.status !== 404 || strayFeed?.maxBatch !== 1) {
        throw new Error(
          `the post API answered ${served.status} for a served post and ${unserved.status} for a ` +
            `batch-4 post never served, leaving the session at batch ${strayFeed?.maxBatch}`
        );
      }
      const bumped = bumpCode(needle.ref);
      const fields = {
        posterName: needle.author,
        bagCount: needle.count,
        postRef: needle.ref,
      };
      this.wrongFields = [
        // The batch-1 teaser: right topic, early figure, never the tally post.
        { posterName: teaser.author, bagCount: teaser.count, postRef: teaser.ref },
        // The archive repost of the 2025 tally.
        { posterName: lookalike.author, bagCount: lookalike.count, postRef: lookalike.ref },
        // The right post with its reference bumped by one character.
        { posterName: needle.author, bagCount: needle.count, postRef: bumped },
        // The right post quoted with the teaser's early figure.
        { posterName: needle.author, bagCount: teaser.count, postRef: needle.ref },
      ];
      this.alsoCorrectFields = [
        fields,
        {
          posterName: needle.author.split(' ').reverse().join(', '),
          bagCount: needle.count,
          postRef: needle.ref.toLowerCase(),
        },
        {
          posterName: needle.author.toUpperCase(),
          bagCount: needle.count,
          postRef: needle.ref.replace('-', ' '),
        },
      ];
      // The 2026-09-20 haiku playwright-mcp answer, re-minted with this run's
      // values: the extractor took postRef's value from the answer and its
      // quote from the ask.
      const rowAnswer = (ref) =>
        `Perfect! I found the post I was looking for. Let me extract the information:\n\n` +
        `- **Neighbour name**: ${needle.author}\n- **Final tally**: ${needle.count} bags\n` +
        `- **Reference code**: ${ref}\n` +
        `- **Date**: May 24 - Alder Creek (confirming it's the May 2026 event)\n\n**Answer:**\n\n` +
        `${needle.author} posted the final tally of the Alder Creek cleanup (May 2026 event): ` +
        `**${needle.count} bags** with reference code **${ref}**.`;
      const askQuote =
        "reference code (every card shows one, like FW-000000). Report the name of the neighbour " +
        "who posted it, the final tally in bags, and the post's reference code";
      const rowRaw = {
        posterName: { value: needle.author, quote: `Neighbour name: ${needle.author}` },
        bagCount: { value: needle.count, quote: `Final tally: ${needle.count} bags` },
        postRef: { value: needle.ref, quote: askQuote },
      };
      this.alsoCorrectExtraction = [
        {
          name: "the 2026-09-20 row: postRef's code in the answer, its quote from the ask",
          answer: rowAnswer(needle.ref),
          raw: rowRaw,
        },
      ];
      this.wrongExtraction = [
        {
          name: 'postRef quoted from the ask, and its code nowhere in the answer',
          answer: rowAnswer('not legible on the card'),
          raw: rowRaw,
        },
        {
          name: "postRef's code in the answer only as the head of a longer code",
          answer: rowAnswer(`${needle.ref}7`),
          raw: rowRaw,
        },
        {
          // Every clause of the quote is the ask's, echoed by the answer, so the
          // clause fallback that joins a quote split across bullets finds each
          // one in the answer.
          name: "postRef quoted from the ask's wording, which the answer echoes, and its code never stated",
          answer:
            `Restating the ask: report the name of the neighbour who posted it, the final tally ` +
            `in bags, and the post's reference code (every card shows one, like FW-000000).\n\n` +
            `- Neighbour name: ${needle.author}\n- Final tally: ${needle.count} bags\n` +
            `- Reference code: cut off on the card`,
          raw: rowRaw,
        },
      ];
      this.wrong = [
        this.wrong,
        `${needle.author}'s final tally post (Ref ${needle.ref}) reports ` +
          `${teaser.count} bags.`,
        `The final tally is ${lookalike.count} bags, posted by ${lookalike.author} ` +
          `under Ref ${lookalike.ref}.`,
      ].flat();
      this.alsoCorrect = [
        `The pinned early-count post said ${teaser.count} bags and the archive repost ` +
          `of the 2025 tally says ${lookalike.count}, but the actual final tally post ` +
          `is by ${needle.author}: ${needle.count} bags, Ref ${needle.ref}.`,
        `Poster: ${needle.author}\nBag count: ${needle.count}\nReference: ${needle.ref}`,
        `${needle.author} posted the final creek-cleanup tally of ${needle.count} bags ` +
          `(ref ${needle.ref.toLowerCase()}).`,
      ];
      return {
        text:
          `The final tally post is by ${needle.author}: ${needle.count} bags. ` +
          `Its reference code is ${needle.ref}.`,
        fields,
      };
    },
  },
};
