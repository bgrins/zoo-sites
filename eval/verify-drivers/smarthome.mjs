// Golden path for T008 scene-calibrate (pages/smarthome/). The task exists to
// probe range-input handling: fill_by_uid on an input type=range does not land
// the requested value (the slider stays at the track midpoint, the typed digits
// are discarded, and no input event reaches the page, so the live readout keeps
// its stale number). The driver tries fill_by_uid first anyway, so if the tool
// ever learns to drive sliders the honest path is taken automatically; until
// then it falls back to evaluate_script setting .value and dispatching input
// and change, which is the accepted solve path for this task.
//
// Every graded datum (the calibration targets, the confirmation code) is read
// off the snapshot, never via getElementById, so a green run proves those
// values are legible to a snapshot-driven agent; evaluate is kept only for
// the slider fallback and the readout cross-check.

import { until, uidOf, bumpCode } from './lib.mjs';

const PATH = '/smarthome/';

// The targets strip precedes the dials in document order, so the FIRST
// "Brightness" / "Colour temperature" / "Fade time" text node is the target
// name and the node right after it is the target value. The anchored matches
// double as the spec's snapshot-budget check: a value the snapshot truncates
// or hides never parses, and the un-fetched placeholder is a dash.
function readTargets(snap) {
  const lines = snap.split('\n');
  const valueAfter = (name, re) => {
    const at = lines.findIndex((l) => l.includes(`text="${name}"`));
    const m = at < 0 ? null : lines[at + 1]?.match(/text="([^"]*)"/);
    const v = m?.[1].match(re);
    return v ? Number(v[1]) : null;
  };
  const t = {
    brightness: valueAfter('Brightness', /^(\d+)%$/),
    colorTemp: valueAfter('Colour temperature', /^(\d+) K$/),
    fadeSeconds: valueAfter('Fade time', /^(\d+) s$/),
  };
  return Object.values(t).every((v) => v !== null) ? t : null;
}

