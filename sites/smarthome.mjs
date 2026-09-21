// pages/smarthome/ - the Hearthline Hub home console.
import { randomBytes } from 'node:crypto';

const SMARTHOME_DEFAULTS = { brightness: 80, colorTemp: 4000, fadeSeconds: 3 };

const steps = (lo, hi, step = 1) => Array.from({ length: (hi - lo) / step + 1 }, (_, i) => lo + i * step);

// Calibration targets are a difficulty draw (sites/README.md), on the sliders'
// own steps (brightness 0-100 step 1, colorTemp 2700-6500 step 50, fade 0-30
// step 1), so a seeded run replays them and paired conditions face the same
// dials. They are drawn once per task: a later session, a curl probe's or a
// re-minted cookie's, copies the first session's. The triple never equals the
// factory defaults, so leaving the dials alone and hitting Apply is always a
// mismatch. The confirmation code stays on randomBytes.
function mintSceneTargets(ctx) {
  const drawn = [...ctx.state.sessions.values()].find((s) => s.smarthome)?.smarthome.targets;
  if (drawn) return { ...drawn };
  for (;;) {
    const targets = {
      brightness: ctx.pick('smarthome.brightness', steps(12, 96)),
      colorTemp: ctx.pick('smarthome.colorTemp', steps(2700, 6500, 50)),
      fadeSeconds: ctx.pick('smarthome.fadeSeconds', steps(2, 28)),
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

// Ungraded household state: device switches and hub settings, per session,
// starting from how the home is set up. Kept apart from session.smarthome,
// which is the calibration the validator reads.
const SMARTHOME_DEVICES = [
  { id: 'pendant', name: 'Pendant cluster', room: 'Living room', light: true, on: true },
  { id: 'reading', name: 'Reading lamp', room: 'Living room', light: true, on: true },
  { id: 'hallway', name: 'Hallway spots', room: 'Hallway', light: true, on: true },
  { id: 'porch', name: 'Porch lantern', room: 'Porch', light: true, on: true },
  { id: 'kitchen', name: 'Kitchen strip', room: 'Kitchen', light: true, on: false },
  { id: 'bedside-left', name: 'Bedside left', room: 'Main bedroom', light: true, on: false },
  { id: 'bedside-right', name: 'Bedside right', room: 'Main bedroom', light: true, on: false },
  { id: 'landing', name: 'Landing light', room: 'Landing', light: true, on: false },
  { id: 'radiator', name: 'Radiator valve', room: 'Living room', light: false, on: true },
  { id: 'camera', name: 'Porch camera', room: 'Porch', light: false, on: false },
  { id: 'door', name: 'Door sensor', room: 'Front door', light: false, on: true },
];
const SMARTHOME_SETTINGS = { remote: true, notifications: true, supplier: true };

function smarthomeHousehold(session) {
  return (session.hearthHousehold ??= {
    devices: Object.fromEntries(SMARTHOME_DEVICES.map((d) => [d.id, d.on])),
    settings: { ...SMARTHOME_SETTINGS },
  });
}

function smarthomeDeviceView(household) {
  return SMARTHOME_DEVICES.map(({ id, name, room, light }) => ({ id, name, room, light, on: household.devices[id] }));
}

function smarthomeState(ctx, session) {
  return (session.smarthome ??= {
    targets: mintSceneTargets(ctx),
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
      const sh = smarthomeState(ctx, found.session);
      // A stored calibration is this session's own: the code it was issued and
      // the dial values of the apply that earned it.
      const stored = sh.code ? sh.applies.findLast((a) => a.matched) : null;
      return json(res, 200, {
        scene: 'Evening Wind-down',
        defaults: SMARTHOME_DEFAULTS,
        targets: sh.targets,
        calibrated: stored
          ? {
              code: sh.code,
              brightness: stored.brightness,
              colorTemp: stored.colorTemp,
              fadeSeconds: stored.fadeSeconds,
            }
          : null,
      });
    }

    if (req.method === 'GET' && pathname0 === '/api/smarthome/devices') {
      const found = requireSession(req, res);
      if (!found) return;
      const household = smarthomeHousehold(found.session);
      return json(res, 200, { devices: smarthomeDeviceView(household), settings: household.settings });
    }

    if (req.method === 'POST' && (pathname0 === '/api/smarthome/device' || pathname0 === '/api/smarthome/setting')) {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const household = smarthomeHousehold(found.session);
      const table = pathname0.endsWith('/device') ? household.devices : household.settings;
      const id = String(payload.id ?? '');
      if (!Object.hasOwn(table, id)) return json(res, 404, { error: 'The hub has nothing paired under that name.' });
      if (typeof payload.on !== 'boolean') return json(res, 400, { error: 'on must be true or false' });
      table[id] = payload.on;
      return json(res, 200, { ok: true, devices: smarthomeDeviceView(household), settings: household.settings });
    }

    if (req.method === 'POST' && pathname0 === '/api/smarthome/apply') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const sh = smarthomeState(ctx, found.session);
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
