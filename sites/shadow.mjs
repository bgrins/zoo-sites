// pages/shadow/ - facility access console (shadow-unlock). The success message is server-issued so it never appears in fixture source on disk.
import { randomBytes } from 'node:crypto';


export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/shadow/unlock') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const code = String(payload.code ?? '');
      // fromPage is legibility, never proof (sec-fetch and referer are
      // curl-spoofable): a shell-driven unlock stays visible in the results
      // row instead of reading byte-identical to a widget-driven one.
      const fromPage =
        req.headers['sec-fetch-site'] === 'same-origin' ||
        /\/shadow\//.test(req.headers.referer ?? '');
      state.beacons.push({
        sid: found.sid,
        kind: 'shadow-unlock',
        data: { code, fromPage },
        at: Date.now(),
      });
      // The success message is server-issued so it never appears in fixture
      // source on disk.
      return json(
        res,
        200,
        code === 'ORCHID-22'
          ? { granted: true, message: 'Access granted: Metronome stage two is clear' }
          : { granted: false, message: 'Access denied: invalid code' }
      );
    }

    return false;
  };
}
