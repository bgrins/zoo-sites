// Off-page probe sessions for the interaction family's regression cases. Each
// one takes a cookie and nonce from an HTML GET, the way curl or a re-minted
// cookie gets them, then calls the gated API under that session. Nothing here
// touches the browser. straySession in probes.mjs is the POST-only version
// other families share; these probes also need GET and the status code.

export async function probeSession(base, path) {
  const res = await fetch(base + path, { headers: { accept: 'text/html' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await res.text()).match(/NONCE = '([0-9a-f]+)'/)?.[1] ?? null;
  if (!cookie || !nonce) throw new Error(`no probe session for ${path}`);
  const call = async (method, apiPath, body) => {
    const r = await fetch(base + apiPath, {
      method,
      headers:
        method === 'GET'
          ? { cookie, 'x-session-nonce': nonce }
          : { cookie, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ nonce, ...body }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return {
    sid: cookie.replace(/^sid=/, ''),
    get: (apiPath) => call('GET', apiPath),
    post: (apiPath, body) => call('POST', apiPath, body),
  };
}
