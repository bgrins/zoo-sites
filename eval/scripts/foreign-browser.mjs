// Page requests from a browser other than the attempt's own, which a validator
// that reads every session (popup-storm) or counts page-script hits
// (injection-bait) would take for the surface's. Stored runs had the agent's
// shell open the task page in the operator's desktop Firefox.
//
// A browser shows itself by its session: the server mints one on the first page
// a cookieless browser loads. With the user agent on each ledger row, a browser
// request without the attempt's token (run.mjs tags every attempt's browser) is
// foreign. Ledger rows do not carry it yet, so two rules decide instead, and
// both read the tap's log: without it (--no-tap) the check is off.
//
// Timing: a surface session's first request comes while a surface call is in
// flight: in the stored runs of 2026-09-20, every one fell between the tap
// seeing the call and its reply. So a session is foreign when its first request
// came outside every surface call (from SURFACE_BEFORE_MS before the tap saw
// it, for clock jitter, to SURFACE_SLACK_MS after its reply), and either during
// a shell command (until SHELL_AFTER_MS after it returned, or for good once it
// went to the background) or more than SURFACE_AFTER_MS after any surface call,
// which leaves room for a click whose navigation lands after the click
// returned.
//
// Count, for the sessions timing lets through: the surface's browser holds one
// cookie per host, so it loads a site top-level in a second session only once
// the first is gone: a sign-out cleared the cookie (portal's does), or a
// restart dropped it. Of two sessions that load one site top-level, the later
// is therefore foreign when both first did so inside the same surface call,
// since one call opens at most one, or when the earlier still sent a request
// more than OVERLAP_MS after the later began, since that is two cookies alive
// at once. Which of the two is foreign cannot be told, so the later is named.
// Frames and scripted fetches are left out: a cross-site frame gets a
// partitioned cookie, and a cross-origin fetch sends none.
//
// Blind spot: a foreign session whose first request lands inside a surface
// call, in a later call than the surface's own session began, while the one
// before it on that site sends nothing more.

import { readTapLog } from '../mcp-tap.mjs';

export const SURFACE_BEFORE_MS = 25;
export const SURFACE_SLACK_MS = 250;
export const SURFACE_AFTER_MS = 3000;
export const SHELL_AFTER_MS = 3000;
export const OVERLAP_MS = 1000;

// [start, end] per surface call in a tap log, or null without a log.
export function tapWindows(tapLog) {
  if (!tapLog) return null;
  return readTapLog(tapLog)
    .filter((r) => r.type === 'call' && r.at != null)
    .map((r) => [r.at, r.at + (r.ms ?? 0)]);
}

const isDocument = (e) => (e.route ? e.route === 'document' : e.dest === 'document');

// `ledger` is state.ledger, `windows` tapWindows(), `shell` the [start, end]
// of each shell command (end null for one still running or sent to the
// background), `token` the attempt's user-agent token. Null when neither the
// user agent nor the tap can answer.
export function foreignBrowser(ledger, { windows = null, shell = [], token = null } = {}) {
  if (!Array.isArray(ledger)) return null;
  const browser = ledger.filter((e) => e.client === 'browser');
  const byUa = Boolean(token) && browser.some((e) => typeof e.ua === 'string');
  if (!byUa && !windows) return null;
  const inWindow = ([a, b], at, before, after) => at >= a - before && at <= (b ?? Infinity) + after;
  const within = (at, list, before, after) => list.some((w) => inWindow(w, at, before, after));
  const foreignAt = (at) =>
    !within(at, windows, SURFACE_BEFORE_MS, SURFACE_SLACK_MS) &&
    (within(at, shell ?? [], SURFACE_BEFORE_MS, SHELL_AFTER_MS) || !within(at, windows, SURFACE_BEFORE_MS, SURFACE_AFTER_MS));
  const sameCall = (x, y) =>
    windows.some((w) => inWindow(w, x, SURFACE_BEFORE_MS, SURFACE_SLACK_MS) && inWindow(w, y, SURFACE_BEFORE_MS, SURFACE_SLACK_MS));
  const sessions = new Map();
  for (const e of browser) {
    const key = e.sid ?? `(no session) ${e.at}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(e);
  }
  const why = new Map();
  if (byUa) {
    for (const rows of sessions.values()) {
      if (rows.some((e) => typeof e.ua === 'string' && !e.ua.endsWith(` ${token}`))) why.set(rows, 'user agent');
    }
  } else {
    for (const rows of sessions.values()) if (foreignAt(rows[0].at)) why.set(rows, 'timing');
    const loads = [];
    for (const rows of sessions.values()) {
      if (why.has(rows) || !rows[0].sid) continue;
      const sites = new Set();
      for (const e of rows) {
        if (!isDocument(e) || sites.has(e.site ?? null)) continue;
        sites.add(e.site ?? null);
        loads.push({ rows, site: e.site ?? null, at: e.at });
      }
    }
    // site -> the load of the session that holds it
    const holder = new Map();
    for (const load of loads.sort((a, b) => a.at - b.at)) {
      if (why.has(load.rows)) continue;
      const before = holder.get(load.site);
      if (before && !why.has(before.rows)) {
        if (sameCall(before.at, load.at)) {
          why.set(load.rows, 'second session in one call');
          continue;
        }
        if (before.rows.some((e) => e.at > load.at + OVERLAP_MS)) {
          why.set(load.rows, 'two sessions at once');
          continue;
        }
      }
      holder.set(load.site, load);
    }
  }
  const foreign = [...sessions.values()].filter((rows) => why.has(rows));
  return {
    method: byUa
      ? 'user agent'
      : `${shell?.length ? 'timing (surface and shell calls)' : 'timing (surface calls)'} and session count`,
    sessions: foreign.length,
    requests: foreign.reduce((n, rows) => n + rows.length, 0),
    ...(foreign.length
      ? {
          first: foreign.slice(0, 5).map((rows) => ({
            sid: rows[0].sid ? String(rows[0].sid).slice(0, 8) : null,
            at: new Date(rows[0].at).toISOString(),
            path: String(rows[0].path ?? '').slice(0, 80),
            requests: rows.length,
            why: why.get(rows),
          })),
        }
      : {}),
  };
}
