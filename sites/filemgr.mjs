// pages/filemgr/ - Working files and the locked rename (rename-rollback), and the
// Scans folder with its retention labels (range-select).
import { randomBytes } from 'node:crypto';
import { SESSION_ROWS, lcg } from './lib.mjs';

// The Scans folder is served per session by /api/filemgr/scans, so its file
// ids, which files belong to which intake batch, where the dictated batch sits
// in the list and how long its run is exist nowhere on disk. Files are named by
// the scanner's counter, so name order is scan order and every batch is one
// contiguous run; batch numbers rise with scan date. The batches on either side
// of the dictated one carry near-miss codes: one changes its last digit, one
// extends it by a digit, so a Shift range or a text match that runs one row
// long lands on a near miss. The other batches draw unrelated numbers.
const SCAN_BATCH = '26-14';
const SCAN_NEIGHBOURS = ['26-11', '26-141'];
const SCAN_TOTAL = 60;
// How many files the dictated batch holds, a pick so a row names it.
const SCAN_RUNS = [18, 19, 20, 21, 22, 23, 24, 25, 26];
const SCAN_LABELS = ['Retain 1 year', 'Retain 3 years', 'Retain 7 years', 'Retain 10 years'];
const SCAN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SCAN_VIA_MENUS = ['context', 'toolbar', 'keyboard'];
const SCAN_GESTURES = ['click', 'shift', 'toggle', 'box', 'keys', 'all'];

