// A small PDF 1.4 writer for documents a site mints per session (Grelsby
// Water's bills). Text uses the standard 14 fonts, so nothing is embedded, and
// every page's content stream is FlateDecode-compressed, as a real billing
// system's output is: the text is only readable through a PDF viewer or by
// inflating the stream.
import { deflateSync } from 'node:zlib';

const FONTS = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Courier' };

// Helvetica advance widths (1/1000 em) for ASCII 32-126, from the Adobe AFM.
// Only right-aligned figures and centred headings are measured, and the bold
// face's digits and punctuation share these widths.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// WinAnsiEncoding bytes for the few non-ASCII characters the bills print.
const WIN_ANSI = { '–': 0x96, '—': 0x97, '•': 0x95, '·': 0xb7, '’': 0x92 };

export function textWidth(text, size, font = 'F1') {
  if (font === 'F3') return String(text).length * 600 * size / 1000;
  let units = 0;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? HELVETICA[code - 32] : 556;
  }
  return units * size / 1000;
}

function literal(text) {
  let out = '';
  for (const ch of String(text)) {
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (WIN_ANSI[ch]) out += '\\' + WIN_ANSI[ch].toString(8);
    else if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126) out += '?';
    else out += ch;
  }
  return `(${out})`;
}

const num = (n) => String(Math.round(n * 100) / 100);

// One page's drawing operations. Each text() call is its own BT/ET block with
// an absolute text matrix, so a table cell is one positioned run.
export class PdfPage {
  constructor() {
    this.ops = [];
  }

  // `align` is 'left', 'right' (x is the right edge) or 'center'.
  text(x, y, text, { font = 'F1', size = 9, align = 'left', gray = 0 } = {}) {
    const w = textWidth(text, size, font);
    const at = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(
      `BT ${num(gray)} g /${font} ${num(size)} Tf 1 0 0 1 ${num(at)} ${num(y)} Tm ${literal(text)} Tj ET`
    );
    return this;
  }

  rule(x1, y1, x2, y2, { width = 0.5, gray = 0, dash = null } = {}) {
    this.ops.push(
      `q ${num(gray)} G ${num(width)} w ${dash ? `[${dash.join(' ')}] 0 d ` : ''}` +
        `${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S Q`
    );
    return this;
  }

  // Filled and/or stroked rectangle; y is the bottom edge.
  box(x, y, w, h, { fill = null, stroke = null, width = 0.5 } = {}) {
    const paint = fill !== null && stroke !== null ? 'B' : fill !== null ? 'f' : 'S';
    this.ops.push(
      `q ${fill !== null ? `${num(fill)} g ` : ''}${stroke !== null ? `${num(stroke)} G ` : ''}` +
        `${num(width)} w ${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${paint} Q`
    );
    return this;
  }

  // A stroked circle from four Bezier arcs.
  circle(cx, cy, r, { width = 1, gray = 0 } = {}) {
    const k = 0.5523 * r;
    this.ops.push(
      `q ${num(gray)} G ${num(width)} w ${num(cx + r)} ${num(cy)} m ` +
        `${num(cx + r)} ${num(cy + k)} ${num(cx + k)} ${num(cy + r)} ${num(cx)} ${num(cy + r)} c ` +
        `${num(cx - k)} ${num(cy + r)} ${num(cx - r)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} c ` +
        `${num(cx - r)} ${num(cy - k)} ${num(cx - k)} ${num(cy - r)} ${num(cx)} ${num(cy - r)} c ` +
        `${num(cx + k)} ${num(cy - r)} ${num(cx + r)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} c S Q`
    );
    return this;
  }
}

// Letter-size pages into one document. `info` fills the /Info dictionary;
// `created` is a Date for its CreationDate, so the same inputs always give the
// same bytes.
export function pdfDocument(pages, { info = {}, created = null, width = 612, height = 792 } = {}) {
  const objs = [];
  // An object's number is its 1-based position.
  const add = (body) => objs.push(body);
  const catalog = add(null);
  const pagesObj = add(null);
  const fontRefs = Object.entries(FONTS).map(
    ([name, base]) => [name, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`)]
  );
  const resources = `<< /Font << ${fontRefs.map(([n, r]) => `/${n} ${r} 0 R`).join(' ')} >> >>`;
  const kids = [];
  for (const page of pages) {
    const stream = deflateSync(Buffer.from(page.ops.join('\n'), 'latin1'));
    const contents = add({ dict: `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream });
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] ` +
          `/Resources ${resources} /Contents ${contents} 0 R >>`
      )
    );
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const stamp = created
    ? `D:${created.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`
    : null;
  const infoEntries = Object.entries(info).map(([k, v]) => `/${k} ${literal(v)}`);
  if (stamp) infoEntries.push(`/CreationDate (${stamp})`, `/ModDate (${stamp})`);
  const infoObj = add(`<< ${infoEntries.join(' ')} >>`);

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(offset);
    const parts =
      typeof body === 'string'
        ? [Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')]
        : [
            Buffer.from(`${i + 1} 0 obj\n${body.dict}\nstream\n`, 'latin1'),
            body.stream,
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ];
    for (const p of parts) {
      chunks.push(p);
      offset += p.length;
    }
  });
  const xref =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\n` +
    `startxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
