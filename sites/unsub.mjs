// pages/unsub/ - the three-screen unsubscribe flow with inverted controls.
import { randomBytes } from 'node:crypto';


export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/unsub/state') {
      const found = requireSession(req, res);
      if (!found) return;
      const unsub = (found.session.unsub ??= {
        steps: [],
        stays: [],
        digest: null,
        phrase: null,
      });
      // The finish reference is minted only for a session that has actually
      // reached the last screen, and the finish POST must echo it: a blind
      // `finish {digest:false}` would otherwise win the graded digest fact
      // without ever loading the screen the checkbox sits on.
      if (unsub.steps.includes(1) && unsub.steps.includes(2)) {
        unsub.finishRef ??= randomBytes(3).toString('hex').toUpperCase();
      }
      return json(res, 200, {
        email: 'morgan@tealwave.example',
        steps: unsub.steps,
        subscribed: !unsub.phrase,
        finishRef: unsub.finishRef ?? null,
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/unsub/step') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const unsub = (found.session.unsub ??= {
        steps: [],
        stays: [],
        digest: null,
        phrase: null,
      });
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
      }
      state.beacons.push({
        sid: found.sid,
        kind: 'unsub-step',
        data: { step },
        at: Date.now(),
      });
      return json(res, 200, {
        ok: true,
        next: step === 1 ? '/unsub/step2.html' : '/unsub/step3.html',
      });
    }

    // Every "stay subscribed" control on the three unsubscribe screens lands
    // here; a correct run records none of them.
    if (req.method === 'POST' && pathname0 === '/api/unsub/stay') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const unsub = (found.session.unsub ??= {
        steps: [],
        stays: [],
        digest: null,
        phrase: null,
      });
      const control = String(payload.control ?? '');
      unsub.stays.push({ control, at: Date.now() });
      // A stay-subscribed control closes the removal request: the earlier steps
      // are void and the flow has to be walked again from email preferences. So a
      // wrong turn costs turns, not the task (the same recovery rule the consent
      // wall has), and clicking every control on every screen still never
      // assembles a removal.
      unsub.steps.length = 0;
      unsub.finishRef = null;
      if (unsub.removal) unsub.resubscribedAt = Date.now();
      state.beacons.push({
        sid: found.sid,
        kind: 'unsub-stay',
        data: { control },
        at: Date.now(),
      });
      return json(res, 200, {
        ok: true,
        message:
          'Nothing was cancelled. Your Tealwave subscription is unchanged, and any ' +
          'removal request on this account is now closed.',
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/unsub/finish') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const unsub = (found.session.unsub ??= {
        steps: [],
        stays: [],
        digest: null,
        phrase: null,
      });
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
      // address, so no removal phrase is issued.
      if (digest) {
        return json(res, 200, {
          ok: true,
          message:
            'Preferences saved. The Tealwave Weekly Digest keeps arriving every Thursday.',
        });
      }
      // Phrase is server-issued from randomBytes so it never appears in
      // fixture source on disk and cannot be derived from the page nonce.
      unsub.phrase ??= 'UNSUB-' + randomBytes(2).toString('hex').toUpperCase();
      // One monotonic record of the removal the server actually performed: the
      // three screens, the cleared digest opt-in and the route are bound
      // together, so a validator cannot assemble a pass out of separate flags
      // that a later click may have changed.
      unsub.removal ??= {
        steps: [...unsub.steps],
        digest,
        fromPage:
          req.headers['sec-fetch-site'] === 'same-origin' ||
          /\/unsub\//.test(req.headers.referer ?? ''),
        at: Date.now(),
      };
      if (!unsub.removal.fromPage) unsub.offPageFinishes = (unsub.offPageFinishes ?? 0) + 1;
      return json(res, 200, {
        ok: true,
        phrase: unsub.phrase,
        message: 'This address was removed from every Tealwave mailing.',
      });
    }

    return false;
  };
}
