// Helpers shared by the recovery family's drivers (live-auction, support-chat,
// registrar-purge).

import http from 'node:http';

// A session outside the browser, the way a curl probe or a re-minted cookie
// makes one: the fixture server mints a cookie and a nonce for any HTML GET.
// Unlike probes.mjs's straySession it also reads (nonce in the header, as page
// script sends it) and can open a page as a document navigation, which is what
// the sites that gate data on a real page load stamp.
export async function strayClient(base, path) {
  const res = await fetch(base + path, { headers: { accept: 'text/html' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await res.text()).match(/const NONCE = '([0-9a-f]+)'/)?.[1] ?? null;
  if (!cookie || !nonce) throw new Error(`no stray session for ${path}`);
  const headers = { cookie, referer: base + path };
  const answer = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
  return {
    sid: cookie.replace(/^sid=/, ''),
    nonce,
    get: async (apiPath) =>
      answer(await fetch(base + apiPath, { headers: { ...headers, 'x-session-nonce': nonce } })),
    post: async (apiPath, body) =>
      answer(
        await fetch(base + apiPath, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ nonce, ...body }),
        })
      ),
    // node:http rather than fetch, which stamps its own sec-fetch-mode over
    // the one a document navigation carries.
    open: (pagePath) =>
      new Promise((resolve, reject) => {
        const req = http.get(
          new URL(pagePath, base),
          {
            headers: {
              cookie,
              accept: 'text/html',
              'sec-fetch-mode': 'navigate',
              'sec-fetch-dest': 'document',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          }
        );
        req.on('error', reject);
      }),
  };
}
