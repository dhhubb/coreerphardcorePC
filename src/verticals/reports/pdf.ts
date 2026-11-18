/**
 * A tiny, dependency-free PDF writer (F10).
 *
 * The stock reports export to PDF without pulling in a PDF library: the output is a plain PDF 1.4
 * document with the built-in Helvetica font, one or more pages of a simple table, and a byte-accurate
 * cross-reference table. It is deliberately small and pure, so it is unit-testable without a browser
 * or a filesystem (ADR-0077).
 *
 * Only the printable ASCII range is emitted; every other character is replaced with '?', so the
 * output is valid regardless of the data. Text is escaped so a product name can never break the
 * document syntax.
 */

export interface PdfColumn {
  header: string;
  /** Fixed column width in points. */
  width: number;
  align?: 'left' | 'right';
}

export interface PdfTableOptions {
  title: string;
  /** Lines shown under the title (org, branch, period, generated at). */
  meta: string[];
  columns: PdfColumn[];
  /** One row per record, each cell already formatted as a string. */
  rows: string[][];
  /** Optional footer line, e.g. a totals summary. */
  footer?: string;
}

// A4 portrait, in points.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const TITLE_SIZE = 15;
const META_SIZE = 9;
const HEADER_SIZE = 9;
const BODY_SIZE = 8.5;
const ROW_HEIGHT = 14;
const HEADER_HEIGHT = 18;
/** Helvetica's average glyph width is close to half the point size; good enough to truncate to fit. */
const WIDTH_FACTOR = 0.5;

/** Escape a string for a PDF literal string object. Non-ASCII is replaced, never emitted raw. */
export function escapePdfText(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code > 126) {
      out += '?';
    } else if (char === '\\' || char === '(' || char === ')') {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

/** Truncate text to fit a column width at the given font size, appending an ellipsis when cut. */
export function fitText(value: string, width: number, fontSize: number): string {
  const maxChars = Math.max(1, Math.floor(width / (fontSize * WIDTH_FACTOR)));
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, 1);
  return `${value.slice(0, maxChars - 1)}…`;
}

function contentStream(options: PdfTableOptions): string {
  const parts: string[] = [];
  const rightEdge = PAGE_WIDTH - MARGIN;

  // Title and meta.
  let y = PAGE_HEIGHT - MARGIN;
  parts.push('BT');
  parts.push(`/F1 ${TITLE_SIZE} Tf`);
  parts.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
  parts.push(`(${escapePdfText(fitText(options.title, rightEdge - MARGIN, TITLE_SIZE))}) Tj`);
  parts.push('ET');
  y -= TITLE_SIZE + 6;

  parts.push('BT');
  parts.push(`/F1 ${META_SIZE} Tf`);
  parts.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
  for (const line of options.meta) {
    parts.push(`(${escapePdfText(fitText(line, rightEdge - MARGIN, META_SIZE))}) Tj`);
    parts.push('0 -12 Td');
  }
  parts.push('ET');
  y -= options.meta.length * 12 + 8;

  const header = (top: number): number => {
    let x = MARGIN;
    parts.push('BT');
    parts.push(`/F1 ${HEADER_SIZE} Tf`);
    for (const column of options.columns) {
      const text = fitText(column.header, column.width, HEADER_SIZE);
      const width = text.length * HEADER_SIZE * WIDTH_FACTOR;
      const tx = column.align === 'right' ? x + column.width - width : x;
      parts.push(`1 0 0 1 ${tx.toFixed(2)} ${top.toFixed(2)} Tm`);
      parts.push(`(${escapePdfText(text)}) Tj`);
      x += column.width;
    }
    parts.push('ET');
    // A rule under the header row.
    parts.push('0.6 w');
    parts.push(`${MARGIN} ${(top - 4).toFixed(2)} m ${rightEdge} ${(top - 4).toFixed(2)} l S`);
    return top - HEADER_HEIGHT;
  };

  y = header(y);

  for (const row of options.rows) {
    if (y < MARGIN + ROW_HEIGHT) {
      // New page: the caller joins pages; here we simply stop (the builder paginates above).
      break;
    }
    let x = MARGIN;
    parts.push('BT');
    parts.push(`/F1 ${BODY_SIZE} Tf`);
    options.columns.forEach((column, index) => {
      const raw = row[index] ?? '';
      const text = fitText(raw, column.width, BODY_SIZE);
      const width = text.length * BODY_SIZE * WIDTH_FACTOR;
      const tx = column.align === 'right' ? x + column.width - width : x;
      parts.push(`1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm`);
      parts.push(`(${escapePdfText(text)}) Tj`);
      x += column.width;
    });
    parts.push('ET');
    y -= ROW_HEIGHT;
  }

  if (options.footer) {
    y -= 4;
    parts.push('BT');
    parts.push(`/F1 ${BODY_SIZE} Tf`);
    parts.push(`1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm`);
    parts.push(`(${escapePdfText(fitText(options.footer, rightEdge - MARGIN, BODY_SIZE))}) Tj`);
    parts.push('ET');
  }

  return parts.join('\n');
}

/** How many data rows fit on one page after the title block and the header row. */
function rowsPerPage(metaCount: number): number {
  const used = MARGIN + TITLE_SIZE + 6 + metaCount * 12 + 8 + HEADER_HEIGHT + MARGIN + ROW_HEIGHT;
  return Math.max(1, Math.floor((PAGE_HEIGHT - used) / ROW_HEIGHT));
}

/**
 * Build a multi-page PDF table. Returns a Buffer of the whole document. Pages repeat the title
 * block, the meta lines and the column header.
 */
export function buildTablePdf(options: PdfTableOptions): Buffer {
  const perPage = rowsPerPage(options.meta.length);
  const chunks: string[][][] = [];
  for (let index = 0; index < options.rows.length; index += perPage) {
    chunks.push(options.rows.slice(index, index + perPage));
  }
  if (chunks.length === 0) chunks.push([]);

  // Object 1: catalog. Object 2: pages. Object 3: font. Then per page a page object and a stream.
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  const firstPageObject = 4;

  const streams: string[] = chunks.map((rows) =>
    contentStream({ ...options, rows }),
  );

  for (let i = 0; i < streams.length; i += 1) {
    pageObjectNumbers.push(firstPageObject + i * 2);
  }

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${streams.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  streams.forEach((stream, index) => {
    const streamObject = firstPageObject + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamObject} 0 R >>`,
    );
    const bytes = Buffer.byteLength(stream, 'latin1');
    objects.push(`<< /Length ${bytes} >>\nstream\n${stream}\nendstream`);
  });

  // Assemble the file, recording each object's byte offset for the xref table.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
