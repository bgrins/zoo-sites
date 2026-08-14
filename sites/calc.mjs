// pages/calc/ - Marchmont Haulage workbook (formula-repair).
import { randomBytes } from 'node:crypto';

// T114 formula-repair: pages/calc/ — the Abaca workbook "Q3 Freight Recovery".
// The sheet exists only here. The page is issued cell VALUES (the grid) but no
// formulas: a formula is released one cell at a time by GET /api/calc/cell, the
// way a real cloud workbook lazy-loads the formula bar, so which cells an agent
// actually inspected is server-observed. Which cell carries the defect is drawn
// per session from randomBytes, one September amount is jittered per session so
// the totals cannot be memorised between runs, and the reconciliation checksum
// is minted from randomBytes only once the server's own recalculation agrees on
// every total. Grading is semantic: any formula that recomputes correctly is
// accepted, so SUM(E2:E13), E2+E3+...+E13 and B14+C14+D14 all repair E14.
const CALC_WORKBOOK = 'Q3 Freight Recovery';

const CALC_SHEET = 'Q3 Recovery';

const CALC_OWNER = 'Marchmont Haulage';

// Row 1 of the sheet. The page hardcodes the five column letters and takes the
// headings out of row 1 of `display`, so this never goes on the wire.
const CALC_COLUMNS = [
  { key: 'A', label: 'Depot' },
  { key: 'B', label: 'July' },
  { key: 'C', label: 'August' },
  { key: 'D', label: 'September' },
  { key: 'E', label: 'Quarter' },
];

const CALC_DEPOTS = [
  { name: 'Ardsley Yard', jul: 48210.55, aug: 51380.2, sep: 49775.9 },
  { name: 'Brackwell Depot', jul: 36402.1, aug: 35990.75, sep: 38214.45 },
  { name: 'Caldmore Cross', jul: 27655.8, aug: 29104.35, sep: 28320.6 },
  { name: 'Dunhollow North', jul: 52880.25, aug: 50117.6, sep: 53406.15 },
  { name: 'Eastmarch Wharf', jul: 41230.4, aug: 43765.05, sep: 42088.7 },
  { name: 'Fernlow Sidings', jul: 19875.65, aug: 21340.9, sep: 20612.35 },
  { name: 'Garrowby Point', jul: 33450.2, aug: 32118.45, sep: 34907.8 },
  { name: 'Havenscar Terminal', jul: 58012.35, aug: 56480.15, sep: 59233.7 },
  { name: 'Inglemoor Depot', jul: 24760.9, aug: 26005.5, sep: 25417.25 },
  { name: 'Jarrowfield West', jul: 45118.75, aug: 44290.3, sep: 46752.85 },
  { name: 'Kesteven Halt', jul: 30284.6, aug: 31572.15, sep: 29866.4 },
  { name: 'Lowdham Junction', jul: 38955.05, aug: 37421.8, sep: 39680.95 },
];

const CALC_FIRST_ROW = 2;

const CALC_LAST_ROW = CALC_FIRST_ROW + CALC_DEPOTS.length - 1;

const CALC_TOTAL_ROW = CALC_LAST_ROW + 1;

// The defect, drawn per session. Every variant leaves the workbook's quarter
// total short of the ledger control total, but eight of the ten break a depot
// row on seven different rows rather than the grand total, so "the total cell is
// wrong" is a 1-in-5 guess. The reconciliation rail deliberately reports ONE
// combined agreement figure, so a row defect and a total defect look identical
// from outside: both read "15 of 16" and "3 checks failing".
const CALC_DEFECTS = [
  { ref: 'E14', broken: '=SUM(E2:E12)' },
  { ref: 'E14', broken: '=SUM(E3:E13)' },
  { ref: 'E2', broken: '=SUM(B2:C2)' },
  { ref: 'E5', broken: '=SUM(C5:D5)' },
  { ref: 'E6', broken: '=SUM(B6:C6)' },
  { ref: 'E8', broken: '=B8+C8' },
  { ref: 'E10', broken: '=SUM(C10:D10)' },
  { ref: 'E10', broken: '=B10+D10' },
  { ref: 'E11', broken: '=SUM(C11:D11)' },
  { ref: 'E13', broken: '=SUM(B13:C13)' },
];

