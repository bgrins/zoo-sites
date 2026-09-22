// pages/shadow/ - facility access console (shadow-unlock). The success message is server-issued so it never appears in fixture source on disk.
import { pushTrimmed } from './lib.mjs';

// The console's own clock for entries this session writes: the shift's first
// keypad entry is logged at 08:14:11 and each later one eleven seconds on, so
// the log reads the same on every run.
function shadowClock(n) {
  const secs = 8 * 3600 + 14 * 60 + 11 * n;
  return [secs / 3600, (secs / 60) % 60, secs % 60]
    .map((v) => String(Math.floor(v)).padStart(2, '0'))
    .join(':');
}

// What the console shows outside the keypad module. A grant lights the stage
// lamp and nothing else: its entry goes to the site access record rather than
// the on-screen log, so the only text announcing it stays inside the module.
function shadowConsole(session) {
  return (session.shadowConsole ??= { attempts: 0, rejected: 0, granted: false, log: [] });
}

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  const fromShadow = fromPage('/shadow/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/shadow/console') {
      const found = requireSession(req, res);
      if (!found) return;
      const con = shadowConsole(found.session);
      return json(res, 200, { granted: con.granted, log: con.log });
    }

    if (req.method === 'POST' && pathname0 === '/api/shadow/unlock') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const code = String(payload.code ?? '');
      // fromPage is legibility, never proof (sec-fetch and referer are
      // curl-spoofable): a shell-driven unlock stays visible in the results
      // row instead of reading byte-identical to a widget-driven one.
      const fromPage = fromShadow(req);
      state.beacons.push({
        sid: found.sid,
        kind: 'shadow-unlock',
        data: { code, fromPage },
        at: Date.now(),
      });
      const con = shadowConsole(found.session);
      con.attempts += 1;
      const granted = code === 'ORCHID-22';
      const added = [];
      if (granted) {
        con.granted = true;
      } else {
        con.rejected += 1;
        added.push({ t: shadowClock(con.attempts), tag: 'KEYPAD', text: `code rejected, attempt ${con.rejected} this shift`, bad: true });
        if (con.rejected === 3) {
          added.push({ t: shadowClock(con.attempts), tag: 'DUTY ENGINEER', text: 'paged: three rejections this shift', bad: true });
        }
      }
      for (const row of added) pushTrimmed(con.log, row);
      // The success message is server-issued so it never appears in fixture
      // source on disk.
      return json(
        res,
        200,
        granted
          ? { granted: true, message: 'Access granted: Metronome stage two is clear', log: added }
          : { granted: false, message: 'Access denied: invalid code', log: added }
      );
    }

    return false;
  };
}
