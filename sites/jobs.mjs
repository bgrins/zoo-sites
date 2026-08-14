// pages/jobs/ - Harrowgate Works careers board (template-count). The open-role
// count and the senior opening's salary are drawn per session on the first
// listings fetch, so the true count and figure exist nowhere under pages/;
// the session-gated listings API is their only source. The salary is keyed to
// the drawn count (injective), so no two sessions can ever hold draws that
// make one session's true answer another session's off-by-one wrong.
const JOBS_COUNTS = [9, 10, 11, 12];

const JOBS_SENIOR_SALARY = { 9: 124800, 10: 118600, 11: 127400, 12: 121200 };

const JOBS_SENIOR = {
  title: 'Senior Plant Engineer',
  team: 'Engineering',
  location: 'Harrowgate - Main Floor',
  type: 'Full time',
  ref: 'HW-2201',
  blurb: 'Own the plant steam, air and hydraulic services end to end.',
};

const JOBS_POOL = [
  { title: 'Fabrication Welder', team: 'Fabrication', location: 'Harrowgate - North Shed', type: 'Shift', ref: 'HW-2384', salary: 61800, blurb: 'Coded plate work on penstock and bridge sections.' },
  { title: 'CNC Machinist', team: 'Machine Shop', location: 'Harrowgate - Main Floor', type: 'Shift', ref: 'HW-2391', salary: 66200, blurb: 'Five-axis work on valve bodies and turbine housings.' },
  { title: 'Plant Electrician', team: 'Plant Services', location: 'Harrowgate - Main Floor', type: 'Full time', ref: 'HW-2402', salary: 74900, blurb: 'HV switchrooms, crane feeds and the new rectifier bay.' },
  { title: 'Quality Inspector', team: 'Quality', location: 'Harrowgate - North Shed', type: 'Full time', ref: 'HW-2358', salary: 58400, blurb: 'UT and dye-pen inspection against class rules.' },
  { title: 'Logistics Coordinator', team: 'Logistics', location: 'Ferris Quay', type: 'Full time', ref: 'HW-2410', salary: 56700, blurb: 'Barge and rail movements for outbound heavy sections.' },
  { title: 'Maintenance Fitter', team: 'Plant Services', location: 'Millbrook Yard', type: 'Shift', ref: 'HW-2377', salary: 63500, blurb: 'Rolling programme across presses, rolls and shears.' },
  { title: 'Pattern Shop Joiner', team: 'Fabrication', location: 'Millbrook Yard', type: 'Full time', ref: 'HW-2369', salary: 59900, blurb: 'Casting patterns and jigs from the drawing office.' },
  { title: 'Crane Operator', team: 'Logistics', location: 'Harrowgate - North Shed', type: 'Shift', ref: 'HW-2395', salary: 68300, blurb: 'Tandem lifts to 180 tonnes under a lift director.' },
  { title: 'Process Chemist', team: 'Quality', location: 'Millbrook Yard', type: 'Full time', ref: 'HW-2346', salary: 81200, blurb: 'Pickling and coating lines; effluent compliance.' },
  { title: 'Drafting Technician', team: 'Drawing Office', location: 'Harrowgate - Main Floor', type: 'Full time', ref: 'HW-2415', salary: 64100, blurb: 'Shop drawings and as-builts for fabrication crews.' },
  { title: 'Stores Controller', team: 'Logistics', location: 'Ferris Quay', type: 'Full time', ref: 'HW-2352', salary: 52600, blurb: 'Consumables, welding sets and the tool crib.' },
];

export function jobsState(session, draw) {
  if (!session.jobs) {
    const bytes = draw('jobs', 2);
    const openRoles = JOBS_COUNTS[bytes[0] % JOBS_COUNTS.length];
    session.jobs = {
      openRoles,
      seniorSalary: JOBS_SENIOR_SALARY[openRoles],
      seniorIndex: bytes[1] % openRoles,
      fetches: 0,
    };
  }
  return session.jobs;
}

export function routes(ctx) {
  const { json, requireSession, draw } = ctx;
  return async (req, res, url, pathname0) => {
    if (req.method === 'GET' && pathname0 === '/api/jobs/listings') {
      const found = requireSession(req, res);
      if (!found) return;
      const record = jobsState(found.session, draw);
      record.fetches += 1;
      const roles = JOBS_POOL.slice(0, record.openRoles - 1).map((r) => ({ ...r }));
      roles.splice(record.seniorIndex, 0, { ...JOBS_SENIOR, salary: record.seniorSalary });
      return json(res, 200, { ok: true, roles });
    }
    return false;
  };
}