// Correct formulas that LOOK irregular, so the workbook's formula-audit pane can
// flag eight cells without the flag text itself naming the defect: every flag
// reads "Inconsistent formula", and only opening each cell's formula bar
// separates the one that actually drops data from the seven that do not. The
// quirk rows and the defect rows are disjoint, so the audit list is always the
// session's defect plus these seven.
const CALC_QUIRKS = {
  E3: '=SUM(B3:C3)+D3',
  E4: '=B4+C4+D4',
  E7: '=D7+SUM(B7:C7)',
  E9: '=ROUND(SUM(B9:D9),2)',
  E12: '=B12+SUM(C12:D12)',
  C14: '=SUM(C2:C7)+SUM(C8:C13)',
  D14: '=SUM(D2:D8)+SUM(D9:D13)',
};

const CALC_AUDIT_DECOYS = ['C14', 'D14', 'E3', 'E4', 'E7', 'E9', 'E12'];

function calcColName(index) {
  let name = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function calcParseRef(text) {
  const match = /^\$?([A-Z]+)\$?([0-9]{1,4})$/.exec(text);
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(match[2]);
  if (!col || !row) return null;
  return { col, row, ref: match[1] + row };
}

function calcTokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const value = Number(src.slice(i, j));
      if (!Number.isFinite(value)) throw new Error(`bad number "${src.slice(i, j)}"`);
      out.push({ t: 'num', v: value });
      i = j;
    } else if (/[A-Za-z$_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9$_]/.test(src[j])) j += 1;
      out.push({ t: 'word', v: src.slice(i, j) });
      i = j;
    } else if ('+-*/(),:'.includes(ch)) {
      out.push({ t: ch });
      i += 1;
    } else {
      throw new Error(`unexpected character "${ch}"`);
    }
  }
  return out;
}

// Recursive descent over the subset of the formula language this workbook uses:
// + - * /, parentheses, unary sign, A1 refs (with or without $), A1:B2 ranges and
// SUM / AVERAGE / AVG / MIN / MAX / COUNT / ABS / ROUND.
function calcParse(src) {
  const toks = calcTokens(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    if (toks[p]?.t !== t) throw new Error(`expected "${t}"`);
    return toks[p++];
  };

  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      left = { k: 'bin', op, a: left, b: parseTerm() };
    }
    return left;
  }
  function parseTerm() {
    let left = parseUnary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = toks[p++].t;
      left = { k: 'bin', op, a: left, b: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && (peek().t === '-' || peek().t === '+')) {
      const op = toks[p++].t;
      return { k: 'un', op, a: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error('formula ends early');
    if (tk.t === 'num') {
      p += 1;
      return { k: 'num', v: tk.v };
    }
    if (tk.t === '(') {
      p += 1;
      const inner = parseExpr();
      eat(')');
      return inner;
    }
    if (tk.t === 'word') {
      p += 1;
      if (peek()?.t === '(') {
        p += 1;
        const args = [];
        if (peek()?.t !== ')') {
          args.push(parseExpr());
          while (peek()?.t === ',') {
            p += 1;
            args.push(parseExpr());
          }
        }
        eat(')');
        return { k: 'call', name: tk.v.toUpperCase(), args };
      }
      const start = calcParseRef(tk.v.toUpperCase());
      if (!start) throw new Error(`unknown name "${tk.v}"`);
      if (peek()?.t === ':') {
        p += 1;
        const endTok = eat('word');
        const end = calcParseRef(endTok.v.toUpperCase());
        if (!end) throw new Error(`bad range end "${endTok.v}"`);
        return { k: 'range', a: start, b: end };
      }
      return { k: 'ref', ref: start.ref };
    }
    throw new Error('unexpected token');
  }

  const ast = parseExpr();
  if (p !== toks.length) throw new Error('trailing characters');
  return ast;
}

function calcExpandRange(a, b) {
  const c1 = Math.min(a.col, b.col);
  const c2 = Math.max(a.col, b.col);
  const r1 = Math.min(a.row, b.row);
  const r2 = Math.max(a.row, b.row);
  if ((c2 - c1 + 1) * (r2 - r1 + 1) > 400) throw new Error('range too large');
  const out = [];
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) out.push(calcColName(c) + r);
  }
  return out;
}

