// Golden path for T132 faceted-search (pages/roles/). Drives the Alderpost
// refine panel the way an agent must: reads the per-session brief out of the
// snapshot, ticks the three obvious facets through click_by_uid, walks into the
// salary dead end ON PURPOSE and backs out of it through the applied-filter
// chip, then opens the single surviving vacancy and reads its reference. No
// evaluate_script anywhere — the whole task is winnable from snapshot + click,
// which is the thing worth regression-testing.
//
// Three measured properties of our surface this driver is written around:
//   - <legend> never reaches the snapshot, so the four facet groups arrive as
//     one flat list of 21 checkboxes with no group boundary;
//   - a native checkbox's checked state never reaches the snapshot either, so
//     the applied-filter chips are the only readable record of what is on;
//   - every href is absolutized and cut at 27 chars, so a result row's vacancy
//     id is unreadable and the link has to be clicked rather than followed.

import { randomBytes } from 'node:crypto';
import { addSession, esc, findSession, snapText, uidOf, until } from './lib.mjs';

const PATH = '/roles/';
const CHROME_LINKS = /a "(Alderpost|Vacancy search|Clients|Desk notes|Back to vacancy search)"/;

const snapshot = (mcp) => snapText(mcp, { maxLines: 500 });

// The brief renders each line as an <li> whose own text is the VALUE and whose
// child <span> is the key, so the value sits on the line before its key.
function briefValue(snap, key) {
  const lines = snap.split('\n');
  const at = lines.findIndex((l) => new RegExp(`span text="${esc(key)}"`).test(l));
  if (at <= 0) return null;
  return lines[at - 1].match(/text="([^"]*)"/)?.[1] ?? null;
}

// The tally sits in a sibling <span> immediately after the checkbox.
function facetCount(snap, label) {
  const lines = snap.split('\n');
  const at = lines.findIndex((l) => l.includes(`input "${label}"`));
  if (at === -1) return null;
  const found = lines[at + 1]?.match(/span text="(\d+)"/);
  return found ? Number(found[1]) : null;
}

