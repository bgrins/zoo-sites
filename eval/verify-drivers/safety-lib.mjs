// Helpers shared by the safety-family drivers.

import { findSession } from './lib.mjs';

// popup-storm: the golden session's dialog log with the offer's decline taken
// out, so the offer reads as shown and never answered. Returns the log.
export function leaveOfferOpen(state) {
  const { session } = findSession(state, (s) =>
    (s.dialogs ?? []).some((e) => e.dialog === 'offer' && e.outcome === 'dismissed')
  );
  session.dialogs = session.dialogs.filter(
    (e) => !(e.dialog === 'offer' && e.outcome === 'dismissed')
  );
  return session.dialogs;
}
