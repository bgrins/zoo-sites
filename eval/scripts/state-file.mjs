// The server state a row was graded against, kept so the row can be regraded
// after a validator changes. run.mjs writes one file per graded attempt,
// states/<transcript-name>.json.gz, before state.reset() wipes it; regrade.mjs
// and triage.mjs read it back.
//
// The files hold every code the server minted for that attempt, so they are
// ground truth: bundle.mjs never ships them.
//
// A file is the envelope run.mjs's writeStateFile (agent-env.mjs) writes:
// { version, base, origins, methods, state }, where base and origins are the
// URLs the attempt's task was built with and `state` is cloneState's shape in
// verify.mjs: every data key, CappedLog arrays as plain arrays, methods
// dropped. JSON cannot carry a Map, a Set, a Date or a Buffer, and validators
// read all four (state.sessions is a Map), so each is written as a tagged
// object and rebuilt on read.

import { gunzipSync, gzipSync } from 'node:zlib';
import { deserialize } from 'node:v8';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TAG = '$zooType';

// `extra` rides along at the top level, as in agent-env.mjs: { base, origins }.
export function encodeState(state, extra = {}) {
  const methods = Object.keys(state).filter((k) => typeof state[k] === 'function');
  const data = Object.fromEntries(
    Object.entries(state)
      .filter(([k]) => !methods.includes(k))
      .map(([k, v]) => [k, Array.isArray(v) ? Array.from(v) : v])
  );
  return JSON.stringify({ version: 1, ...extra, methods, state: data }, function replacer(key, value) {
    // JSON.stringify has already called Date#toJSON by the time a replacer
    // sees the value, so read the raw property off the holder instead.
    const raw = this[key];
    if (raw instanceof Date) {
      return { [TAG]: 'Date', value: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
    }
    if (raw instanceof Map) return { [TAG]: 'Map', value: [...raw] };
    if (raw instanceof Set) return { [TAG]: 'Set', value: [...raw] };
    if (ArrayBuffer.isView(raw)) {
      return { [TAG]: 'Bytes', value: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') };
    }
    return value;
  });
}

// Also reads the tagged shapes a hand-rolled replacer tends to produce
// ({dataType:'Map', value} and {$map}), and a v8.serialize payload, so a
// state file written before this codec existed still loads.
function revive(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const type = value[TAG] ?? value.dataType ?? value.__type;
  if (type === 'Map' || value.$map) return new Map(value.value ?? value.$map ?? value.entries);
  if (type === 'Set' || value.$set) return new Set(value.value ?? value.$set ?? value.values);
  if (type === 'Date' || value.$date) return new Date(value.value ?? value.$date ?? NaN);
  if (type === 'Bytes') return Buffer.from(value.value, 'base64');
  return value;
}

// Returns the envelope, { version, base, origins, methods, state }. A bare
// state (no envelope) comes back with version, base and origins null. Throws
// on anything without the server's sessions Map, because grading against a
// state that decoded to nothing fails every minted-value check, and a regrade
// would report those as validator flips.
export function decodeState(buffer) {
  const bytes = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'), revive);
  } catch {
    data = deserialize(bytes);
  }
  const wrapped = data?.version != null && data.state && typeof data.state === 'object';
  const file = wrapped ? data : { version: null, base: null, origins: null, methods: null, state: data };
  const state = file.state;
  if (!(state?.sessions instanceof Map) || !Array.isArray(state.beacons)) {
    const keys = state && typeof state === 'object' ? Object.keys(state).join(', ') : typeof state;
    throw new Error(`not a server state (no sessions Map and beacons array; keys: ${keys || 'none'})`);
  }
  state.beaconsOf = (kind) => state.beacons.filter((b) => b.kind === kind);
  return { ...file, base: file.base ?? null, origins: file.origins ?? null, state };
}

export function writeStateFile(path, state, extra = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(encodeState(state, extra)));
}

export function readStateFile(path) {
  return decodeState(readFileSync(path));
}
