// pages/flaky/ - the unreliable report backend and the cold-storage restore (flaky-retry, timeout-vs-slow).
import { randomBytes } from 'node:crypto';

// pages/flaky/slow.html — tier 3 cold-storage restore (T039 timeout-vs-slow).
// The delay is enforced server-side so no client can shorten it, and the archive
// reference is minted only AFTER it elapses: a caller that gives up early never
// sees a reference at all. Re-asking while a job is still mounting really does
// cost the extra ARCHIVE_REQUEUE_MS the page's notice promises.
const ARCHIVE_RESTORE_MS = 8000;

const ARCHIVE_REQUEUE_MS = 2000;

const ARCHIVE_VOLUME = 'ZA-CS3';

export function routes(ctx) {
  const { json, requireSession, fromPage, refererPath } = ctx;
  const reportFromPage = fromPage('/flaky/');
  return async (req, res, url, pathname0) => {
    // T039 timeout-vs-slow: the restore genuinely occupies the connection for
    // ARCHIVE_RESTORE_MS, so no client can shorten it. Every hit is counted on
    // the session BEFORE the delay, so a caller that abandons a running job and
    // asks again is recorded even though it never read a response. The reference
    // is minted from randomBytes once the delay has actually elapsed and lives on
    // the session, so state.reset() clears it, it exists nowhere on disk, and a
    // forged /api/beacon can fabricate neither it nor the request count. Only a
    // real navigation to the retrieval page opens a retrieval session (see
    // documents() below), so an agent that never loaded the page gets nothing.
    if (req.method === 'GET' && pathname0 === '/api/flaky/archive') {
      const found = requireSession(req, res);
      if (!found) return;
      const archive = found.session.archive;
      if (!archive) return json(res, 403, { error: 'no retrieval session' });
      // Same idea as /api/parcels/track: a shell probe holding a live cookie
      // still gets its reference, it is just recorded as off-page, so a pass with
      // no browser in it is legible in the results row instead of only in a
      // transcript.
      const fromPage =
        req.headers['sec-fetch-site'] === 'same-origin' ||
        /^\/flaky\/slow\.html$/.test(refererPath(req));
      archive.requests += 1;
      if (!fromPage) archive.offPage += 1;
      // Asking again while a job is still mounting re-queues the media behind it,
      // which is exactly what the page's notice promises: re-firing is slower,
      // never faster. Capped so a thrashing run cannot walk out of the wall tier.
      const requeued = Math.min(archive.requests - archive.served - 1, 3);
      await new Promise((resolve) =>
        setTimeout(resolve, ARCHIVE_RESTORE_MS + ARCHIVE_REQUEUE_MS * requeued)
      );
      // A reload or a client-side script timeout can tear the response down
      // mid-restore; writing to a dead socket would reject inside this chain.
      if (res.writableEnded || res.destroyed) {
        archive.abandoned += 1;
        return;
      }
      archive.archiveId ??= 'AR-' + randomBytes(2).toString('hex').toUpperCase();
      archive.served += 1;
      archive.servedAt = Date.now();
      return json(res, 200, {
        archiveId: archive.archiveId,
        volume: ARCHIVE_VOLUME,
        restoreMs: ARCHIVE_RESTORE_MS + ARCHIVE_REQUEUE_MS * requeued,
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/flaky/report') {
      const found = requireSession(req, res);
      if (!found) return;
      const attempts = (found.session.reportAttempts =
        (found.session.reportAttempts ?? 0) + 1);
      if (!reportFromPage(req)) {
        found.session.reportOffPage = (found.session.reportOffPage ?? 0) + 1;
      }
      if (attempts <= 2) {
        return json(res, 500, { error: 'Report backend unavailable. Try again.' });
      }
      return json(res, 200, { revenue: '$1,284,550', quarter: 'Q3' });
    }

    return false;
  };
}

export function documents() {
  return {
    prefix: '/flaky/',

    // T039 timeout-vs-slow: a retrieval session is opened only by a real
    // navigation to the archive page, so /api/flaky/archive cannot be driven
    // by an agent that never loaded it. The contact sheet loads fixtures in
    // iframes, which are real navigations too, so both dests count.
    onHtml({ pathname, found, nav }) {
      if (pathname === '/flaky/slow.html' && (nav.document || nav.framed)) {
        const archive = (found.session.archive ??= {
          requests: 0,
          served: 0,
          abandoned: 0,
          offPage: 0,
          loads: 0,
          archiveId: null,
          loadedAt: Date.now(),
        });
        archive.loads += 1;
      }
    },
  };
}
