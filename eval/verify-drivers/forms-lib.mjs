// Stray sessions for the forms-family drivers. probes.mjs's straySession posts
// JSON only; these probes also send a nonce-headed GET, a multipart upload, and
// request headers of their choosing, the shapes a curl probe sends.

export async function formsStray(base, path) {
  const page = await fetch(base + path, { headers: { accept: 'text/html' } });
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await page.text()).match(/const NONCE = '([0-9a-f]+)'/)?.[1] ?? null;
  if (!cookie || !nonce) throw new Error(`no stray session for ${path}`);
  // Sessions live in one table behind every listener, so `origin` may name any
  // of them; it defaults to the one the cookie was minted on.
  const send = async (url, init) => {
    const r = await fetch(url, init);
    return r.json().catch(() => ({}));
  };
  return {
    nonce,
    post: (apiPath, body, { origin = base, headers = {} } = {}) =>
      send(origin + apiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, ...headers },
        body: JSON.stringify({ nonce, ...body }),
      }),
    get: (apiPath) => send(base + apiPath, { headers: { cookie, 'x-session-nonce': nonce } }),
    // The attestation intake's multipart shape (pages/forms/draymere/upload.html).
    upload: ({ filename, content, headers = {}, origin = base }) => {
      const body = new FormData();
      body.append('nonce', nonce);
      body.append('attested', 'yes');
      body.append('doc', new Blob([content], { type: 'text/plain' }), filename);
      return send(origin + '/api/upload', { method: 'POST', headers: { cookie, ...headers }, body });
    },
  };
}