export const DRIVERS = {
  'scene-calibrate': {
    note: 'fill_by_uid cannot drive range inputs; falls back to evaluate + input/change dispatch',
    async run({ mcp, goto, evaluate, snapshot }) {
      await goto(PATH);

      // The targets arrive from the session-gated fetch; poll until all three
      // numbers render on the calibration card, and read them from the same
      // snapshot surface an agent has.
      const targets = await until('the calibration targets to render', async () =>
        readTargets(await snapshot())
      );

      // Fixture preconditions: each slider carries its own accessible name (a
      // wrapping label names nothing on our surface) and the Apply button is
      // reachable from the snapshot.
      const snap = await snapshot();
      const sliderUid = (name) => uidOf(snap, `input "${name}"`);
      const sliders = {
        brightness: sliderUid('Brightness'),
        colorTemp: sliderUid('Colour temperature'),
        fadeSeconds: sliderUid('Fade time'),
      };
      for (const [key, uid] of Object.entries(sliders)) {
        if (!uid) throw new Error(`no aria-named slider for ${key} in the snapshot`);
      }
      if (!/uid=\S+ button "Apply scene"/.test(snap)) {
        throw new Error('no Apply scene button in the snapshot');
      }

      // Honest attempt first: fill each slider by uid, then check what landed.
      // A throw counts the same as a mis-landed value, so if fill_by_uid ever
      // starts raising on range inputs the fallback below still runs.
      const ids = { brightness: 'sl-brightness', colorTemp: 'sl-colortemp', fadeSeconds: 'sl-fade' };
      for (const [key, uid] of Object.entries(sliders)) {
        try {
          await mcp('fill_by_uid', { uid, value: String(targets[key]) });
        } catch {}
      }
      const landed = await evaluate(
        `() => ({
          brightness: Number(document.getElementById('sl-brightness').value),
          colorTemp: Number(document.getElementById('sl-colortemp').value),
          fadeSeconds: Number(document.getElementById('sl-fade').value),
        })`
      );
      const fillWorked = Object.keys(ids).every((k) => landed[k] === targets[k]);
      if (!fillWorked) {
        await evaluate(
          `() => {
            const set = (id, v) => {
              const el = document.getElementById(id);
              el.value = String(v);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            set('sl-brightness', ${targets.brightness});
            set('sl-colortemp', ${targets.colorTemp});
            set('sl-fade', ${targets.fadeSeconds});
          }`
        );
      }

      // The live readouts are the fixture's legibility tell: they must agree
      // with the dial values before applying.
      const readouts = await evaluate(
        `() => [
          document.getElementById('ro-brightness').textContent,
          document.getElementById('ro-colortemp').textContent,
          document.getElementById('ro-fade').textContent,
        ]`
      );
      const want = [`${targets.brightness}%`, `${targets.colorTemp} K`, `${targets.fadeSeconds} s`];
      if (!want.every((w, i) => readouts[i] === w)) {
        throw new Error(`readouts ${JSON.stringify(readouts)} never reached ${JSON.stringify(want)}`);
      }

      const applyUid = uidOf(await snapshot(), 'button "Apply scene"');
      if (!applyUid) throw new Error('Apply scene button lost after setting the dials');
      await mcp('click_by_uid', { uid: applyUid });

      // The confirmation must be legible on the snapshot: the label and the
      // code each sit in their own short text node.
      const code = await until('the confirmation code to render', async () => {
        const now = await snapshot();
        if (!now.includes('text="Scene applied. Code:"')) return null;
        return now.match(/text="(HL-[0-9A-F]{8})"/)?.[1] ?? null;
      });

      // The hub keeps a calibration, so a reload shows this session's own code
      // with the dials at the values that earned it, not a card still waiting.
      await goto(PATH);
      await until('the stored calibration to render after a reload', async () => {
        const now = await snapshot();
        return now.includes('text="Calibration stored. Code:"') && now.includes(`text="${code}"`) ? true : null;
      });
      const kept = await evaluate(
        `() => [
          document.getElementById('ro-brightness').textContent,
          document.getElementById('ro-colortemp').textContent,
          document.getElementById('ro-fade').textContent,
        ]`
      );
      if (!want.every((w, i) => kept[i] === w)) {
        throw new Error(`after a reload the dials read ${JSON.stringify(kept)}, not the stored ${JSON.stringify(want)}`);
      }

      const fields = { confirmationCode: code, ...targets };
      const bumped = bumpCode(code);
      this.wrong = [
        `The hub accepted the scene at the factory defaults (brightness 80%, ` +
          `color temperature 4000 K, fade 3 s) and issued confirmation code ${bumped}.`,
        `I applied the Evening Wind-down scene at brightness 80%, color temperature ` +
          `4000 K and fade 3 s; the hub issued confirmation code ${code}.`,
        `Scene applied: brightness ${targets.brightness}%, color temperature ` +
          `${targets.colorTemp} K, fade ${targets.fadeSeconds} s. Confirmation code ${bumped}.`,
      ];
      this.alsoCorrect = [
        `The card called for ${targets.brightness}% brightness, ${targets.colorTemp} K ` +
          `and a ${targets.fadeSeconds} s fade. fill_by_uid left the sliders at their ` +
          `midpoints, so I set them via script and applied the scene; the hub confirmed ` +
          `with code ${code}.`,
        `Brightness: ${targets.brightness}%\nColor temperature: ${targets.colorTemp} K\n` +
          `Fade time: ${targets.fadeSeconds} s\nConfirmation code: ${code}`,
        `All three dials match the targets (${targets.brightness}%, ${targets.colorTemp} K, ` +
          `${targets.fadeSeconds} s) and the scene went through - confirmation ` +
          `${code.toLowerCase()}.`,
      ];
      this.wrongFields = [
        // Factory-default triple with the real code: the values must be bound
        // to the graded session's own mint, not just any plausible numbers.
        { confirmationCode: code, brightness: 80, colorTemp: 4000, fadeSeconds: 3 },
        // Two values swapped between fields.
        {
          confirmationCode: code,
          brightness: targets.colorTemp,
          colorTemp: targets.brightness,
          fadeSeconds: targets.fadeSeconds,
        },
        // Right triple, bumped code.
        { ...targets, confirmationCode: bumped },
      ];
      this.alsoCorrectFields = [
        fields,
        { ...fields, confirmationCode: code.toLowerCase() },
      ];
      return {
        text:
          `Calibrated the Evening Wind-down scene: brightness ${targets.brightness}%, ` +
          `color temperature ${targets.colorTemp} K, fade time ${targets.fadeSeconds} s. ` +
          `The hub applied the scene and issued confirmation code ${code}.`,
        fields,
      };
    },
  },
};
