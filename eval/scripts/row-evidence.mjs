// What a run directory says about a row that an older row does not carry, read
// the same way by every report (report.mjs, ab.mjs, compare.mjs,
// tool-stats.mjs, triage.mjs, regrade.mjs): the state it was graded against,
// whether the agent's shell got its answers from a graded route, and, for a
// codex row, what its rollout says code mode did.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DOCUMENTS } from '../../sites/index.mjs';
import { readStateFile } from './state-file.mjs';

// A shell request the fixture server answered on a route a site's handler
// serves, where session state and minted values live. The ledger calls a
// loopback request without the browser's Fetch Metadata client 'shell'
// (server.mjs requestClass).
//   /api/<site>/... and the /collect sink, answered 2xx or 5xx, with a session
//     or without: an API never mints a session (only an HTML response does), so
//     a cookieless 2xx is a route that serves any client the same data, and a
//     handler's 5xx carries what it grades: depot's 507 body holds the manifest
//     ref body-only-ref's curl read, its 502 the X-Depot-Trace header, which a
//     HEAD gets with no body at all.
//   a page under a site's documents() prefix, answered 2xx to a request that
//     carried a session, since that hook writes the session's own values into
//     the body (gov's page token, intl's edition dates). A cookieless fetch
//     gets a session minted for it, and search-decoy's 14 curls of /gov/ pages
//     got the static text the browser showed. This misses a cookieless fetch
//     of a value no session draws, such as intl's dates, which count from the
//     day a session opened; no stored row made one.
// A refusal (401, 403, 404) delivered nothing, and any other page a shell
// fetches (ledger-sum's /ledger/page-*.html) is the page the browser shows.
// The scripted backend's golden-path drivers fetch with the browser's cookie
// themselves, so its rows are never shell-assisted.
const API_ROUTE = /^\/(?:api\/|collect(?:[?#]|$))/;
let hookPrefixes;
// The documents() hooks' path prefixes. A hook factory uses its ctx only per
// request, or to build a check (gov's fromPage), so a stub ctx builds one to
// read the prefix from.
function hookPrefixesOf() {
  if (!hookPrefixes) {
    const stub = new Proxy({}, { get: () => () => () => false });
    hookPrefixes = DOCUMENTS.map((factory) => factory(stub).prefix).filter(Boolean);
  }
  return hookPrefixes;
}
const isShell = (e) => (e.client ? e.client === 'shell' : !e.dest);
function gradedAnswer(e) {
  const path = String(e.path ?? '');
  const status = Number(e.status);
  if (API_ROUTE.test(path)) return (status >= 200 && status < 300) || status >= 500;
  if (!(status >= 200 && status < 300) || !e.sid || e.minted) return false;
  const lower = path.toLowerCase();
  return hookPrefixesOf().some((prefix) => lower.startsWith(prefix));
}

// { requests, paths } for a ledger with such requests, `paths` the first few
// distinct "METHOD path status", else null.
export function shellAssisted(ledger, { backend = null } = {}) {
  if (!Array.isArray(ledger) || backend === 'scripted') return null;
  const hits = ledger.filter((e) => isShell(e) && gradedAnswer(e));
  if (!hits.length) return null;
  const paths = [...new Set(hits.map((e) => `${e.method ?? 'GET'} ${String(e.path).replace(/\?.*$/, '')} ${e.status}`))];
  return { requests: hits.length, paths: paths.slice(0, 4) };
}

// The server state a row was graded against, from its state file: null when
// the row names none or the file is missing. A file that does not decode is
// null too and warned about once, since the figures then read the row as
// having no evidence (regrade.mjs counts such files instead).
const WARNED = new Set();
export function rowState(row, runDir = null) {
  if (!runDir || !row?.state_file) return null;
  const path = join(runDir, row.state_file);
  if (!existsSync(path)) return null;
  try {
    return readStateFile(path).state;
  } catch (error) {
    if (!WARNED.has(path)) {
      WARNED.add(path);
      console.error(`warning: ${path} could not be read (${error?.message ?? error}); its row is read without its state`);
    }
    return null;
  }
}

// A row's shell assistance: what the row recorded (run.mjs writes the key on
// every row, null when there was none), else, for a row that predates the key
// and whose ledger counted shell requests, its state file's ledger.
const ASSISTED = new WeakMap();
export function shellAssistedOf(row, runDir = null) {
  if (!row || row.backend === 'scripted') return null;
  if ('shell_assisted' in row) return row.shell_assisted ?? null;
  if (!row.ledger?.non_browser || !runDir || !row.state_file) return null;
  if (ASSISTED.has(row)) return ASSISTED.get(row);
  const state = rowState(row, runDir);
  const out = state ? shellAssisted(state.ledger, { backend: row.backend }) : null;
  ASSISTED.set(row, out);
  return out;
}

// backends/codex.mjs, loaded on the first stored codex row that needs its
// rollout read: at import it checks EVAL_CODEX_TOOL_MODE and loads the codex
// SDK, which run.mjs loads only for a codex run and a report of any other run
// has no use for.
let codexBackend;
function codexRollouts() {
  if (codexBackend === undefined) {
    try {
      codexBackend = createRequire(import.meta.url)('../backends/codex.mjs');
    } catch (error) {
      codexBackend = null;
      console.error(`warning: codex rollouts not read (${error.message}); stored codex rows keep their recorded turns`);
    }
  }
  return codexBackend;
}

// What a stored codex row's rollout (rollouts/<transcript>) says: codex.mjs
// rolloutFacts, or null for any other row or without the rollout.
const ROLLOUT = new WeakMap();
function rolloutOf(row, runDir) {
  if (!runDir || (row.backend ?? '') !== 'codex') return null;
  if (ROLLOUT.has(row)) return ROLLOUT.get(row);
  let out = null;
  const file = row.rollout ?? (row.transcript ? `rollouts/${row.transcript}` : null);
  try {
    if (file && existsSync(join(runDir, file))) out = codexRollouts()?.rolloutFacts(readFileSync(join(runDir, file), 'utf8')) ?? null;
  } catch {}
  ROLLOUT.set(row, out);
  return out;
}

// A codex row's code_mode: the row's, else codeModeStats of its rollout, which
// a row written before row.code_mode still has. Null for any other row, or
// without the rollout.
export function codeModeOf(row, runDir = null) {
  if (!row) return null;
  return row.code_mode ?? rolloutOf(row, runDir)?.stats ?? null;
}

// Whether a codex row's rollout totals are the row's usage (input inclusive of
// both cache figures, cached input, output); a rollout short of them missed
// requests. Null without the rollout.
export function rolloutCoversRow(row, runDir = null) {
  const facts = rolloutOf(row, runDir);
  if (!facts) return null;
  const u = facts.usage ?? {};
  return (
    u.input_tokens === (row.input_tokens ?? 0) + (row.cache_read ?? 0) + (row.cache_creation ?? 0) &&
    u.cached_input_tokens === (row.cache_read ?? 0) &&
    u.output_tokens === (row.output_tokens ?? 0)
  );
}

// A row as the reports read it: a codex row that predates row.code_mode gets
// the one its rollout holds, and its turns become the rollout's model
// requests, as backends/codex.mjs now counts them: only when the rollout
// covers the row's usage (rolloutCoversRow). Those rows
// counted a turn as tool calls plus one, which put the codex sweep of
// run-2026-09-20T17-48-17-298Z at 1299 and 1068 turns against 1195 and 1019
// requests. `turns_counted` keeps the row's own figure. A row carrying
// code_mode is returned as it is: the backend already chose its turns.
export function withRolloutFacts(row, runDir = null) {
  if (!row || row.code_mode || !runDir) return row;
  const facts = rolloutOf(row, runDir);
  if (!facts?.stats) return row;
  const whole = rolloutCoversRow(row, runDir);
  const requests = facts.stats.requests;
  return {
    ...row,
    code_mode: facts.stats,
    ...(whole && requests > 0 && row.turns != null ? { turns: requests, turns_counted: row.turns } : {}),
  };
}