function calcEval(ast, get) {
  const scalar = (node) => {
    const value = walk(node);
    if (Array.isArray(value)) throw new Error('a range cannot be used here');
    return value;
  };
  function walk(node) {
    if (node.k === 'num') return node.v;
    if (node.k === 'ref') return get(node.ref);
    if (node.k === 'range') return calcExpandRange(node.a, node.b).map(get);
    if (node.k === 'un') return node.op === '-' ? -scalar(node.a) : scalar(node.a);
    if (node.k === 'bin') {
      const a = scalar(node.a);
      const b = scalar(node.b);
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      if (b === 0) throw new Error('division by zero');
      return a / b;
    }
    if (node.k === 'call') {
      const flat = [];
      for (const arg of node.args) {
        const value = walk(arg);
        if (Array.isArray(value)) flat.push(...value);
        else flat.push(value);
      }
      if (node.name === 'SUM') return flat.reduce((sum, x) => sum + x, 0);
      if (node.name === 'COUNT') return flat.length;
      if (node.name === 'AVERAGE' || node.name === 'AVG') {
        if (!flat.length) throw new Error('AVERAGE needs a value');
        return flat.reduce((sum, x) => sum + x, 0) / flat.length;
      }
      if (node.name === 'MIN') {
        if (!flat.length) throw new Error('MIN needs a value');
        return Math.min(...flat);
      }
      if (node.name === 'MAX') {
        if (!flat.length) throw new Error('MAX needs a value');
        return Math.max(...flat);
      }
      if (node.name === 'ABS') {
        if (!flat.length) throw new Error('ABS needs a value');
        return Math.abs(flat[0]);
      }
      if (node.name === 'ROUND') {
        if (!flat.length) throw new Error('ROUND needs a value');
        const digits = flat.length > 1 ? Math.trunc(flat[1]) : 0;
        const factor = 10 ** digits;
        return Math.round(flat[0] * factor) / factor;
      }
      throw new Error(`unknown function ${node.name}`);
    }
    throw new Error('bad formula');
  }
  return scalar(ast);
}

function calcRefsOf(ast) {
  const refs = new Set();
  (function walk(node) {
    if (!node) return;
    if (node.k === 'ref') refs.add(node.ref);
    else if (node.k === 'range') for (const ref of calcExpandRange(node.a, node.b)) refs.add(ref);
    else if (node.k === 'bin') {
      walk(node.a);
      walk(node.b);
    } else if (node.k === 'un') walk(node.a);
    else if (node.k === 'call') node.args.forEach(walk);
  })(ast);
  return refs;
}

// Whole-sheet recalculation, memoised, with cycle detection. A cell that throws
// records its message in `errors` and evaluates as 0 so one bad formula never
// takes the rest of the sheet down.
function calcRecalc(cells) {
  const values = {};
  const errors = {};
  const visiting = new Set();
  function get(ref) {
    if (ref in values) return values[ref];
    const cell = cells[ref];
    if (!cell) return 0;
    if (cell.kind !== 'formula') {
      const n = Number(cell.raw);
      values[ref] = Number.isFinite(n) ? n : 0;
      return values[ref];
    }
    if (visiting.has(ref)) throw new Error(`circular reference through ${ref}`);
    visiting.add(ref);
    try {
      values[ref] = calcEval(calcParse(cell.formula.slice(1)), get);
    } catch (error) {
      errors[ref] = error.message;
      values[ref] = 0;
    } finally {
      visiting.delete(ref);
    }
    return values[ref];
  }
  for (const ref of Object.keys(cells)) {
    try {
      get(ref);
    } catch (error) {
      errors[ref] = error.message;
      values[ref] = 0;
    }
  }
  return { values, errors };
}

