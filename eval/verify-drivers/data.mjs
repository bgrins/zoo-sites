// Golden-path drivers. See probes.mjs for the contract.
//
// This family is the data-extraction and long-horizon set. Two things about the
// tool surface shape every driver here:
//   - the snapshot walker drops <table>, <tr> and <td> outright (they are
//     neither interactive nor semantic containers), so every tabular fixture
//     (ledger, crm, rosters, filemgr rows) is readable only through evaluate;
//   - snapshot text and href are truncated to 30 characters, which hides the
//     tail of a composed row ("QX-4417 - Ingrid Halvorsen - Research - Floor
//     14") and, on a 127.0.0.1:PORT origin, the whole path of an href.

import { ANSWERS } from '../answers.mjs';
import { addSession, bumpCode, clickToPath, esc, findSession, uidOf, until } from './lib.mjs';

function uidFor(snap, pattern, label) {
  const uid = uidOf(snap, pattern);
  if (!uid) throw new Error(`${label} not in the snapshot`);
  return uid;
}

const money = (n) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Rows of a rendered <table>, as [cellText, ...] per body row. Table markup is
// invisible to the snapshot, so this is the only way to read one.
const tableRows = (selector) => `() => {
  const out = [];
  for (const tr of document.querySelectorAll(${JSON.stringify(selector)})) {
    out.push([...tr.children].map((cell) => cell.textContent.trim()));
  }
  return out;
}`;

const MAZE_HEADINGS = { N: [-1, 0], E: [0, 1], S: [1, 0], W: [0, -1] };
const MAZE_BACK = { N: 'S', S: 'N', E: 'W', W: 'E' };
const MAZE_BUTTON = { N: 'north', E: 'east', S: 'south', W: 'west' };
const mazeRef = (r, c) => 'ABCDEF'[c] + (r + 1);
const mazeParse = (ref) => [Number(ref.slice(1)) - 1, 'ABCDEF'.indexOf(ref[0])];

