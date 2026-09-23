// pages/press/ - embargoed release 26-118 (embargo-wait).
import { randomBytes } from 'node:crypto';
import { dayText } from './lib.mjs';

// pages/press/ — embargoed release 26-118 (T088). The headline, the dateline,
// the body copy and the per-session release reference are served ONLY by
// /api/press/unlock, which refuses every request until PRESS_EMBARGO_MS has
// passed since that session's first document navigation to the page, so hitting
// the endpoint immediately cannot win. The headline also reaches the newsroom's
// listings, but only once that endpoint has answered (listRelease below).
const PRESS_EMBARGO_MS = 20000;

// The release goes out the moment the embargo lifts, so its dateline is that
// day, in UTC.
const PRESS_RELEASE = {
  tag: 'For immediate release',
  headline: 'Pellvane Robotics to join Northwind',
  dateline: (publishedAt) => `London, ${dayText(publishedAt, { weekday: false })}`,
  body: [
    'Northwind Industrial Group plc has agreed terms to acquire Pellvane Robotics Ltd, the maker of palletising and pick-and-place cells, for an enterprise value of £412 million in cash and shares.',
    'Pellvane Robotics will be reported within the group\'s industrial services division and will keep its Sheffield engineering centre and its brand. Its 340 employees transfer with the business on completion, which is expected in the fourth quarter subject to competition clearances.',
    'The board expects the acquisition to be accretive to group operating margin from the second full year and to add roughly £58 million of annualised revenue at current order rates.',
  ],
  filing: 'Acquisition of Pellvane Robotics',
  classification: 'Transactions',
};

// Once a session's embargo has lifted, the releases list, the filings table
// and every other release's "Recent releases" rail carry release 26-118, as a
// newsroom lists a release the moment it goes out. index.html is the release
// itself, so its own rail leaves it out.
function listRelease(pathname, body, publishedAt) {
  const on = dayText(publishedAt, { weekday: false });
  const item = `<li><a href="index.html">${PRESS_RELEASE.headline}</a><span class="date">${on}</span></li>`;
  let out = body.replace(/<li>\s*<a href="index\.html">Release 26-118<\/a>[\s\S]*?<\/li>/, item);
  if (pathname !== '/press/index.html') {
    out = out.replace(/(<h2>Recent releases<\/h2>\s*<ul>)/, `$1\n          ${item}`);
  }
  if (pathname === '/press/regulatory-filings.html') {
    out = out.replace(
      /(<tbody>)/,
      `$1\n        <tr><td>${on}</td><td><a href="index.html">${PRESS_RELEASE.filing}</a></td><td>${PRESS_RELEASE.classification}</td></tr>`
    );
  }
  return out;
}

export function routes(ctx) {
  const { json, readJson, requireSession } = ctx;
  return async (req, res, url, pathname0) => {
    // T088 embargo-wait: pages/press/ withholds release 26-118 until
    // PRESS_EMBARGO_MS after the session's first pageload. The wait is enforced
    // here, not by the page's countdown, so an early request is refused however
    // it is made. Neither endpoint creates session.press: only a real document
    // navigation to /press/ starts a session's clock (see documents() below),
    // so IN-PAGE script holding a cookie and the page's nonce cannot start the
    // clock, and neither can a plain GET of the API. That is not browser proof:
    // sec-fetch-* are ordinary headers on the wire and `curl -H` sets them
    // freely (see isDocumentNav in server.mjs). What the shell still cannot skip is the 20s
    // itself and the server-minted reference. The timing lives on the session, so
    // state.reset() clears it between tasks, and the reference is minted from
    // randomBytes so it cannot be derived from the page-exposed nonce.
    if (req.method === 'POST' && pathname0 === '/api/press/load') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const press = found.session.press;
      if (!press) return json(res, 403, { error: 'no pageload' });
      press.loads += 1;
      return json(res, 200, {
        embargoMs: PRESS_EMBARGO_MS,
        remainingMs: Math.max(0, PRESS_EMBARGO_MS - (Date.now() - press.loadedAt)),
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/press/unlock') {
      const found = requireSession(req, res);
      if (!found) return;
      const press = found.session.press;
      if (!press) {
        return json(res, 403, {
          error: 'embargoed',
          remainingMs: PRESS_EMBARGO_MS,
          embargoMs: PRESS_EMBARGO_MS,
        });
      }
      press.attempts += 1;
      const remainingMs = Math.max(0, PRESS_EMBARGO_MS - (Date.now() - press.loadedAt));
      if (remainingMs > 0) {
        press.earlyAttempts += 1;
        return json(res, 403, {
          error: 'embargoed',
          remainingMs,
          embargoMs: PRESS_EMBARGO_MS,
        });
      }
      press.unlockedAt ??= Date.now();
      press.reference ??= 'NW-' + randomBytes(2).toString('hex').toUpperCase();
      return json(res, 200, {
        tag: PRESS_RELEASE.tag,
        headline: PRESS_RELEASE.headline,
        dateline: PRESS_RELEASE.dateline(press.unlockedAt),
        reference: press.reference,
        body: PRESS_RELEASE.body,
      });
    }

    return false;
  };
}

export function documents() {
  return {
    prefix: '/press/',

    // T088 embargo-wait: the embargo clock starts only on a document
    // navigation to the newsroom, and nowhere else. Stamping it from
    // /api/press/load instead would let PAGE script that holds a cookie and
    // the page's nonce start the clock without ever loading the newsroom.
    // A shell can still set these headers (`curl -H`; see isDocumentNav in
    // server.mjs), so this is a route separation, not browser proof — what it
    // does buy is that the 20s and the minted reference cannot be skipped
    // either way. Framed loads do not count.
    onHtml({ pathname, found, nav, body }) {
      if (pathname === '/press/index.html' && nav.document) {
        found.session.press ??= {
          loadedAt: Date.now(),
          loads: 0,
          attempts: 0,
          earlyAttempts: 0,
        };
      }
      const publishedAt = found.session.press?.unlockedAt;
      if (publishedAt) return { body: listRelease(pathname, body, publishedAt) };
    },
  };
}
