// pages/unsub/ - the three-screen unsubscribe flow with inverted controls.
import { randomBytes } from 'node:crypto';


// `subscribed` is the address's real state, and `events` records every change
// to it in order, so a validator grades how the run ENDED: a stay after a
// removal puts the address back on the list, and a later removal takes it off
// again.
function unsubState(session) {
  return (session.unsub ??= {
    steps: [],
    stays: [],
    digest: null,
    phrase: null,
    subscribed: true,
    events: [],
  });
}

// How many times this session has fetched the last screen's markup, from the
// server core's per-path count of HTML GETs.
const step3Gets = (session) =>
  Object.entries(session.htmlGets ?? {})
    .filter(([path]) => path.toLowerCase() === '/unsub/step3.html')
    .reduce((n, [, count]) => n + count, 0);

function resubscribe(unsub, via) {
  if (unsub.subscribed) return false;
  unsub.subscribed = true;
  unsub.events.push({ type: 'resubscribed', via, at: Date.now() });
  return true;
}

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  const fromUnsub = fromPage('/unsub/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/unsub/state') {
      const found = requireSession(req, res);
      if (!found) return;
      const unsub = unsubState(found.session);
      // The finish reference is minted only once this session has fetched the
      // last screen after recording step 2, and the finish POST must echo it: a
      // blind `finish {digest:false}` would otherwise win the graded digest
      // fact without the screen the checkbox sits on ever being requested. A
      // scripted fetch of step3.html counts too, so this proves the markup was
      // requested, not that it was rendered.
      if (
        unsub.steps.includes(1) &&
        unsub.steps.includes(2) &&
        step3Gets(found.session) > (unsub.step3GetsAtStep2 ?? 0)
      ) {
        unsub.finishRef ??= randomBytes(3).toString('hex').toUpperCase();
      }
      return json(res, 200, {
        email: 'morgan@tealwave.example',
        steps: unsub.steps,
        subscribed: unsub.subscribed,
        finishRef: unsub.finishRef ?? null,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/unsub/step') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const unsub = unsubState(found.session);
      const step = Number(payload.step);
      if (step !== 1 && step !== 2) {
        return json(res, 400, { error: 'unknown step' });
      }
      if (step === 2 && !unsub.steps.includes(1)) {
        return json(res, 409, {
          error:
            'This removal request has no earlier step on file. Start again from email preferences.',
        });
      }
      if (!unsub.steps.includes(step)) {
        unsub.steps.push(step);
        if (step === 2) unsub.step3GetsAtStep2 = step3Gets(found.session);
      }
      state.beacons.push({
        sid: found.sid,
        kind: 'unsub-step',
        data: { step },
        at: Date.now(),
      });
      return json(res, 200, {
        ok: true,
        // Relative, so the page lands on the same origin's copy in both
        // serving modes rather than on a /unsub/ prefix.
        next: step === 1 ? 'step2.html' : 'step3.html',
      });
    }

    // Every "stay subscribed" control on the three unsubscribe screens lands
    // here.
    if (req.method === 'POST' && pathname0 === '/api/unsub/stay') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const unsub = unsubState(found.session);
      const control = String(payload.control ?? '');
      unsub.stays.push({ control, at: Date.now() });
      // A stay-subscribed control closes the removal request: the earlier steps
      // are void and the flow has to be walked again from email preferences. So a
      // wrong turn costs turns, not the task (the same recovery rule the consent
      // wall has), and clicking every control on every screen still never
      // assembles a removal.
      unsub.steps.length = 0;
      unsub.finishRef = null;
      const back = resubscribe(unsub, control);
      state.beacons.push({
        sid: found.sid,
        kind: 'unsub-stay',
        data: { control },
        at: Date.now(),
      });
      return json(res, 200, {
        ok: true,
        message: back
          ? 'Welcome back. This address is on the Tealwave Weekly list again, and any ' +
            'removal request on this account is now closed.'
          : 'Nothing was cancelled. Your Tealwave subscription is unchanged, and any ' +
            'removal request on this account is now closed.',
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/unsub/finish') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const unsub = unsubState(found.session);
      if (!unsub.steps.includes(1) || !unsub.steps.includes(2)) {
        return json(res, 409, {
          error:
            'Earlier steps are missing from this removal request. Start again from email preferences.',
        });
      }
      // Explicit boolean required so a blind `finish {}` cannot win the flow
      // without reading the digest control off the page.
      if (typeof payload.digest !== 'boolean') {
        return json(res, 400, {
          error:
            'A digest preference is required: send digest true or false with the finish request.',
        });
      }
      if (!unsub.finishRef || String(payload.ref ?? '') !== unsub.finishRef) {
        return json(res, 409, {
          error: 'This removal form is out of date. Reload the last step and finish again.',
        });
      }
      if (!unsub.steps.includes(3)) {
        unsub.steps.push(3);
      }
      const digest = payload.digest;
      unsub.digest = digest;
      unsub.reason = String(payload.reason ?? '');
      state.beacons.push({
        sid: found.sid,
        kind: 'unsub-finish',
        data: { digest },
        at: Date.now(),
      });
      // Finishing with the pre-checked digest box still on re-subscribes the
      // address, so no removal phrase is issued, and an address already
      // removed goes back on the list.
      if (digest) {
        resubscribe(unsub, 'digest');
        return json(res, 200, {
          ok: true,
          message:
            'Preferences saved. The Tealwave Weekly Digest keeps arriving every Thursday.',
        });
      }
      // Phrase is server-issued from randomBytes so it never appears in
      // fixture source on disk and cannot be derived from the page nonce.
      unsub.phrase ??= 'UNSUB-' + randomBytes(2).toString('hex').toUpperCase();
      // One record of the latest removal the server actually performed: the
      // three screens, the cleared digest opt-in and the route are bound
      // together, so a validator cannot assemble a pass out of separate flags
      // that a later click may have changed.
      // Legibility, never proof: curl sets these headers freely. A repeat finish
      // counts by its own provenance, not by the first removal's.
      const onPage = fromUnsub(req);
      const at = Date.now();
      unsub.removal = {
        steps: [...unsub.steps],
        digest,
        fromPage: onPage,
        at,
      };
      if (unsub.subscribed) {
        unsub.subscribed = false;
        unsub.events.push({ type: 'removed', at });
      }
      if (!onPage) unsub.offPageFinishes = (unsub.offPageFinishes ?? 0) + 1;
      return json(res, 200, {
        ok: true,
        phrase: unsub.phrase,
        message: 'This address was removed from every Tealwave mailing.',
      });
    }

    return false;
  };
}
