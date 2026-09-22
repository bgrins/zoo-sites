// The server state a row was graded against, kept so the row can be regraded
// after a validator changes. run.mjs writes one file per graded attempt,
// states/<transcript-name>.json.gz, before state.reset() wipes it; regrade.mjs
// and triage.mjs read it back.
//
// The files hold every code the server minted for that attempt, so they are
// ground truth: bundle.mjs never ships them.
//
// A file is the gzipped envelope writeStateFile writes (agent-env.mjs
// re-exports it for run.mjs): { version, base, origins, methods, state }, where
// base and origins are the URLs the attempt's task was built with and `state`
// is cloneState's shape in verify.mjs: every data key, CappedLog arrays as
// plain arrays, methods dropped. JSON cannot carry a Map, a Set, a Date or a
// Buffer, and validators read all four (state.sessions is a Map), so each is
// written as a tagged object and rebuilt on read.

import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TAG = '$zooType';

// `extra` rides along at the top level: { base, origins }.
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

function revive(key, value) {
  if (!value || typeof value !== 'object' || typeof value[TAG] !== 'string') return value;
  switch (value[TAG]) {
    case 'Map':
      return new Map(value.value);
    case 'Set':
      return new Set(value.value);
    case 'Date':
      return new Date(value.value ?? NaN);
    case 'Bytes':
      return Buffer.from(value.value, 'base64');
    default:
      return value;
  }
}

// Returns the envelope, with `state` rebuilt the way cloneState rebuilds one:
// its data plus beaconsOf. `methods` names what the live state had, so a
// validator that needs another method fails naming it. Throws on anything
// without the server's sessions Map, because grading against a state that
// decoded to nothing fails every minted-value check, and a regrade would
// report those as validator flips.
export function decodeState(buffer) {
  const file = JSON.parse(gunzipSync(buffer).toString('utf8'), revive);
  const state = file?.state;
  if (!(state?.sessions instanceof Map) || !Array.isArray(state.beacons)) {
    const keys = state && typeof state === 'object' ? Object.keys(state).join(', ') : typeof state;
    throw new Error(`not a server state (no sessions Map and beacons array; keys: ${keys || 'none'})`);
  }
  state.beaconsOf = (kind) => state.beacons.filter((b) => b.kind === kind);
  return { ...file, state };
}

export function writeStateFile(path, state, extra = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(encodeState(state, extra)));
}

export function readStateFile(path) {
  return decodeState(readFileSync(path));
}