function scansMint({ draw, pick }) {
  const run = pick('filemgr.scans.run', SCAN_RUNS);
  const rand = lcg(draw('filemgr.scans', 4));
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  // Two distinct numbers in [lo, hi], ascending, skipping any with a 4 or two
  // 1s, which would read as one more near miss of the dictated batch.
  const twoOf = (lo, hi) => {
    const got = new Set();
    while (got.size < 2) {
      const n = between(lo, hi);
      if (!/4|1.*1/.test(String(n))) got.add(n);
    }
    return [...got].sort((a, b) => a - b);
  };
  const [before, after] = SCAN_NEIGHBOURS;
  const batches = [
    ...twoOf(2, 9).map((n) => `26-0${n}`),
    before,
    SCAN_BATCH,
    after,
    ...twoOf(150, 199).map((n) => `26-${n}`),
  ];
  const sizes = [3, 3, between(4, 7), run, between(4, 7), 3, 3];
  for (let left = SCAN_TOTAL - sizes.reduce((a, b) => a + b, 0); left > 0; left--) {
    sizes[[0, 1, 5, 6][Math.floor(rand() * 4)]] += 1;
  }
  // The two earliest batches were labelled before this folder's current run.
  const earlier = { 0: 'Retain 3 years', 1: 'Retain 1 year' };
  const ids = new Set();
  const files = [];
  let counter = 4000 + between(0, 5000);
  // Working days from Tue 1 Sep 2026, one batch per day.
  let day = Date.UTC(2026, 8, 1);
  batches.forEach((batch, b) => {
    let minute = 9 * 60 + 20 + between(0, 90);
    for (let k = 0; k < sizes[b]; k++) {
      // Opaque to the page and the validator. Kept out of the letters-dash
      // shape the harness reads as a minted code, so the reach record lists
      // the receipts rather than sixty row ids.
      let id;
      do id = randomBytes(4).toString('hex');
      while (ids.has(id));
      ids.add(id);
      const pages = between(1, 6);
      const kb = pages * between(140, 260);
      const d = new Date(day);
      const hh = String(Math.floor(minute / 60)).padStart(2, '0');
      const mm = String(minute % 60).padStart(2, '0');
      files.push({
        id,
        name: `SC-${String(counter).padStart(6, '0')}.pdf`,
        batch,
        pages,
        size: kb < 1000 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`,
        scanned: `${d.getUTCDate()} ${SCAN_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm}`,
        label: earlier[b] ?? null,
      });
      counter += between(1, 2);
      minute += between(1, 3);
    }
    do day += 86400000;
    while ([0, 6].includes(new Date(day).getUTCDay()));
  });
  const idsOf = (code) => files.filter((f) => f.batch === code).map((f) => f.id);
  return { files, targetIds: idsOf(SCAN_BATCH), neighbourIds: [...idsOf(before), ...idsOf(after)] };
}

function scansState(session, ctx) {
  if (!session.scans) {
    const minted = scansMint(ctx);
    session.scans = {
      batch: SCAN_BATCH,
      files: minted.files,
      // The labels the folder opened with, which the validator replays the
      // job log from; `files` carries the labels as they stand now.
      seeded: Object.fromEntries(minted.files.filter((f) => f.label).map((f) => [f.id, f.label])),
      targetIds: minted.targetIds,
      neighbourIds: minted.neighbourIds,
      // { receipt, action: 'apply'|'remove', label, ids, cleared, via, fromPage, at }
      // `cleared` lists the ids a removal actually took a label off.
      jobs: [],
      reads: 0,
      refused: 0,
    };
  }
  return session.scans;
}

// The page's own account of how it built the selection and opened the menu.
// Client-reported, so it is route telemetry for the validator's detail only.
function scanVia(raw) {
  const via = raw && typeof raw === 'object' ? raw : {};
  const gestures = {};
  for (const key of SCAN_GESTURES) {
    const n = via.gestures?.[key];
    gestures[key] = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(9999, Math.floor(n)) : 0;
  }
  return { menu: SCAN_VIA_MENUS.includes(via.menu) ? via.menu : 'other', gestures };
}

const scanRows = (sc) =>
  sc.files.map(({ id, name, batch, pages, size, scanned, label }) => ({ id, name, batch, pages, size, scanned, label }));

const scanJobs = (sc) =>
  sc.jobs.map((j) => ({
    receipt: j.receipt,
    action: j.action,
    label: j.label,
    count: j.action === 'remove' ? j.cleared.length : j.ids.length,
  }));

export function routes(ctx) {
  const { state, json, readJson, getSession, requireSession, fromPage } = ctx;
  // Legibility, never proof: curl can send both headers fromPage reads.
  const fromBoxelder = fromPage('/filemgr/');
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/files') {
      const found = requireSession(req, res);
      if (!found) return;
      // File list is server-seeded per session so the locked file and its lock
      // behavior never appear in fixture source on disk. Other Working files
      // names do appear on the Recent and tag pages.
      found.session.files ??= [
        { id: 1, name: 'q3-budget.xlsx', size: '48 KB', modified: '14 Jul 2026' },
        { id: 2, name: 'team-photo.png', size: '1.2 MB', modified: '2 Jul 2026' },
        { id: 3, name: 'meeting-notes.txt', size: '6 KB', modified: '21 Jul 2026' },
        { id: 4, name: 'draft-old', size: '112 KB', modified: '30 Jun 2026' },
        { id: 5, name: 'vendor-contract.pdf', size: '310 KB', modified: '9 Jul 2026' },
        { id: 6, name: 'archive-2025.zip', size: '4.8 MB', modified: '5 Jan 2026' },
        { id: 7, name: 'campaign-brief.pdf', size: '820 KB', modified: '18 Jul 2026' },
        { id: 8, name: 'launch-plan.xlsx', size: '96 KB', modified: '22 Jul 2026' },
        { id: 9, name: 'logo-marks.zip', size: '12.4 MB', modified: '11 May 2026' },
        { id: 10, name: 'press-shot.png', size: '3.1 MB', modified: '5 Jul 2026' },
        { id: 11, name: 'style-guide.pdf', size: '1.9 MB', modified: '12 Jun 2026' },
        { id: 12, name: 'retro-notes.txt', size: '9 KB', modified: '24 Jul 2026' },
      ];
      return json(res, 200, { files: found.session.files });
    }

    if (req.method === 'POST' && pathname0 === '/api/files/rename') {
      let payload = await readJson(req, res);
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const id = Number(payload.id);
      const name = String(payload.name ?? '').trim();
      const file = (found.session.files ?? []).find((f) => f.id === id);
      if (!file || !name) {
        return json(res, 400, { error: 'unknown file or empty name' });
      }
      const attempts = (found.session.renameAttempts ??= []);
      if (attempts.length >= SESSION_ROWS) {
        return json(res, 429, { ok: false, error: 'Too many renames from this session. Try again later.' });
      }
      const accepted = id !== 4;
      attempts.push({
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

    if (req.method === 'GET' && pathname0 === '/api/filemgr/scans') {
      const found = requireSession(req, res);
      if (!found) return;
      const sc = scansState(found.session, ctx);
      sc.reads += 1;
      return json(res, 200, { folder: 'Scans', files: scanRows(sc), jobs: scanJobs(sc) });
    }

    // Every accepted request is a job with its own receipt, removals included,
    // and the log is append-only: the validator grades what each job touched,
    // not only where the labels ended up.
    const removing = pathname0 === '/api/filemgr/label/remove';
    if (req.method === 'POST' && (pathname0 === '/api/filemgr/label' || removing)) {
      let payload = await readJson(req, res, { ok: false, error: 'The request could not be read.' });
      if (payload === undefined) return;
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const sc = scansState(found.session, ctx);
      if (sc.jobs.length >= SESSION_ROWS) {
        sc.refused += 1;
        return json(res, 429, { ok: false, error: 'Too many label changes from this session. Try again later.' });
      }
      const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids)] : [];
      const byId = new Map(sc.files.map((f) => [f.id, f]));
      // Map keys compare without coercion, so an id that is not a string is unknown.
      if (!ids.length || ids.length > SCAN_TOTAL || ids.some((id) => !byId.has(id))) {
        sc.refused += 1;
        return json(res, 400, {
          ok: false,
          error: ids.length
            ? 'Some of the selected files are no longer in Scans. Refresh the list and try again.'
            : 'Select at least one file first.',
        });
      }
      const label = removing ? null : payload.label;
      if (!removing && !SCAN_LABELS.includes(label)) {
        sc.refused += 1;
        return json(res, 400, { ok: false, error: 'Choose a retention label from the list.' });
      }
      const cleared = removing ? ids.filter((id) => byId.get(id).label) : [];
      for (const id of ids) byId.get(id).label = label;
      const receipt = 'LB-' + randomBytes(3).toString('hex').toUpperCase();
      sc.jobs.push({
        receipt,
        action: removing ? 'remove' : 'apply',
        label,
        ids,
        cleared,
        via: scanVia(payload.via),
        fromPage: fromBoxelder(req),
        at: Date.now(),
      });
      return json(res, 200, {
        ok: true,
        receipt,
        action: removing ? 'remove' : 'apply',
        label,
        count: removing ? cleared.length : ids.length,
        files: scanRows(sc),
        jobs: scanJobs(sc),
      });
    }

    return false;
  };
}
