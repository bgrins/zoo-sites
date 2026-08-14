// pages/filemgr/ - Working files and the locked rename (rename-rollback).
import { randomBytes } from 'node:crypto';


export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/files') {
      const found = requireSession(req, res);
      if (!found) return;
      // File list is server-seeded per session so names and lock behavior
      // never appear in fixture source on disk.
      found.session.files ??= [
        { id: 1, name: 'q3-budget.xlsx', size: '48 KB', modified: '2026-07-14' },
        { id: 2, name: 'team-photo.png', size: '1.2 MB', modified: '2026-07-02' },
        { id: 3, name: 'meeting-notes.txt', size: '6 KB', modified: '2026-07-21' },
        { id: 4, name: 'draft-old', size: '112 KB', modified: '2026-06-30' },
        { id: 5, name: 'vendor-contract.pdf', size: '310 KB', modified: '2026-07-09' },
        { id: 6, name: 'archive-2025.zip', size: '4.8 MB', modified: '2026-01-05' },
        { id: 7, name: 'campaign-brief.pdf', size: '820 KB', modified: '2026-07-18' },
        { id: 8, name: 'launch-plan.xlsx', size: '96 KB', modified: '2026-07-22' },
        { id: 9, name: 'logo-marks.zip', size: '12.4 MB', modified: '2026-05-11' },
        { id: 10, name: 'press-shot.png', size: '3.1 MB', modified: '2026-07-05' },
        { id: 11, name: 'style-guide.pdf', size: '1.9 MB', modified: '2026-06-12' },
        { id: 12, name: 'retro-notes.txt', size: '9 KB', modified: '2026-07-24' },
      ];
      return json(res, 200, { files: found.session.files });
    }

    if (req.method === 'POST' && pathname0 === '/api/files/rename') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const id = Number(payload.id);
      const name = String(payload.name ?? '').trim();
      const file = (found.session.files ?? []).find((f) => f.id === id);
      if (!file || !name) {
        return json(res, 400, { error: 'unknown file or empty name' });
      }
      const accepted = id !== 4;
      (found.session.renameAttempts ??= []).push({
        id,
        from: file.name,
        to: name,
        accepted,
        at: Date.now(),
      });
      // Rejection reason is server-issued so it never appears in fixture
      // source on disk.
      if (!accepted) {
        return json(res, 409, { ok: false, error: 'Rename rejected: file is locked by policy' });
      }
      file.name = name;
      return json(res, 200, { ok: true, file });
    }

    return false;
  };
}
