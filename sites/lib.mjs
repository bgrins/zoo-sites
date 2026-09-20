// Pure helpers shared by site modules. Anything that needs request or session
// plumbing belongs on ctx instead (see README.md).

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// A 32-bit LCG over [0, 1), seeded from the first four bytes it is handed, so a
// whole rejection-sampled difficulty mint replays from one ctx.draw(scope, 4).
export function lcg(bytes) {
  let seed = bytes.readUInt32BE(0);
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// A standing habitat (serve.mjs) never resets state, so a record one session
// grows on every request needs a ceiling. Telemetry, which a validator may
// report but never grades, is trimmed oldest-first with pushTrimmed. A record
// a validator grades is never trimmed, since a flood could push the row that
// fails a task off the front: its route refuses the request once the record
// holds SESSION_ROWS rows.
export const SESSION_ROWS = 500;

export function pushTrimmed(list, row, max = SESSION_ROWS) {
  list.push(row);
  if (list.length > max) list.splice(0, list.length - max);
}
