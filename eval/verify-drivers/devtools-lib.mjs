// Helpers for the devtools-suite drivers; quotient.mjs is the only user.

// A Quotient session that never touched the browser, the way a curl probe
// makes one: a cookie and the page's QT_NONCE from one HTML GET, then plain
// fetches with no Referer and no sec-fetch-site, so the server records every
// call it makes as off-page. probes.mjs's straySession reads `const NONCE`,
// which the Quotient pages do not declare.
export async function quotientStray(base, page) {
  const res = await fetch(base + page, { headers: { accept: 'text/html' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await res.text()).match(/window\.QT_NONCE = '([0-9a-f]+)'/)?.[1] ?? null;
  if (!cookie || !nonce) throw new Error(`no stray Quotient session for ${page}`);
  const call = async (path, init = {}) => {
    const r = await fetch(base + path, { ...init, headers: { cookie, ...init.headers } });
    return { status: r.status, body: await r.json() };
  };
  return {
    batch: () => call('/api/quotient/batch', { headers: { 'x-session-nonce': nonce } }),
    quote: (body) =>
      call('/api/quotient/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, ...body }),
      }),
  };
}
