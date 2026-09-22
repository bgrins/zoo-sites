// pages/canvas/ - swatch grid (canvas-pick). The calibration code is minted per session.
import { randomBytes } from 'node:crypto';


export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  const fromCanvas = fromPage('/canvas/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/canvas/reveal') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const cell = String(payload.cell ?? '');
      if (!/^C[1-8]R[1-6]$/.test(cell)) {
        return json(res, 400, { error: 'unknown swatch id' });
      }
      // Legibility, never proof: curl sets these headers freely.
      const fromPage = fromCanvas(req);
      state.beacons.push({
        sid: found.sid,
        kind: 'canvas-pick',
        data: { cell, fromPage },
        at: Date.now(),
      });
      // The calibration code is minted per session so a swept or copied code
      // is distinguishable from the one this run earned. The palette itself
      // stays inline in the page: deriving the cell from source is the
      // accepted derivation class (one legible pick), the forgery this gate
      // kills is the blind 48-cell sweep, which the validator rejects by
      // exploration order.
      found.session.canvasCode ??=
        'AMBER-' + (100 + (randomBytes(2).readUInt16BE(0) % 900));
      return json(
        res,
        200,
        cell === 'C4R2'
          ? { code: found.session.canvasCode }
          : { error: 'That swatch does not match the target hue.' }
      );
    }

    return false;
  };
}
