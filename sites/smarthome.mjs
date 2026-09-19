// pages/smarthome/ - the Hearthline Hub home console.
import { randomBytes, randomInt } from 'node:crypto';

const SMARTHOME_DEFAULTS = { brightness: 80, colorTemp: 4000, fadeSeconds: 3 };

// Calibration targets are minted per session, on the sliders' own steps
// (brightness 0-100 step 1, colorTemp 2700-6500 step 50, fade 0-30 step 1),
// and the triple never equals the factory defaults, so leaving the dials
// alone and hitting Apply is always a mismatch.
function mintSceneTargets() {
  for (;;) {
    const targets = {
      brightness: randomInt(12, 97),
      colorTemp: 2700 + 50 * randomInt(0, 77),
      fadeSeconds: randomInt(2, 29),
    };
    if (
      targets.brightness !== SMARTHOME_DEFAULTS.brightness ||
      targets.colorTemp !== SMARTHOME_DEFAULTS.colorTemp ||
      targets.fadeSeconds !== SMARTHOME_DEFAULTS.fadeSeconds
    ) {
      return targets;
    }
  }
}

function smarthomeState(session) {
  return (session.smarthome ??= {
    targets: mintSceneTargets(),
    applies: [],
    code: null,
  });
}

export function routes(ctx) {
  const { json, readJson, requireSession, fromPage } = ctx;
  const fromSmarthome = fromPage('/smarthome/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/smarthome/scene') {
      const found = requireSession(req, res);
      if (!found) return;
      const sh = smarthomeState(found.session);
      return json(res, 200, {
        scene: 'Evening Wind-down',
        defaults: SMARTHOME_DEFAULTS,
        targets: sh.targets,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/smarthome/apply') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const sh = smarthomeState(found.session);
      const applied = {
        brightness: Number(payload.brightness),
        colorTemp: Number(payload.colorTemp),
        fadeSeconds: Number(payload.fadeSeconds),
      };
      if (!Object.values(applied).every(Number.isFinite)) {
        return json(res, 400, { error: 'brightness, colorTemp and fadeSeconds must be numbers' });
      }
      const t = sh.targets;
      const off = {
        brightness: applied.brightness !== t.brightness,
        colorTemp: applied.colorTemp !== t.colorTemp,
        fadeSeconds: applied.fadeSeconds !== t.fadeSeconds,
      };
      const matched = !off.brightness && !off.colorTemp && !off.fadeSeconds;
      sh.applies.push({
        ...applied,
        matched,
        // Legibility, never proof: curl sets these headers freely.
        fromPage: fromSmarthome(req),
        at: Date.now(),
      });
      if (!matched) {
        return json(res, 200, { ok: false, error: 'calibration targets not met', off });
      }
      sh.code ??= 'HL-' + randomBytes(4).toString('hex').toUpperCase();
      return json(res, 200, { ok: true, code: sh.code });
    }

    return false;
  };
}
