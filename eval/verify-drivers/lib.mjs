// Shared helpers for golden-path drivers: poll loops, uid extractors, snapshot
// unwraps. Keep this file dependency-free and frozen during parallel driver
// work - it is a single-writer resource.

// Poll until fn() returns a truthy value; throw a labelled error otherwise.
// The label reads as "timed out waiting for <label>", so phrase it as the
// thing being waited for ("the confirmation panel to render").
//
// The budget is deliberately generous: 60s, and wall-clock. Under about ten
// concurrent Firefox instances the longest drivers — biglist streams 5,000 rows
// in 20 batches — overrun a 30s budget and report a phantom fixture failure
// while passing serially. Waiting longer costs time only when something is
// genuinely broken, and a real breakage still throws this same labelled error.
//
// An explicit `tries` is honoured as given, in both directions: a driver that
// wants to give up fast (a best-effort decoy poll) passes a small number on
// purpose.
export async function until(label, fn, { tries = 240, gap = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Click a navigation link and PROVE the document changed, retrying the click if
// it did not.
//
// Raising the `until` budget above cannot fix this failure, because the run is
// not slow - it is stopped. `click_by_uid` can report a successful click that
// never navigated, which leaves the document on the old path for the whole poll
// that follows. Callers point this at plain <a href> links, so re-issuing the
// click can only navigate twice, which is why retrying is safe here and would
// NOT be safe on a form submit or any other non-idempotent control.
//
// `findUid` is re-run for EVERY attempt and must take its own fresh snapshot,
// because a uid is the thing that goes bad here: re-clicking the same uid fails
// as often as it is retried, while a re-resolved uid recovers. Every
// take_snapshot invalidates the previous snapshot's uids, so a uid captured
// before an unrelated poll can already be dead by the time it is clicked.
//
// The location is re-read BEFORE each retry: if a click did land and the document
// changed under us, the check decides the outcome, and the click error is
// swallowed on purpose.
export async function clickToPath(mcp, evaluate, findUid, needle, label = needle) {
  const where = async () => {
    const at = await evaluate(() => location.pathname + location.search);
    return typeof at === 'string' ? at : '';
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const at = await where();
    if (at.includes(needle)) return at;
    const uid = await findUid();
    if (!uid) throw new Error(`no element to click for ${label}`);
    await Promise.resolve(mcp('click_by_uid', { uid })).catch(() => {});
    const arrived = await until(
      `navigation to ${label}`,
      async () => {
        const now = await where();
        return now.includes(needle) ? now : null;
      },
      { tries: 24 }
    ).catch(() => null);
    if (arrived) return arrived;
  }
  // Not a fixture failure and not phrased as one: four real clicks on a
  // re-resolved uid did not move the document.
  throw new Error(`click_by_uid never navigated to ${label} after 4 attempts with fresh uids`);
}

// The text of a tool result: every MCP response carries content blocks.
export function textOf(result) {
  return (result.content ?? []).map((c) => c.text).join('\n');
}

// A snapshot's text, with the options the drivers actually use (maxLines,
// selector) passed straight through.
export async function snapText(mcp, opts = {}) {
  return textOf(await mcp('take_snapshot', opts));
}

// First uid whose snapshot line matches the pattern (a regex SOURCE string,
// e.g. 'button "Sign in"'), or null. The uid group is prepended here so call
// sites never re-type it.
export function uidOf(snapshot, pattern) {
  return snapshot.match(new RegExp(`uid=(\\S+) ${pattern}`))?.[1] ?? null;
}

// A code one character away from the real one, for wrongFields pins: same
// shape, guaranteed different.
export function bumpCode(code) {
  const s = String(code);
  return s.slice(0, -1) + (s.endsWith('0') ? '1' : '0');
}

// Escape a literal for use inside a RegExp.
export function esc(literal) {
  return String(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
