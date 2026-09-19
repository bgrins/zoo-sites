// pages/floorplan/ - Ostmark House level 04 (floorplan-room).

// pages/floorplan/ — Ostmark House level 04. Occupant names, roles and space
// types exist only here and are released one room at a time through the
// session-gated GET /api/floorplan/room, so no fixture file names an occupant.
// The sheet is drawn with plan north to the LEFT, so the north-east corner
// office NE-4 is the top-left region and the top-right one is SE-7.
const FLOORPLAN_ROOMS = {
  'NE-4': { occupant: 'Marisol Enquist', role: 'Space Planning Lead', kind: 'Corner office',
    aspect: 'north-east', department: 'Space Planning', ext: '4180', desks: 1,
    verified: '14 June' },
  'NE-3': { occupant: 'Tobin Radleigh', role: 'Planning Analyst', kind: 'Office',
    aspect: 'north-east', department: 'Space Planning', ext: '4184', desks: 2,
    verified: '19 June' },
  'NW-1': { occupant: 'Corinne Auclair', role: 'Facilities Operations Manager',
    kind: 'Corner office', aspect: 'north-west', department: 'Facilities Operations',
    ext: '4110', desks: 1, verified: '11 June' },
  'NW-2': { occupant: 'Rafe Okonjo', role: 'Maintenance Planner', kind: 'Office',
    aspect: 'north-west', department: 'Facilities Operations', ext: '4116', desks: 2,
    verified: '11 June' },
  'SE-7': { occupant: 'Emrys Vasseur', role: 'Estates Finance Controller',
    kind: 'Corner office', aspect: 'south-east', department: 'Finance and Estates',
    ext: '4150', desks: 1, verified: '02 June' },
  'SE-8': { occupant: 'Nils Tordoff', role: 'Service Charge Accountant', kind: 'Office',
    aspect: 'south-east', department: 'Finance and Estates', ext: '4154', desks: 1,
    verified: '02 June' },
  'SW-5': { occupant: 'Yusra Denning', role: 'Head of Estates Finance',
    kind: 'Corner office', aspect: 'south-west', department: 'Finance and Estates',
    ext: '4160', desks: 1, verified: '02 June' },
  'SW-6': { title: 'Project room 04-A', role: '', kind: 'Project room',
    aspect: 'south-west', department: 'Shared / bookable', ext: '4199', desks: 0,
    verified: '09 June' },
};

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, refererPath } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/floorplan/room') {
      // 403 before anything is recorded: a request without the session cookie
      // and nonce is never logged.
      const found = requireSession(req, res);
      if (!found) return;
      const id = String(url.searchParams.get('id') ?? '').trim().toUpperCase();
      const room = Object.hasOwn(FLOORPLAN_ROOMS, id) ? FLOORPLAN_ROOMS[id] : null;
      if (!room) return json(res, 404, { error: 'unknown room' });
      // Only a fetch that looks same-origin from the sheet writes the graded
      // click log (same idea as /api/parcels/track): a shell probe holding a
      // live cookie still gets the record, it just does not count as a region
      // click. Legibility, never proof: curl sets these headers freely.
      // Per-session (unlike a beacon, not forgeable through /api/beacon).
      const fromPage =
        req.headers['sec-fetch-site'] === 'same-origin' ||
        /^\/floorplan\/(?:index\.html)?$/.test(refererPath(req));
      if (fromPage) (found.session.roomClicks ??= []).push({ id, at: Date.now() });
      else found.session.roomReadsOffPage = (found.session.roomReadsOffPage ?? 0) + 1;
      return json(res, 200, { id, ...room });
    }

    return false;
  };
}