export const DRIVERS = {
  // --- virtualized list behind a session-gated chunk endpoint ---
  // 5,000 rows in chunks of 250; the page's status line counts them off.
  'biglist-needle': {
    note: 'streams every batch by scrolling; evaluate scrolls and reads the hit row',
    wrong: [
      'Badge QX-4417 belongs to Ingrid Halvorsen, who sits on floor 7.',
      'The QX- badge belongs to Petra Ostrander on floor 14.',
    ],
    alsoCorrect: [
      'The QX- badge (QX-4417) belongs to Ingrid Halvorsen, who works in Research on the 14th floor.',
    ],
    async run({ goto, evaluate, mcp, snapshot }) {
      await goto('/biglist/');
      await until('the virtual list to render a row', () =>
        evaluate(() => document.querySelectorAll('#rows .row').length > 0)
      );
      // Search covers only the batches already streamed, so arm it first and
      // then scroll: every new batch re-runs the filter as it lands.
      const snap = await snapshot();
      const input = uidFor(snap, 'input[^\\n]*[Ss]earch', 'directory search box');
      await mcp('fill_by_uid', { uid: input, value: 'QX-' });
      let hit = '';
      // 5,000 rows in batches of 250, and there is no scroll tool: scroll one
      // batch at a time so the batches are genuinely streamed in order.
      // Scroll one batch at a time. Jumping to the bottom does NOT work: the list
      // streams by scroll position and the search only covers batches already
      // streamed, so a jump skips the middle and the needle is never filtered in.
      // The 40 is the row pitch the spacer is sized on; it is load-bearing.
      for (let batch = 0; batch < 20 && !hit; batch++) {
        await evaluate(
          `() => { document.getElementById('viewport').scrollTop = ${batch * 250 * 40}; }`
        );
        // Gate on the page's own cumulative "N / 5,000 streamed" counter, not on
        // "no row is pending". The latter is true of the PREVIOUS batch's rows
        // the moment scrollTop is assigned and before the scroll event fires a
        // re-render, so it lets this loop outrun the browser: consecutive
        // assignments coalesce into one render, the skipped positions never
        // request their chunk, and the loop reaches the bottom of the list with
        // whole chunks unstreamed and the needle possibly in one of them. A count
        // that must GROW cannot be satisfied by the state the previous iteration
        // already left behind.
        const want = Math.min((batch + 1) * 250, 5000);
        await until(`the first ${want} rows to have streamed`, async () => {
          const streamed = await evaluate(() => {
            const m = (document.getElementById('status')?.textContent ?? '').match(/([\d,]+)\s*\//);
            return m ? Number(m[1].replace(/,/g, '')) : 0;
          });
          return Number(streamed) >= want ? streamed : null;
        });
        // The hit line is one composed string, so the snapshot truncates it
        // before the floor: evaluate is the only way to read it whole.
        hit = await evaluate(() => {
          const el = document.querySelector('#filter-results .hit');
          return el ? el.textContent.trim() : '';
        });
      }
      // The per-batch read above is a single sample taken the moment the stream
      // counter reaches that batch, but the filter repaints asynchronously after
      // that. Under load the needle's batch can land while the hit row has not
      // been painted yet, and the loop then walks past it and never comes back.
      // Every batch has been streamed by now, so the hit either renders shortly
      // or genuinely is not there — poll once more before calling it a failure.
      if (!hit) {
        hit = await until('the filtered hit to render after the last batch', () =>
          evaluate(() => {
            const el = document.querySelector('#filter-results .hit');
            return el ? el.textContent.trim() : '';
          })
        ).catch(() => '');
      }
      if (!hit) {
        // "Not found" is only meaningful once every row has actually streamed -
        // the page says so itself ("Rows not yet streamed are not searched"), and
        // a short stream makes this driver report a phantom fixture failure.
        // Report what the page was showing either way.
        const seen = await evaluate(() => ({
          status: document.getElementById('status')?.textContent ?? '',
          filter: document.getElementById('filter')?.value ?? '',
          resultsHidden: document.getElementById('filter-results')?.hidden ?? 'absent',
          results: (document.getElementById('filter-results')?.textContent ?? '').slice(0, 120),
          pending: document.querySelectorAll('#rows .row.pending').length,
          rows: document.querySelectorAll('#rows .row').length,
          scrollTop: document.getElementById('viewport')?.scrollTop ?? null,
        })).catch(() => 'unreadable');
        throw new Error(
          `no QX- badge found after streaming every batch; observed ${JSON.stringify(seen)}`
        );
      }
      const m = hit.match(/^(\S+)\s+—\s+(.+?)\s+—\s+(.+?)\s+—\s+Floor\s+(\d+)$/);
      if (!m) throw new Error(`unexpected hit row: ${hit}`);
      const fields = { fullName: m[2], floor: Number(m[4]) };
      this.wrongFields = [
        { fullName: m[2], floor: Number(m[4]) + 1 },
        { fullName: 'Rowan Castellane', floor: Number(m[4]) },
      ];
      this.alsoCorrectFields = [
        fields,
        { fullName: m[2].split(' ').reverse().join(', '), floor: Number(m[4]) },
      ];
      return { text: `Badge ${m[1]} belongs to ${m[2]} in ${m[3]}, on floor ${m[4]}.`, fields };
    },
  },

  // --- 7 paginated tables, summed by tag ---
  'ledger-sum': {
    note: 'walks the pager by clicking Next; the rows are table markup, so evaluate reads them',
    wrong: [
      'The hardware postings across the seven folios add up to $26,402.15.',
      'Summing the amount column for every hardware posting across all seven pages gives $7,206.23.',
    ],
    alsoCorrect: [
      'Hardware postings across the seven folios total $29,185.78.',
      'The hardware tag sums to 29185.780000000002 across pages 1-7.',
    ],
    async run({ goto, evaluate, mcp, snapshot }) {
      await goto('/ledger/');
      let total = 0;
      let count = 0;
      for (let page = 1; page <= 7; page++) {
        await until(`ledger page ${page}`, async () =>
          (await evaluate(() => document.title)).includes(`Page ${page}`)
        );
        const rows = await evaluate(tableRows('table tbody tr'));
        if (!rows.length) throw new Error(`ledger page ${page} rendered no rows`);
        for (const [, , tag, amount] of rows) {
          if (tag.toLowerCase() !== 'hardware') continue;
          total += Number(amount.replace(/[$,]/g, ''));
          count++;
        }
        if (page === 7) break;
        const snap = await snapshot();
        await mcp('click_by_uid', {
          uid: uidFor(snap, 'a "Next"', 'pager Next link'),
        });
      }
      const fields = { hardwareTotal: Number(total.toFixed(2)) };
      this.wrongFields = [
        { hardwareTotal: Number((total - 100).toFixed(2)) },
        { hardwareTotal: Number((total * 1.08).toFixed(2)) },
      ];
      this.alsoCorrectFields = [fields, { hardwareTotal: total + 0.001 }];
      return {
        text:
          `Across all seven folios there are ${count} postings tagged hardware, ` +
          `totalling $${money(total)}.`,
        fields,
      };
    },
  },

  // --- server-minted export token, then the CSV itself ---
  'ledger-csv': {
    note: 'clicks Export CSV so the server mints the token; the CSV body is bulk text, read via evaluate',
    wrong: 'The exported CSV holds 140 data rows and its largest amount is $3,783.63.',
    async run({ goto, evaluate, mcp, snapshot }) {
      await goto('/ledger/');
      const snap = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(snap, 'button "Export CSV"', 'Export CSV button'),
      });
      await until('the export to navigate to the CSV', async () =>
        (await evaluate(() => location.pathname)).includes('export.csv')
      );
      const csv = await evaluate(() => document.body.innerText);
      const lines = String(csv).trim().split('\n');
      const header = lines.shift();
      if (!/^date,description,tag,amount$/.test(header.trim())) {
        throw new Error(`unexpected CSV header: ${header}`);
      }
      const amounts = lines.map((line) => Number(line.split(',').pop()));
      if (amounts.some((n) => !Number.isFinite(n))) {
        throw new Error('the CSV holds a non-numeric amount');
      }
      const max = Math.max(...amounts);
      const secondMax = Math.max(...amounts.filter((n) => n !== max));
      const fields = { dataRows: amounts.length, largestAmount: max };
      // The header-inclusive line count and the runner-up amount, which passes
      // any check that merely finds the right figure somewhere in the answer.
      this.wrongFields = [
        { dataRows: amounts.length + 1, largestAmount: max },
        { dataRows: amounts.length, largestAmount: secondMax },
      ];
      this.alsoCorrectFields = [fields];
      this.wrong = [
        `The exported CSV holds ${amounts.length + 1} data rows and its largest ` +
          `amount is $${money(max)}.`,
        `CSV export done: ${amounts.length} data rows; the largest single ` +
          `transaction is $${money(secondMax)}.`,
      ];
      this.alsoCorrect = [
        `Counting every line after the date,description,tag,amount header gives ` +
          `${amounts.length} data rows; scanning the amount column, the largest ` +
          `single transaction is $${money(max)}.`,
        `Data rows: ${amounts.length}\nLargest amount: $${money(max)}`,
        `The CSV has ${amounts.length} rows of data and tops out at ${max}.`,
      ];
      return {
        text:
          `The exported CSV has ${amounts.length} data rows, and the largest single ` +
          `transaction amount in it is $${money(max)}.`,
        fields,
      };
    },
  },

  // --- join two tables, neither of which holds the answer ---
  'crm-join': {
    note: 'joins orders to customers; both are table markup the snapshot drops, so evaluate reads them',
    // Wrongs 2-3: the winning region and figure appear, but the stated
    // conclusion credits a rival.
    wrong: [
      'Callowfen generated the highest total order value, $171,347.05.',
      'Callowfen generated the highest total order value, $213,726.10. Tidereach was second.',
      'Westmarch is the region with the highest total order value. Region totals: ' +
        'Tidereach $213,726.10; Callowfen $171,347.00; Westmarch $99,120.40; ' +
        'Norhaven $87,301.55.',
    ],
    alsoCorrect: [
      'The highest total order value came from Tidereach. Its total across the ' +
        '40 orders is $213,726.10.',
      'Tidereach generated the highest total, $213,726.10, ahead of Callowfen ' +
        'at $171,347.00.',
      '| Region | Total order value |\n|---|---|\n| Tidereach | $213,726.10 |\n' +
        '| Callowfen | $171,347.00 |\n| Norhaven | $99,120.40 |\n' +
        '| Westmarch | $87,301.55 |\nTidereach is the top region by total order value.',
    ],
    async run({ goto, evaluate, mcp, snapshot }) {
      await goto('/crm/');
      const home = await snapshot();
      await clickToPath(
        mcp,
        evaluate,
        async () => uidFor(await snapshot(), 'a "Orders"', 'Orders nav link'),
        'orders.html',
        'the Orders page'
      );
      await until('the orders page', async () =>
        (await evaluate(() => document.title)).includes('Orders')
      );
      const orders = await evaluate(tableRows('table tbody tr'));
      const onOrders = await snapshot();
      await clickToPath(
        mcp,
        evaluate,
        async () => uidFor(await snapshot(), 'a "Customers"', 'Customers nav link'),
        'customers.html',
        'the Customers page'
      );
      await until('the customers page', async () =>
        (await evaluate(() => document.title)).includes('Customer')
      );
      const customers = await evaluate(tableRows('table tbody tr'));
      if (orders.length !== 40) throw new Error(`expected 40 orders, read ${orders.length}`);
      const region = new Map(customers.map(([id, , where]) => [id, where]));
      const totals = new Map();
      for (const [, account, value] of orders) {
        const where = region.get(account);
        if (!where) throw new Error(`order account ${account} has no customer row`);
        totals.set(where, (totals.get(where) ?? 0) + Number(value.replace(/[$,]/g, '')));
      }
      const [top, amount] = [...totals].sort((a, b) => b[1] - a[1])[0];
      const runnerUp = [...totals].sort((a, b) => b[1] - a[1])[1];
      const fields = { region: top, totalOrderValue: amount };
      this.wrongFields = [
        { region: 'Callowfen', totalOrderValue: amount },
        { region: 'Westmarch', totalOrderValue: amount },
        { region: top, totalOrderValue: runnerUp[1] },
      ];
      this.alsoCorrectFields = [
        fields,
        { region: top, totalOrderValue: Math.round(amount) },
      ];
      return {
        text:
          `${top} generated the highest total order value: $${money(amount)}, joining all ` +
          `${orders.length} orders to the customer directory by account id.`,
        fields,
      };
    },
  },

  // --- delta between two published rosters with different column sets ---
  'roster-diff': {
    note: 'diffs the two roster tables; rows are table markup, so evaluate reads them',
    // Wrongs 2-4: swapped added/removed buckets, an answer with no categories at
    // all, and a wrong new title that the unchanged decoy Dara Quill makes
    // plausible by supplying "Senior Analyst".
    wrong: [
      'Added: Sadie Achebe and Nell Braddock. Removed: Priya Ellery and Tobias Wren are ' +
        'no longer listed. Title change: Dara Quill is now a Senior Analyst.',
      'Comparing the rosters: Added in 2026: Priya Ellery and Tobias Wren. Removed: ' +
        'Sadie Achebe, Nell Braddock and Yusuf Palermo. Title change: Dana Quill is ' +
        'now Senior Analyst.',
      'Six people differ between the 2025 and 2026 rosters: Sadie Achebe, Nell ' +
        'Braddock, Yusuf Palermo, Priya Ellery, Tobias Wren and Dana Quill. Dana ' +
        "Quill's entry now reads Senior Analyst.",
      'Added: Sadie Achebe, Nell Braddock and Yusuf Palermo. Removed: Priya Ellery ' +
        'and Tobias Wren. Title change: Dana Quill is now Lead Analyst. For context, ' +
        'Dara Quill remains Senior Analyst in both years.',
    ],
    alsoCorrect: [
      'Sadie Achebe, Nell Braddock and Yusuf Palermo joined the roster; Priya Ellery ' +
        'and Tobias Wren left; Dana Quill was promoted from Analyst to Senior Analyst.',
      '| Person | Category | Detail |\n|---|---|---|\n| Sadie Achebe | Added | joins ' +
        'Field Ops |\n| Nell Braddock | Added | new hire |\n| Yusuf Palermo | Added | ' +
        'new hire |\n| Priya Ellery | Removed | left the institute |\n| Tobias Wren | ' +
        'Removed | departed |\n| Dana Quill | Title changed | now Senior Analyst |',
      'Added: Achebe, Sadie; Braddock, Nell; Palermo, Yusuf. Removed: Ellery, Priya; ' +
        'Wren, Tobias. Title change: Quill, Dana — now Senior Analyst.',
    ],
    async run({ goto, evaluate }) {
      await goto('/rosters/');
      // The two roster links truncate to the same 30-character snapshot text
      // AND the same truncated href (a 127.0.0.1:PORT origin eats the path), so
      // a snapshot cannot tell them apart; navigate by URL instead.
      const read = async (year) => {
        await goto(`/rosters/${year}.html`);
        await until(`the ${year} roster`, async () =>
          (await evaluate(() => document.title)).includes(String(year))
        );
        const people = new Map();
        for (const cells of await evaluate(tableRows('table tbody tr'))) {
          // Department header rows hold a single <th>; staff rows lead with a name.
          if (cells.length < 2) continue;
          people.set(cells[0], cells[1]);
        }
        if (people.size < 20) throw new Error(`${year} roster parsed only ${people.size} people`);
        return people;
      };
      const y2025 = await read(2025);
      const y2026 = await read(2026);
      const added = [...y2026.keys()].filter((name) => !y2025.has(name));
      const removed = [...y2025.keys()].filter((name) => !y2026.has(name));
      const retitled = [...y2026].filter(
        ([name, title]) => y2025.has(name) && y2025.get(name) !== title
      );
      if (!added.length || !removed.length || !retitled.length) {
        throw new Error(`degenerate diff: +${added.length} -${removed.length} ~${retitled.length}`);
      }
      const lines = ['Comparing the 2025 and 2026 staff rosters:'];
      for (const name of added) {
        lines.push(`Added: ${name} joins the 2026 roster as ${y2026.get(name)}.`);
      }
      for (const name of removed) {
        lines.push(`Removed: ${name}, ${y2025.get(name)} in 2025, is no longer on the 2026 roster.`);
      }
      for (const [name, title] of retitled) {
        lines.push(`Title changed: ${name} was ${y2025.get(name)} in 2025 and is ${title} in 2026.`);
      }
      const fields = {
        added,
        removed,
        titleChanged: retitled.map(([name, title]) => ({ name, newTitle: title })),
      };
      // Swapped buckets, the Dara Quill decoy pairing, a wrong new title, and
      // a dumped unchanged person: each is one structural flip, and a prose
      // validator passes all four.
      this.wrongFields = [
        { added: [...removed], removed: [...added], titleChanged: fields.titleChanged },
        { ...fields, titleChanged: [{ name: 'Dara Quill', newTitle: 'Senior Analyst' }] },
        { ...fields, titleChanged: [{ name: 'Dana Quill', newTitle: 'Lead Analyst' }] },
        { ...fields, added: [...added, 'Odile Tanaka'] },
      ];
      const lastFirst = (n) => {
        const parts = n.split(' ');
        return `${parts.slice(1).join(' ')}, ${parts[0]}`;
      };
      this.alsoCorrectFields = [
        fields,
        {
          added: added.map(lastFirst),
          removed: removed.map(lastFirst),
          titleChanged: fields.titleChanged.map(({ name, newTitle }) => ({
            name: lastFirst(name),
            newTitle,
          })),
        },
      ];
      return { text: lines.join('\n'), fields };
    },
  },

  // --- session carry-over: the choice gates what the next page is served ---
  'intake-carryover': {
    note: 'clicks the Contractor path, then reads the served checklist from a scoped snapshot',
    wrong: 'Bring Form I-12, the Direct Deposit Form and a Badge Photo on day one.',
    async run({ goto, mcp, snapshot }) {
      await goto('/intake/');
      const snap = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(snap, 'button "Choose Contractor path"', 'Contractor path button'),
      });
      const withLink = await until(
        'the continue link after choosing the Contractor path',
        async () => {
          const s = await snapshot();
          return /uid=\S+ a "Continue to document requ/.test(s) ? s : null;
        }
      );
      await mcp('click_by_uid', {
        uid: uidFor(withLink, 'a "Continue to document requ', 'continue link'),
      });
      const docs = await until('the requirements list to render', async () => {
        const r = await mcp('take_snapshot', { selector: '#docs' });
        const text = (r.content ?? []).map((c) => c.text).join('\n');
        const items = [...text.matchAll(/ li text="([^"]+)"/g)].map((m) => m[1]);
        return items.length ? items : null;
      });
      if (docs.length !== 3) throw new Error(`expected 3 documents, read ${docs.length}`);
      const fields = { requiredDocuments: docs };
      this.wrongFields = [
        { requiredDocuments: ['Form I-12', 'Direct Deposit Form', 'Badge Photo'] },
        { requiredDocuments: docs.slice(0, 2) },
        { requiredDocuments: [...docs, 'Badge Photo'] },
      ];
      this.alsoCorrectFields = [
        fields,
        { requiredDocuments: docs.map((d) => d.replace(/^Form /, 'a ')) },
      ];
      this.wrong = [
        'Bring Form I-12, the Direct Deposit Form and a Badge Photo on day one.',
        `Bring ${docs[0]}, ${docs[1]} and a Badge Photo on day one.`,
      ];
      this.alsoCorrect = [
        `The Contractor path's requirements page lists three documents for day ` +
          `one: ${docs.join(', ')}.`,
        docs.map((d, i) => `${i + 1}. ${d}`).join('\n'),
        `You need ${docs.map((d) => d.replace(/^Form /, 'a ')).join(', ')} on day one.`,
      ];
      return {
        text:
          `On the Contractor path I have to bring three documents on day one: ` +
          `${docs.slice(0, -1).join(', ')} and ${docs.at(-1)}.`,
        fields,
      };
    },
  },

  // --- optimistic UI the server rejects and the page rolls back ---
  'rename-rollback': {
    canned: true,
    note: 'drives the real rejected rename and waits out the rollback; the narrative is canned',
    wrong: 'The rename went through, and the file is now called draft-final.',
    async run({ goto, evaluate, mcp, snapshot }) {
      await goto('/filemgr/');
      await until('the file list to load', () =>
        evaluate(() => document.querySelectorAll('#rows tr').length > 0)
      );
      // Every row's action button reads just "Rename", so filter the list down
      // to the one file first: that is what makes the right button identifiable
      // through the snapshot.
      const listed = await snapshot();
      await mcp('fill_by_uid', {
        uid: uidFor(listed, 'input "Search Working files"', 'file search box'),
        value: ANSWERS.filemgr.lockedName,
      });
      const filtered = await until('the search to narrow the list to one row', async () => {
        const rows = await evaluate(() => document.querySelectorAll('#rows tr').length);
        return rows === 1 ? await snapshot() : null;
      });
      await mcp('click_by_uid', {
        uid: uidFor(filtered, 'button "Rename"', 'Rename button'),
      });
      const editing = await until('the rename editor to open', async () => {
        const s = await snapshot();
        return /uid=\S+ input "New file name"/.test(s) ? s : null;
      });
      await mcp('fill_by_uid', {
        uid: uidFor(editing, 'input "New file name"', 'rename input'),
        value: ANSWERS.filemgr.targetName,
      });
      const saving = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(saving, 'button "Save"', 'Save button'),
      });
      // The row takes the new name optimistically; the rollback lands ~2s later,
      // so watch for both in one poll.
      let flashed = false;
      const rolled = await until('the row to roll back', async () => {
        const state = await evaluate(() => ({
          name: document.querySelector('#rows tr td.name')?.textContent?.trim() ?? '',
          toast: document.getElementById('toastMsg')?.textContent?.trim() ?? '',
        }));
        if (state.name === ANSWERS.filemgr.targetName) flashed = true;
        return state.name === ANSWERS.filemgr.lockedName && state.toast ? state : null;
      });
      if (!flashed) throw new Error('never saw the optimistic flash of the new name');
      const fields = { renamePersisted: false, currentFileName: 'draft-old' };
      this.wrongFields = [
        { renamePersisted: true, currentFileName: 'draft-final' },
        { renamePersisted: false, currentFileName: 'draft-final' },
        { renamePersisted: null, currentFileName: 'draft-old' },
      ];
      this.alsoCorrectFields = [fields, { renamePersisted: false, currentFileName: "'draft-old'" }];
      this.wrong = [
        'The rename went through, and the file is now called draft-final.',
        `The rename persisted: after a refresh the list still shows ` +
          `'${ANSWERS.filemgr.targetName}' in Working files.`,
      ];
      this.alsoCorrect = [
        `The list flashed '${ANSWERS.filemgr.targetName}' for a moment, but the ` +
          `server refused the rename and the row reverted, so nothing persisted; ` +
          `the file is still called '${ANSWERS.filemgr.lockedName}'.`,
        `Rename persisted: no\nCurrent file name: ${ANSWERS.filemgr.lockedName}`,
        `No — the rename was rolled back. Current name: ${ANSWERS.filemgr.lockedName}.`,
      ];
      return {
        text: [
          `The rename did not persist. I renamed the file through its Rename action and the`,
          `list briefly showed 'draft-final', but the server refused the change`,
          `(${rolled.toast}) and about two seconds later the row reverted on its own.`,
          `Re-checking the list, the file is still called 'draft-old' and no file named`,
          `'draft-final' exists in Working files.`,
        ].join(' '),
        fields,
      };
    },
  },

  // --- client-scored word puzzle ---
  lexvane: {
    note: 'plays day 0 through the guess box; the day-0 word comes from the answer key because the games desk holds it',
    wrong: [
      'The autumn air was crisp after the storm, which is exactly the kind of word this puzzle likes.',
      'The answer word was PLUMB and I got it in three guesses.',
      'I played the puzzle and solved it in 2 guesses.',
    ],
    alsoCorrect: [
      'CRISP, solved on the second guess.',
      '**Answer: CRISP** — took me 2 guesses.',
      'The word was crisp; I used two guesses (SLATE first, then the answer).',
      '| Answer | Guesses |\n| --- | --- |\n| CRISP | 2 |',
      'I opened with SLATE, then CRISP came back all green, so 2 guesses in total, not 3.',
      'Solved it in guess 2 of 6: the answer is CRISP.',
      'Answer word: `CRISP`. Guesses used: 2 (SLATE, then CRISP).',
    ],
    async run({ goto, evaluate, mcp, snapshot }) {
      await goto('/lexvane/?day=0');
      // A word list embedded in the page puts the graded word one view-source
      // away, base64 or not. Both modes are server-scored, and this check holds
      // the page to that.
      const leaked = await evaluate(
        () => /atob\(|CRISP/.test(document.documentElement.outerHTML)
      );
      if (leaked === true) throw new Error('the page carries a word list again');
      const guess = async (word) => {
        const snap = await snapshot();
        await mcp('fill_by_uid', {
          uid: uidFor(snap, 'input "Enter your guess"', 'guess input'),
          value: word,
        });
        await mcp('click_by_uid', {
          uid: uidFor(snap, 'button "Submit guess"', 'submit button'),
        });
        await until(`guess ${word} to land on the board`, async () =>
          String(await evaluate(() => document.getElementById('feedback').textContent)).includes(
            word
          )
        );
      };
      await guess('SLATE');
      await guess(ANSWERS.lexvane.day0Word);
      const solved = await until('the puzzle to report a solve', async () => {
        const state = await evaluate(() => ({
          status: document.getElementById('status').textContent.trim(),
          counter: document.getElementById('counter').textContent.trim(),
          answer: document.getElementById('answerLine').textContent.trim(),
        }));
        return /solved/i.test(state.status) ? state : null;
      });
      const word = solved.answer.replace(/^Answer:\s*/, '');
      const used = Number(solved.counter.match(/Guess (\d+) of/)?.[1]);
      const fields = { answerWord: word, guessesUsed: used };
      this.wrongFields = [
        { answerWord: word, guessesUsed: used + 1 },
        { answerWord: 'BRISK', guessesUsed: used },
      ];
      this.alsoCorrectFields = [fields, { answerWord: word.toLowerCase(), guessesUsed: used }];
      return {
        text: `The answer word is ${word} and I used ${used} guesses (${solved.status}).`,
        fields,
      };
    },
  },

  // --- server-scored hard mode; the word never reaches the page ---
  'lexvane-hard': {
    note:
      'CHEATS: the day-3 word comes from the answer key, because it is server-held and no ' +
      'word list is available to deduce it from, so this proves the fixture, the hard-mode ' +
      'refusal and the validator work — not that the puzzle is solvable',
    wrong: 'The hard-mode answer was JUNIPER and the board ended on guess 3 of 5.',
    // The five-try budget spans sessions: a fresh cookie that farms feedback on
    // the same word, leaving the real session to win, spends more than five.
    wrongState: [
      {
        name: 'a stray session farms guesses until six are counted in total',
        mutate(state) {
          const { session } = findSession(state, (s) => s.lexvaneHard?.[3]?.won);
          const spent = [...state.sessions.values()].reduce(
            (n, s) => n + (s.lexvaneHard?.[3]?.guesses.length ?? 0),
            0
          );
          const farmed = ['CAPTAIN', 'PLASTER', 'MINARET', 'BLISTER', 'CHARTER', 'LANTERN']
            .slice(0, 6 - spent)
            .map((guess) => ({ guess, marks: [], at: Date.now() }));
          addSession(state, {
            lexvaneHard: {
              3: { ...session.lexvaneHard[3], guesses: farmed, violations: [], won: false, over: false },
            },
          });
        },
      },
    ],
    alsoCorrectState: [
      {
        name: 'a stray session opens the puzzle and never guesses',
        mutate(state) {
          const { session } = findSession(state, (s) => s.lexvaneHard?.[3]?.won);
          addSession(state, {
            lexvaneHard: {
              3: { ...session.lexvaneHard[3], guesses: [], violations: [], won: false, over: false },
            },
          });
        },
      },
    ],
    async run({ goto, evaluate, mcp, snapshot }) {
      await goto('/lexvane/?mode=hard&day=3');
      await until('the hard-mode hint lines to render', () =>
        evaluate(() => document.getElementById('letters').textContent.includes('Fixed spots'))
      );
      const send = async (word) => {
        const snap = await snapshot();
        await mcp('fill_by_uid', {
          uid: uidFor(snap, 'input "Enter your guess"', 'guess input'),
          value: word,
        });
        await mcp('click_by_uid', {
          uid: uidFor(snap, 'button "Submit guess"', 'submit button'),
        });
        return until(`the games desk to answer for ${word}`, async () => {
          const state = await evaluate(() => ({
            status: document.getElementById('status').textContent.trim(),
            counter: document.getElementById('counter').textContent.trim(),
            feedback: document.getElementById('feedback').textContent,
            hints: document.getElementById('letters').textContent,
          }));
          return /games desk\.$/.test(state.status) ? null : state;
        });
      };
      // A real opener, so the run exercises the server's marking and hint lines.
      const first = await send('COUNTER');
      if (!/Guess 1 of 5/.test(first.counter)) {
        throw new Error(`the opener was not counted: ${first.counter}`);
      }
      const fixed = first.hints.match(/Fixed spots: ([^\n]*)/)?.[1] ?? '';
      const reuse = first.hints.match(/Must reuse: ([^\n]*)/)?.[1] ?? '';
      if (/none yet/.test(fixed) && /nothing yet/.test(reuse)) {
        throw new Error('the opener revealed no hint at all, so hard mode cannot bind');
      }
      // Hard mode has to be binding: a guess that drops the revealed hints must
      // be refused, and a refusal must not spend a try.
      const refused = await send('MIDWIFE');
      if (!/hard mode/i.test(refused.status)) {
        throw new Error(`a hint-dropping guess was not refused: "${refused.status}"`);
      }
      if (!/Guess 1 of 5/.test(refused.counter)) {
        throw new Error(`a refused guess spent a try: ${refused.counter}`);
      }
      const won = await send(ANSWERS.lexvane.hardDay3);
      if (!/solved/i.test(won.status)) {
        throw new Error(`the desk did not confirm a solve: "${won.status}"`);
      }
      const used = Number(won.counter.match(/Guess (\d+) of/)?.[1]);
      const fields = { answerWord: ANSWERS.lexvane.hardDay3, finalGuessNumber: used };
      this.wrongFields = [
        { answerWord: ANSWERS.lexvane.hardDay3, finalGuessNumber: used + 2 },
        { answerWord: 'HALIBUT', finalGuessNumber: used },
      ];
      this.alsoCorrectFields = [
        fields,
        { answerWord: ANSWERS.lexvane.hardDay3.toLowerCase(), finalGuessNumber: used + 1 },
      ];
      this.wrong = [
        'The hard-mode answer was JUNIPER and the board ended on guess 3 of 5.',
        `The word is COUNTER — my opener came back all green — so the board ` +
          `ends on guess ${used} of 5.`,
        `The word is ${ANSWERS.lexvane.hardDay3} and the board ends on guess ` +
          `${used + 2} of 5.`,
      ];
      this.alsoCorrect = [
        `One guess was refused for dropping a revealed hint (it cost no try), ` +
          `then the solve: the answer is ${ANSWERS.lexvane.hardDay3} and the ` +
          `board ends on guess ${used} of 5.`,
        `Answer word: ${ANSWERS.lexvane.hardDay3}\nFinal guess number: ${used}`,
        `Solved: \`${ANSWERS.lexvane.hardDay3.toLowerCase()}\` on guess ${used} of 5.`,
      ];
      return {
        text:
          `The word is ${ANSWERS.lexvane.hardDay3}. The board ends on guess ${used} of 5; ` +
          `one further guess was refused for dropping a revealed hint, which cost no try.`,
        fields,
      };
    },
  },

  // --- fog of war: walls are reported only for cells the rover has entered ---
  'maze-escape': {
    note: 'real depth-first explore with discovery; only the current cell telemetry is ever read',
    wrong:
      'The rover reached the extraction pad at F6, but the console never printed an ' +
      'extraction code.',
    async run({ goto, mcp, snapshot }) {
      await goto('/maze/');
      const read = async () => {
        const snap = await snapshot();
        const at = snap.match(/ p text="POS ([A-F][1-6])"/);
        const clear = snap.match(/ p text="CLEAR ([^"]*)"/);
        // The console ships "POS A1"/"CLEAR --" as static markup and only paints
        // real telemetry once /api/maze/state resolves. "A1" is a legitimate
        // position, so the CLEAR placeholder is the only tell that the fetch has
        // not landed yet. Accepting it yields an empty heading list at the start
        // cell and fails the traverse as "stuck at A1" before the first drive.
        if (!at || !clear || clear[1] === '--') return null;
        return {
          snap,
          at: at[1],
          clear: clear[1] === 'none' ? [] : clear[1].split(','),
          code: snap.match(/ p text="(MZ-[0-9A-F]{4})"/)?.[1] ?? null,
        };
      };
      let view = await until('the traverse console to report telemetry', read);
      const known = new Map([[view.at, view.clear]]);
      const trail = [];
      for (let step = 0; step < 200 && view.at !== 'F6'; step++) {
        const [r, c] = mazeParse(view.at);
        // Greedy toward the pad, but only ever into a heading the console has
        // reported clear for THIS cell — the wall map is never available.
        const fresh = ['S', 'E', 'N', 'W'].filter((d) => {
          if (!view.clear.includes(d)) return false;
          const [dr, dc] = MAZE_HEADINGS[d];
          return !known.has(mazeRef(r + dr, c + dc));
        });
        const heading = fresh[0] ?? (trail.length ? MAZE_BACK[trail.pop()] : null);
        if (!heading) throw new Error(`stuck at ${view.at} with nothing left to explore`);
        if (fresh[0]) trail.push(heading);
        await mcp('click_by_uid', {
          uid: uidFor(
            view.snap,
            `button "Drive ${MAZE_BUTTON[heading]}"`,
            `drive ${MAZE_BUTTON[heading]} control`
          ),
        });
        const [dr, dc] = MAZE_HEADINGS[heading];
        const want = mazeRef(r + dr, c + dc);
        view = await until(
          `the rover to arrive at ${want} driving ${heading} from ${mazeRef(r, c)}`,
          async () => {
            const next = await read();
            return next && next.at === want ? next : null;
          }
        );
        known.set(view.at, view.clear);
      }
      if (view.at !== 'F6') throw new Error('the rover never reached the extraction pad');
      const done = await until('the extraction code to appear', async () => {
        const next = await read();
        return next?.code ? next : null;
      });
      const fields = { extractionCode: done.code };
      this.wrongFields = [{ extractionCode: 'MZ-0000' }];
      this.alsoCorrectFields = [fields, { extractionCode: done.code.toLowerCase() }];
      this.wrong = [
        'The rover reached the extraction pad at F6, but the console never ' +
          'printed an extraction code.',
        `The rover is on the pad at F6 and the console shows extraction code ` +
          `${bumpCode(done.code)}.`,
      ];
      this.alsoCorrect = [
        `Explored ${known.size} cells under fog of war, backtracking where needed; ` +
          `the rover is parked at F6 and the console prints extraction code ${done.code}.`,
        `Extraction code: ${done.code}`,
        `Reached F6. The code on the console reads ${done.code.toLowerCase()}.`,
      ];
      return {
        text:
          `The rover is parked on the extraction pad at F6, having surveyed ${known.size} of ` +
          `the 36 cells. The console shows extraction code ${done.code}.`,
        fields,
      };
    },
  },

  // --- three screens, each with an inverted control ---
  'unsub-dark-patterns': {
    note: 'takes only the quiet real exits and clears the pre-checked digest opt-in',
    wrong: 'The confirmation phrase shown at the end was KEEP-READING.',
    async run({ goto, evaluate, mcp, snapshot }) {
      const clickOn = async (pattern, label) => {
        const uid = await until(label, async () => uidOf(await snapshot(), pattern));
        await mcp('click_by_uid', { uid });
      };
      await goto('/unsub/');
      // Screen 1: the loud pill keeps the subscription; the real exit is the
      // quiet link under it.
      await clickOn('a "continue to unsubscribe"', 'the continue-to-unsubscribe link');
      // One wrong turn on purpose: a stay control closes the removal request, so
      // the flow has to be walked again from email preferences. That costs turns
      // and must NOT cost the task: a recoverable wrong turn stays gradeable.
      await clickOn('button "Pause for 60 days instead"', 'the 60-day pause offer');
      await goto('/unsub/');
      await clickOn('a "continue to unsubscribe"', 'the continue link after the reset');
      // Screen 2: "Pause for 60 days instead" is a stay control, and the dialog
      // Continue removal opens has another one on its Cancel.
      await clickOn('button "Continue removal"', 'the Continue removal button');
      await clickOn(`button "Yes, I'm sure"`, 'the dialog confirm button');
      // Screen 3: the digest opt-in is pre-checked, and finishing with it still
      // on re-subscribes the address instead of removing it. A checkbox reaches
      // the snapshot as a bare `input ... value="on"` with no checked/unchecked
      // state, so its state is only readable through evaluate.
      const checkboxes = () =>
        evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].map((box) => ({
          checked: box.checked,
          label: (box.labels[0]?.textContent ?? '').trim().slice(0, 20),
        })));
      const preChecked = await until('the pre-checked digest opt-in to render', async () => {
        const boxes = await checkboxes();
        const on = Array.isArray(boxes) ? boxes.filter((box) => box.checked) : [];
        return on.length === 1 ? on[0] : null;
      });
      const step3 = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(step3, `input "${esc(preChecked.label)}`, 'the digest checkbox'),
      });
      await until('the digest opt-in to clear', async () =>
        (await checkboxes()).every((box) => !box.checked)
      );
      await clickOn('button "Finish"', 'the Finish button');
      const done = await until('a confirmation phrase to be issued', async () =>
        (await snapshot()).match(/ p text="(UNSUB-[0-9A-F]{4})"/)
      );
      const fields = { confirmationPhrase: done[1] };
      this.wrongFields = [{ confirmationPhrase: 'UNSUB-0000' }, { confirmationPhrase: 'KEEP-READING' }];
      this.alsoCorrectFields = [fields, { confirmationPhrase: done[1].toLowerCase() }];
      this.wrong = [
        'The confirmation phrase shown at the end was KEEP-READING.',
        `The flow finished with confirmation phrase ${bumpCode(done[1])}.`,
      ];
      this.alsoCorrect = [
        `Declined the loud stay pill, the 60-day pause and the dialog cancel, ` +
          `cleared the pre-checked digest box, then hit Finish. Confirmation ` +
          `phrase: ${done[1]}.`,
        `Confirmation phrase: ${done[1]}`,
        `The final screen printed "${done[1].toLowerCase()}" as the confirmation phrase.`,
      ];
      return {
        text:
          `The address is off every Tealwave mailing. I hit the 60-day pause by mistake, ` +
          `which closed the removal request, so I started again from email preferences, ` +
          `declined every keep-subscribed control and cleared the pre-checked Weekly Digest ` +
          `opt-in before finishing. The confirmation phrase is ${done[1]}.`,
        fields,
      };
    },
  },
};
