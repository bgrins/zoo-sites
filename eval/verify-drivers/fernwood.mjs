// Golden path for the Fernwood Commons neighbourhood feed
// (pages/fernwood/, task feed-needle). See probes.mjs for the contract.
import { addSession, findSession, until, snapText, bumpCode } from './lib.mjs';

const FEED_REF = /Ref (FW-[0-9A-F]{6})/;

const FEED_NEEDLE_TITLE = 'Creek cleanup: final tally';

// The coordinators the per-session draw can sign the tally post with; used
// only to assert the fixture precondition still holds.
const FEED_AUTHORS = ['Marisol Vega', 'Ansel Okafor', 'Petra Lindqvist', 'Theo Marchetti'];

// The author, figure and FW- reference of the card whose body line matches
// bodyRe: walk back from the body line to its article line (the author is the
// first text node after it; the avatar div carries no text) and forward to
// the card's Ref line.
function feedCard(snapText, bodyRe) {
  const lines = snapText.split('\n');
  const i = lines.findIndex((l) => bodyRe.test(l));
  if (i === -1) return null;
  let author = null;
  for (let j = i - 1; j >= 0; j--) {
    if (/\barticle\b/.test(lines[j])) break;
    const m = lines[j].match(/div text="([^"]+)"/);
    if (m) author = m[1];
  }
  let ref = null;
  for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
    const m = lines[j].match(FEED_REF);
    if (m) {
      ref = m[1];
      break;
    }
  }
  const count = Number(lines[i].match(bodyRe)[1]);
  return author && ref && Number.isFinite(count) ? { author, count, ref } : null;
}

export const DRIVERS = {
  'feed-needle': {
    note:
      'scrolls with evaluate window.scrollTo (no scroll tool exists) so each sentinel ' +
      'IntersectionObserver fires; reads every card off snapshots taken with maxLines 400, ' +
      'because the full feed outruns the default 100-line snapshot and find misses the ' +
      'tally post entirely',
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
    async run({ goto, evaluate, mcp }) {
      await goto('/fernwood/');
      const snap = () => snapText(mcp, { maxLines: 400 });
      const refCount = (t) => (t.match(/Ref FW-[0-9A-F]{6}/g) ?? []).length;
      // Batch 1 renders from the session-gated fetch; poll for the teaser card.
      let s = '';
      await until('the batch-1 teaser card to render', async () => {
        s = await snap();
        return /Early count: \d+ bags/.test(s);
      });
      const teaser = feedCard(s, /Early count: (\d+) bags/);
      if (!teaser) throw new Error('the batch-1 teaser card never rendered');
      if (s.includes(FEED_NEEDLE_TITLE)) {
        throw new Error('the tally post is visible before any scrolling');
      }
      // Older batches load when the sentinel enters the viewport: scroll to the
      // bottom, wait for the feed to grow (never a fixed sleep), repeat.
      let caughtUp = /all caught up/.test(s);
      let seen = refCount(s);
      for (let i = 0; i < 12 && !caughtUp; i++) {
        await evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        await until('scrolling to load another batch', async () => {
          s = await snap();
          if (/all caught up/.test(s)) {
            caughtUp = true;
            return true;
          }
          if (refCount(s) > seen) {
            seen = refCount(s);
            return true;
          }
          return false;
        }, { tries: 40, gap: 200 });
      }
      if (!caughtUp) throw new Error('the feed never reached its last batch');
      const needle = feedCard(s, /Final tally: (\d+) bags/);
      if (!needle) throw new Error('the tally card is missing from the full feed');
      if (!FEED_AUTHORS.includes(needle.author)) {
        throw new Error(`unexpected tally author "${needle.author}"`);
      }
      // The two on-feed decoys the wrongFields pin must still be present and
      // must still disagree with the graded figure, or the regressions below
      // assert nothing.
      const lookalike = feedCard(s, /2025 creek tally: (\d+) bags/);
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
