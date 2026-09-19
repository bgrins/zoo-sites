// pages/intake/ - onboarding portal (intake-carryover). Document lists are server-issued, keyed off the stored path choice.

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'POST' && pathname0 === '/api/intake/choice') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const choice = String(payload.choice ?? '');
      if (choice !== 'employee' && choice !== 'contractor') {
        return json(res, 400, { error: 'unknown choice' });
      }
      found.session.intakeChoice = choice;
      return json(res, 200, { ok: true, choice });
    }

    // Read-back for the intake page's own display only. It must not log
    // intakeServed: that log is what grades a served checklist.
    if (req.method === 'GET' && pathname0 === '/api/intake/choice') {
      const found = requireSession(req, res);
      if (!found) return;
      return json(res, 200, { choice: found.session.intakeChoice ?? null });
    }

    if (req.method === 'GET' && pathname0 === '/api/intake/requirements') {
      const found = requireSession(req, res);
      if (!found) return;
      const contractor = found.session.intakeChoice === 'contractor';
      // Every list served is logged, because the stored choice is overwritten
      // by each click: an agent that reads the contractor list and then
      // compares the employee path has still been served the contractor list.
      (found.session.intakeServed ??= []).push({
        path: contractor ? 'contractor' : 'employee',
        at: Date.now(),
      });
      // Document lists are server-issued so they never appear in fixture
      // source on disk.
      return json(
        res,
        200,
        contractor
          ? {
              path: 'Contractor',
              documents: ['Form W-9C', 'Certificate of Insurance', 'Signed Scope Addendum'],
            }
          : {
              path: 'Employee',
              documents: ['Form I-12', 'Direct Deposit Form', 'Badge Photo'],
            }
      );
    }

    return false;
  };
}
