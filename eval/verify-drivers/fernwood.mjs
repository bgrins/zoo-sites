// Golden path for the Fernwood Commons neighbourhood feed
// (pages/fernwood/, task feed-needle). See probes.mjs for the contract.
import { addSession, findSession, until, bumpCode } from './lib.mjs';

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
      title: c.querySelector('h2')?.textContent ?? '',
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
      'mid-sentence in a neighbour-written post, past the snapshot text cap',
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
    async run({ goto, evaluate }) {
      await goto('/fernwood/');
      const status = () => evaluate(() => document.getElementById('status')?.textContent ?? '');
      // Batch 1 renders from the session-gated fetch; poll for the teaser card.
      let cards = [];
      await until('the batch-1 teaser card to render', async () => {
        cards = await readCards(evaluate);
        return cards.some((c) => TEASER_RE.test(c.body));
      });
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