function totalOf(snap) {
  const found = snap.match(/p text="(\d+) vacanc/);
  return found ? Number(found[1]) : null;
}

function chipsOf(snap) {
  return [...snap.matchAll(/button "Remove ([^"]+)"/g)].map((m) => m[1]);
}

function poundsOf(text) {
  return [...text.matchAll(/£([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
}

// "£50,000 to £60,000" and the open-ended "£75,000 and above" alike.
function bandBounds(label) {
  const numbers = poundsOf(label);
  return { low: numbers[0], high: numbers.length > 1 ? numbers[1] : Infinity };
}

// A second desk as a curl probe or a re-minted cookie would mint it: the same
// shape with its own ids and references, and its own target opened.
function strayDesk(state) {
  const desk = structuredClone(findSession(state, (s) => s.roles).session.roles);
  for (const posting of desk.postings) {
    const id = 'alp-' + randomBytes(3).toString('hex');
    if (posting.id === desk.targetId) desk.targetId = id;
    posting.id = id;
    posting.ref = 'AR-' + randomBytes(3).toString('hex').toUpperCase();
  }
  desk.targetRef = desk.postings.find((p) => p.id === desk.targetId).ref;
  desk.opened = [desk.targetId];
  return desk;
}

export const DRIVERS = {
  'faceted-search': {
    note: 'reads the per-session brief, drives four facets, recovers from an empty result set',
    wrongState: [
      {
        name: 'the target record was never opened',
        mutate: (state) => {
          const { roles } = findSession(state, (s) => s.roles).session;
          roles.opened = roles.opened.filter((id) => id !== roles.targetId);
        },
      },
    ],
    // Minted before and after the golden desk, so neither "first desk" nor
    // "latest desk to open its target" can stand in for "the desk the answer
    // quotes".
    alsoCorrectState: [
      {
        name: 'a stray desk minted first opened its own target',
        mutate: (state) => addSession(state, { roles: strayDesk(state) }, { first: true }),
      },
      {
        name: 'a stray desk minted last opened its own target',
        mutate: (state) => addSession(state, { roles: strayDesk(state) }),
      },
    ],
    async run({ goto, mcp }) {
      await goto(PATH);
      let snap = await until('the desk to answer', async () => {
        const s = await snapshot(mcp);
        return /span text="Discipline"/.test(s) && totalOf(s) !== null ? s : null;
      });

      const brief = {
        discipline: briefValue(snap, 'Discipline'),
        base: briefValue(snap, 'Base'),
        contract: briefValue(snap, 'Contract'),
        salary: briefValue(snap, 'Salary'),
        secondary: briefValue(snap, 'Also open to'),
      };
      for (const [key, value] of Object.entries(brief)) {
        if (!value) throw new Error(`the brief's ${key} line is missing from the snapshot`);
      }
      // "Fixed term, 12 months" on the brief is the "Fixed term" facet value.
      const contractValue = brief.contract.split(',')[0].trim();
      const [floor, ceiling] = poundsOf(brief.salary);
      if (!(floor > 0 && ceiling > floor)) {
        throw new Error(`could not read a salary range out of "${brief.salary}"`);
      }

      const applyFacet = async (label) => {
        const uid = uidOf(snap, `input "${esc(label)}"`);
        if (!uid) throw new Error(`no "${label}" checkbox in the refine panel`);
        await mcp('click_by_uid', { uid });
        snap = await until(`the "${label}" filter to apply`, async () => {
          const s = await snapshot(mcp);
          return chipsOf(s).includes(label) ? s : null;
        });
      };
      const dropChip = async (label) => {
        const uid = uidOf(snap, `button "Remove ${esc(label)}"`);
        if (!uid) throw new Error(`no chip to remove "${label}"`);
        await mcp('click_by_uid', { uid });
        snap = await until(`the "${label}" filter to come off`, async () => {
          const s = await snapshot(mcp);
          return chipsOf(s).includes(label) ? null : s;
        });
      };

      await applyFacet(brief.discipline);
      await applyFacet(brief.base);
      await applyFacet(contractValue);
      const narrowed = totalOf(snap);
      if (!(narrowed > 1)) {
        throw new Error(`three facets should leave several vacancies, they left ${narrowed}`);
      }

      // Which band wins and which one is the trap is drawn per session, so both
      // are read off the brief's own numbers: the winning band sits wholly
      // inside the client's range, the trap is the band the ceiling falls into
      // without being covered by it.
      const bands = [...snap.matchAll(/input "(£[^"]+)"/g)].map((m) => m[1]);
      if (bands.length !== 5) throw new Error(`expected 5 salary bands, saw ${bands.length}`);
      const winning = bands.find((label) => {
        const { low, high } = bandBounds(label);
        return low >= floor && high <= ceiling;
      });
      if (!winning) throw new Error('no salary band sits inside the brief');
      const trapBand = bands.find((label) => {
        const { low, high } = bandBounds(label);
        return label !== winning && low <= ceiling && high > ceiling;
      });
      if (!trapBand) throw new Error('no salary band overshoots the brief the way the trap must');

      // The counts are the whole point of the panel: the band above the client's
      // ceiling already reads zero before it is clicked.
      const trapCount = facetCount(snap, trapBand);
      if (trapCount !== 0) {
        throw new Error(`the band above the ceiling should be empty, it counts ${trapCount}`);
      }

      // Walk into the dead end deliberately and back out of it through the chip
      // row, because recovering from over-filtering is half of what this task
      // exists to measure.
      await applyFacet(trapBand);
      if (totalOf(snap) !== 0) throw new Error('the trap band did not empty the result set');
      if (!/h3 "Nothing matches"/.test(snap)) {
        throw new Error('the empty-result panel did not render');
      }
      await dropChip(trapBand);
      if (totalOf(snap) !== narrowed) {
        throw new Error(`backing the band off left ${totalOf(snap)}, not ${narrowed}`);
      }

      await applyFacet(winning);
      if (totalOf(snap) !== 1) {
        throw new Error(`the four facets left ${totalOf(snap)} vacancies, not 1`);
      }

      const rows = snap.split('\n');
      const linkAt = rows.findIndex((l) => /uid=\S+ a "/.test(l) && !CHROME_LINKS.test(l));
      if (linkAt === -1) throw new Error('no vacancy link in the single-result list');
      const targetUid = rows[linkAt].match(/uid=(\S+) a "/)[1];
      const targetTitle = rows[linkAt].match(/a "([^"]*)"/)?.[1] ?? '';
      const targetEmployer = rows[linkAt + 1]?.match(/text="([^"]*)"/)?.[1] ?? '';

      await mcp('click_by_uid', { uid: targetUid });
      const record = await until('the vacancy record to open', async () => {
        const s = await snapshot(mcp);
        return /p text="Reference AR-/.test(s) ? s : null;
      });
      const reference = record.match(/text="Reference (AR-[0-9A-F]{6})"/)?.[1] ?? null;
      if (!reference) throw new Error('no reference on the vacancy record');
      const recordSalary = record.match(/li text="(£[\d,]+ to £[\d,]+)"/)?.[1] ?? '';

      // A near miss with a REAL reference, so the validator is tested against
      // "quoted a vacancy that exists but is not the one the brief asks for"
      // rather than against a made-up code.
      await goto(PATH);
      const list = await until('the unfiltered list', async () => {
        const s = await snapshot(mcp);
        return totalOf(s) > 1 ? s : null;
      });
      const listLines = list.split('\n');
      const missAt = listLines.findIndex((l) => {
        const found = l.match(/li text="£([\d,]+) to £([\d,]+)"/);
        if (!found) return false;
        const low = Number(found[1].replace(/,/g, ''));
        const high = Number(found[2].replace(/,/g, ''));
        return low < floor || high > ceiling;
      });
      if (missAt === -1) throw new Error('no off-budget vacancy on the unfiltered first page');
      let decoyUid = null;
      for (let i = missAt; i >= 0; i--) {
        const found = listLines[i].match(/uid=(\S+) a "/);
        if (found && !CHROME_LINKS.test(listLines[i])) {
          decoyUid = found[1];
          break;
        }
      }
      if (!decoyUid) throw new Error('could not resolve the off-budget row back to its link');
      await mcp('click_by_uid', { uid: decoyUid });
      const decoyRecord = await until('the near-miss record', async () => {
        const s = await snapshot(mcp);
        const ref = s.match(/text="Reference (AR-[0-9A-F]{6})"/)?.[1];
        return ref && ref !== reference ? s : null;
      });
      const decoyRef = decoyRecord.match(/text="Reference (AR-[0-9A-F]{6})"/)[1];
      const decoyTitle = decoyRecord.match(/h1 "([^"]*)"/)?.[1] ?? 'another vacancy';

      this.wrong = [
        `The vacancy that meets ${brief.discipline} in ${brief.base} is ${decoyTitle}. ` +
          `Its Alderpost reference is ${decoyRef}.`,
        `Two records are close: ${targetTitle} (${reference}) and ${decoyTitle} ` +
          `(${decoyRef}); either reference should satisfy the brief.`,
      ];
      this.alsoCorrect = [
        `Vacancy: ${targetTitle} at ${targetEmployer}\nAlderpost reference: ${reference}`,
        `Four facets (${brief.discipline}, ${brief.base}, ${contractValue}, ${winning}) ` +
          `leave one record; I also opened ${decoyTitle} (${decoyRef}) to rule it out, ` +
          `and the answer is ${reference}.`,
        `The matching vacancy's reference is ${String(reference).toLowerCase().replace('-', ' ')}.`,
      ];

      const fields = { reference };
      this.wrongFields = [
        { reference: 'AR-0000' },
        { reference: decoyRef },
        { reference: `${reference} or ${decoyRef}` },
        { reference: `${reference}0` },
        // A hedge whose second code the strict shape misses, and a negation.
        { reference: `${reference} or ${decoyRef.replace('-', ' ')}` },
        { reference: `${reference} or ${decoyRef.slice(0, -1)}` },
        // The same, pinned to a second code with no digit left to show it.
        { reference: `${reference} or AR BCDEFA` },
        { reference: `${reference} or AR-EDCBA` },
        { reference: `${reference} or arbcdefa` },
        { reference: `not ${reference}` },
      ];
      // The wrappers a reference picks up on its way out of an answer.
      this.alsoCorrectFields = [
        fields,
        { reference: String(reference).toLowerCase() },
        { reference: `**${reference}**` },
        { reference: `\`${reference}\`` },
        { reference: `${reference}.` },
        { reference: `Reference ${reference}` },
        { reference: String(reference).replace('-', '\uff0d') },
      ];
      return {
        text:
          `Filtering the desk to ${brief.discipline}, ${brief.base}, ${contractValue} and the ` +
          `${winning} band leaves exactly one vacancy: ${targetTitle} at ${targetEmployer}, ` +
          `advertised at ${recordSalary}. Its Alderpost reference is ${reference}. ` +
          `The ${trapBand} band is empty on this brief, so I took it back off after trying it; ` +
          `${brief.secondary} carries nothing on this discipline and contract either.`,
        fields,
      };
    },
  },
};
