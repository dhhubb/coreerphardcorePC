/**
 * CSV handling for the migration wizard.
 *
 * Parsing runs in the browser (PapaParse) so the shop sees a preview before anything is uploaded;
 * the parsed rows are then sent to the branch in chunks. This module holds the parts that are
 * shared by the browser and the tests: the chunking, and a small RFC4180 parser.
 */

/** How many rows travel in one chunk from the browser to the branch. */
export const IMPORT_CHUNK_SIZE = 500;

/** Split parsed rows into chunks so a 5,000-row file is not one giant request. */
export function chunkRows<T>(rows: readonly T[], size = IMPORT_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

/**
 * A minimal CSV parser used by the tests and the branch when a file arrives as raw text. PapaParse
 * is the browser parser; this keeps the tests free of a DOM and mirrors its default behaviour
 * (quoted fields, doubled quotes, CRLF or LF).
 */
export function parseCsv(text: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const records = parseCsvRecords(text);
  const header = records.shift();
  if (!header) return { headers: [], rows: [] };
  const headers = header.map((h) => h.trim());
  const rows = records
    .filter((record) => record.some((cell) => cell.trim() !== ''))
    .map((record) => {
      const row: Record<string, string> = {};
      headers.forEach((name, index) => {
        row[name] = record[index] ?? '';
      });
      return row;
    });
  return { headers, rows };
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += 1;
      continue;
    }
    if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}