function calcMoney(value) {
  return Number(value).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function calcIsTotalCell(ref) {
  const parsed = calcParseRef(ref);
  if (!parsed) return false;
  return parsed.row !== 1 && (parsed.col === 5 || parsed.row === CALC_TOTAL_ROW);
}

// The header row and the depot column are protected the way a shared finance
// workbook protects its labels, so an edit can only ever land on data or totals.
function calcIsProtected(ref) {
  const parsed = calcParseRef(ref);
  if (!parsed) return true;
  return parsed.row === 1 || parsed.col === 1;
}

// Draws the session's sheet: the per-session September jitter, the defect, and
// the checksum that is released only once every total agrees.
function calcState(session, draw = (_scope, n) => randomBytes(n)) {
  if (session.calc) return session.calc;
  const jitterRow = CALC_FIRST_ROW + (draw('calc', 1)[0] % CALC_DEPOTS.length);
  const jitter = 500 + (draw('calc', 2).readUInt16BE(0) % 9000) + draw('calc', 1)[0] / 100;
  const defect = CALC_DEFECTS[draw('calc', 1)[0] % CALC_DEFECTS.length];

  const cells = {};
  const baseline = {};
  for (const column of CALC_COLUMNS) cells[`${column.key}1`] = { kind: 'text', raw: column.label };
  CALC_DEPOTS.forEach((depot, index) => {
    const row = CALC_FIRST_ROW + index;
    cells[`A${row}`] = { kind: 'text', raw: depot.name };
    const sep = row === jitterRow ? Math.round((depot.sep + jitter) * 100) / 100 : depot.sep;
    cells[`B${row}`] = { kind: 'number', raw: depot.jul };
    cells[`C${row}`] = { kind: 'number', raw: depot.aug };
    cells[`D${row}`] = { kind: 'number', raw: sep };
    baseline[`B${row}`] = depot.jul;
    baseline[`C${row}`] = depot.aug;
    baseline[`D${row}`] = sep;
    cells[`E${row}`] = { kind: 'formula', formula: CALC_QUIRKS[`E${row}`] ?? `=SUM(B${row}:D${row})` };
  });
  cells[`A${CALC_TOTAL_ROW}`] = { kind: 'text', raw: 'All depots' };
  for (const col of ['B', 'C', 'D']) {
    const ref = `${col}${CALC_TOTAL_ROW}`;
    cells[ref] = {
      kind: 'formula',
      formula: CALC_QUIRKS[ref] ?? `=SUM(${col}${CALC_FIRST_ROW}:${col}${CALC_LAST_ROW})`,
    };
  }
  cells[`E${CALC_TOTAL_ROW}`] = {
    kind: 'formula',
    formula: `=SUM(E${CALC_FIRST_ROW}:E${CALC_LAST_ROW})`,
  };

  // The control total is the ledger's own figure: the sum of the 36 posted
  // amounts, computed BEFORE the defect is planted, so it is the fixed point
  // every repair has to land on.
  const control = Object.entries(baseline).reduce((sum, [, amount]) => sum + amount, 0);

  cells[defect.ref] = { kind: 'formula', formula: defect.broken };

  const audit = [defect.ref, ...CALC_AUDIT_DECOYS];
  for (let i = audit.length - 1; i > 0; i -= 1) {
    const j = draw('calc', 1)[0] % (i + 1);
    [audit[i], audit[j]] = [audit[j], audit[i]];
  }

  // What every cell was issued as, so an edit is never a dead end: the formula
  // bar's Revert button puts a cell back to this, which is the only way to
  // recover a posted amount somebody typed over.
  const issued = {};
  for (const [ref, cell] of Object.entries(cells)) {
    issued[ref] = cell.kind === 'formula' ? cell.formula : String(cell.raw);
  }

  session.calc = {
    cells,
    baseline,
    issued,
    control: Math.round(control * 100) / 100,
    culprit: { ref: defect.ref, broken: defect.broken },
    audit,
    jitterRow,
    // Every formula the session has pulled into the formula bar, in order, and
    // every commit it has attempted. Neither gates anything; both are reported
    // in the validator's detail so a sweep can tell a formula-bar solve from a
    // brute-force one.
    formulaReads: [],
    edits: [],
    reconciled: false,
    reconciledAt: null,
    checksum: null,
    sheetFetches: 0,
  };
  return session.calc;
}

// Every invariant the workbook's Reconcile check enforces: each depot's quarter
// cell equals its three months, each column total equals its column, the grand
// total agrees both ways, the posted monthly amounts are untouched, and the
// result matches the ledger control total. Only the true defect can satisfy all
// of them, so patching over the symptom in E14 does not reconcile the sheet.
function calcCheck(calc) {
  const { values, errors } = calcRecalc(calc.cells);
  const near = (a, b) => Math.abs(a - b) < 0.005;
  const failing = [];
  for (const ref of Object.keys(errors)) failing.push(ref);
  let postedIntact = true;
  for (const [ref, amount] of Object.entries(calc.baseline)) {
    if (calc.cells[ref]?.kind !== 'number' || !near(Number(calc.cells[ref].raw), amount)) {
      failing.push(ref);
      postedIntact = false;
    }
  }
  const rowCount = CALC_LAST_ROW - CALC_FIRST_ROW + 1;
  let rowsAgree = 0;
  for (let row = CALC_FIRST_ROW; row <= CALC_LAST_ROW; row += 1) {
    const months = values[`B${row}`] + values[`C${row}`] + values[`D${row}`];
    if (near(values[`E${row}`], months)) rowsAgree += 1;
    else failing.push(`E${row}`);
  }
  let colsAgree = 0;
  for (const col of ['B', 'C', 'D', 'E']) {
    let column = 0;
    for (let row = CALC_FIRST_ROW; row <= CALC_LAST_ROW; row += 1) column += values[`${col}${row}`];
    if (near(values[`${col}${CALC_TOTAL_ROW}`], column)) colsAgree += 1;
    else failing.push(`${col}${CALC_TOTAL_ROW}`);
  }
  const grand = values[`E${CALC_TOTAL_ROW}`];
  const acrossTotals =
    values[`B${CALC_TOTAL_ROW}`] + values[`C${CALC_TOTAL_ROW}`] + values[`D${CALC_TOTAL_ROW}`];
  if (!near(grand, acrossTotals)) failing.push('cross');
  const controlMatched = near(grand, calc.control);
  if (!controlMatched) failing.push('control');
  return {
    values,
    errors,
    failing: [...new Set(failing)],
    reconciled: failing.length === 0,
    // ONE combined figure, deliberately: reporting the depot rows and the column
    // totals separately would tell the reader which layer is broken, and a
    // snapshot-only agent could then name the culprit without opening a single
    // formula. A depot-row defect and a grand-total defect both read "15 of 16".
    agreeing: `${rowsAgree + colsAgree} of ${rowCount + 4}`,
    controlMatched,
    postedIntact,
    grand: Math.round(grand * 100) / 100,
    variance: Math.round((grand - calc.control) * 100) / 100 || 0,
  };
}

// The wire shape both /api/calc/sheet and /api/calc/cell answer with. It carries
// the grid's VALUES and never a formula: the formula bar is filled one cell at a
// time by /api/calc/cell, so the two representations of a cell really are served
// separately.
function calcPayload(calc, withFormulas = false) {
  const check = calcCheck(calc);
  if (check.reconciled && !calc.reconciled) {
    calc.reconciled = true;
    calc.reconciledAt = Date.now();
    calc.checksum ??= 'RC-' + randomBytes(3).toString('hex').toUpperCase();
  }
  const display = {};
  const formulas = {};
  for (const [ref, cell] of Object.entries(calc.cells)) {
    if (cell.kind === 'text') display[ref] = String(cell.raw);
    else if (check.errors[ref]) display[ref] = '#ERROR';
    else display[ref] = calcMoney(check.values[ref] ?? 0);
    if (withFormulas) formulas[ref] = cell.kind === 'formula' ? cell.formula : String(cell.raw);
  }
  return {
    workbook: CALC_WORKBOOK,
    sheet: CALC_SHEET,
    owner: CALC_OWNER,
    firstRow: CALC_FIRST_ROW,
    lastRow: CALC_LAST_ROW,
    totalRow: CALC_TOTAL_ROW,
    display,
    ...(withFormulas ? { formulas } : {}),
    audit: calc.audit,
    control: calcMoney(calc.control),
    grand: calcMoney(check.grand),
    variance: calcMoney(check.variance),
    agreeing: check.agreeing,
    controlMatched: check.controlMatched,
    postedIntact: check.postedIntact,
    failing: check.failing.length,
    reconciled: check.reconciled,
    checksum: check.reconciled ? calc.checksum : null,
  };
}

export function routes(ctx) {
  const { state, json, readBody, getSession, requireSession, fromPage, draw } = ctx;
  return async (req, res, url, pathname0) => {
    // Abaca workbook: the grid's values. Formulas are deliberately NOT in this
    // payload — the page has to ask for them one cell at a time, or turn on the
    // ribbon's Show formulas view, which is the one bulk read and is recorded.
    if (req.method === 'GET' && pathname0 === '/api/calc/sheet') {
      const found = requireSession(req, res);
      if (!found) return;
      const calc = calcState(found.session, draw);
      calc.sheetFetches += 1;
      const withFormulas = url.searchParams.get('formulas') === '1';
      if (withFormulas) {
        // One event, not one per cell. The Show formulas view does reveal every
        // formula at once, but recording it as a read of each cell made
        // `formulaReads` count 70 where a run had done one thing, and made a
        // bulk view indistinguishable from 70 deliberate cell selections.
        // fromPage is legibility, never proof: a shell GET of ?formulas=1
        // satisfies the same read, and the validator's detail line is where
        // that difference has to show up.
        calc.formulaReads.push({
          ref: null,
          bulk: true,
          fromPage:
            req.headers['sec-fetch-site'] === 'same-origin' ||
            /\/calc\//.test(req.headers.referer ?? ''),
          at: Date.now(),
        });
      }
      return json(res, 200, calcPayload(calc, withFormulas));
    }

    // One cell's definition, which is what the formula bar shows. Every read is
    // recorded so a sweep can see how many cells a run actually opened.
    if (req.method === 'GET' && pathname0 === '/api/calc/cell') {
      const found = requireSession(req, res);
      if (!found) return;
      const calc = calcState(found.session, draw);
      const ref = calcParseRef(String(url.searchParams.get('ref') ?? '').toUpperCase())?.ref;
      const cell = ref ? calc.cells[ref] : null;
      if (!cell) return json(res, 404, { error: 'no such cell' });
      calc.formulaReads.push({
        ref,
        fromPage:
          req.headers['sec-fetch-site'] === 'same-origin' ||
          /\/calc\//.test(req.headers.referer ?? ''),
        at: Date.now(),
      });
      const check = calcCheck(calc);
      return json(res, 200, {
        ref,
        kind: cell.kind,
        input: cell.kind === 'formula' ? cell.formula : String(cell.raw),
        display: cell.kind === 'text' ? String(cell.raw) : calcMoney(check.values[ref] ?? 0),
        error: check.errors[ref] ?? null,
        computed: calcIsTotalCell(ref),
        editable: !calcIsProtected(ref),
        // What the cell was issued as, so the formula bar's Revert button can put
        // an overwritten posted amount back; `posted` marks the 36 amounts that
        // came from the ledger rather than from this workbook.
        issued: calc.issued[ref] ?? null,
        posted: ref in calc.baseline,
      });
    }

    // Commit an edit. The server recalculates the whole sheet from the submitted
    // text and grades the RESULT, so any formula that produces the right totals
    // is accepted; total cells additionally have to be a formula over at least
    // two cells, because typing the answer in as a constant is not a repair.
    if (req.method === 'POST' && pathname0 === '/api/calc/cell') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'bad json' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const calc = calcState(found.session, draw);
      const parsed = calcParseRef(String(payload?.ref ?? '').toUpperCase());
      const ref = parsed?.ref;
      const previous = ref ? calc.cells[ref] : null;
      if (!previous) return json(res, 404, { error: 'no such cell' });
      const input = String(payload?.input ?? '').trim();
      const reject = (message) => {
        calc.edits.push({ ref, input, accepted: false, reason: message, at: Date.now() });
        return json(res, 400, { error: message, ref });
      };
      if (calcIsProtected(ref)) return reject(`${ref} is a protected label cell.`);
      if (input.length > 200) return reject('That entry is too long for a cell.');
      const computed = calcIsTotalCell(ref);

      let next;
      if (input.startsWith('=')) {
        let ast;
        try {
          ast = calcParse(input.slice(1));
        } catch (error) {
          return reject(`${ref}: ${error.message}`);
        }
        let refs;
        try {
          refs = calcRefsOf(ast);
        } catch (error) {
          return reject(`${ref}: ${error.message}`);
        }
        if (refs.has(ref)) return reject(`${ref} cannot refer to itself.`);
        if (computed && refs.size < 2) {
          return reject(`${ref} is a total cell and must add up at least two cells.`);
        }
        next = { kind: 'formula', formula: input };
      } else {
        if (computed) {
          return reject(`${ref} is a total cell: enter a formula, not a typed-in figure.`);
        }
        const amount = Number(input.replace(/[, ]/g, ''));
        if (!Number.isFinite(amount)) return reject(`${ref}: that is not an amount.`);
        next = { kind: 'number', raw: amount };
      }

      // An edit is rejected if it makes ANY cell fail to evaluate, not just the
      // one being edited: a formula that is fine in isolation can put a cell it
      // feeds into a cycle, and silently leaving #ERROR somewhere else on the
      // sheet with no message is a dead end.
      const broke = Object.keys(calcCheck(calc).errors);
      calc.cells[ref] = next;
      const check = calcCheck(calc);
      const introduced = Object.keys(check.errors).filter((r) => !broke.includes(r));
      if (introduced.length) {
        const at = introduced.includes(ref) ? ref : introduced[0];
        const message =
          at === ref
            ? `${ref}: ${check.errors[at]}`
            : `${ref} would break ${at}: ${check.errors[at]}`;
        calc.cells[ref] = previous;
        return reject(message);
      }
      calc.edits.push({ ref, input, accepted: true, at: Date.now() });
      const postedWas =
        ref in calc.baseline && !(next.kind === 'number' && Number(next.raw) === calc.baseline[ref])
          ? calcMoney(calc.baseline[ref])
          : null;
      return json(res, 200, { ok: true, ref, postedWas, ...calcPayload(calc) });
    }

    return false;
  };
}
