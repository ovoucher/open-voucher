// Minimal RFC 4180 CSV reader/writer (quoted fields, embedded commas and quotes, CRLF).

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const records = parseRecords(text.replace(/^﻿/, ''));
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (nonEmpty.length === 0) return { header: [], rows: [] };
  const header = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const row: CsvRow = {};
    header.forEach((h, i) => {
      row[h] = r[i] ?? '';
    });
    return row;
  });
  return { header, rows };
}

function parseRecords(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

function esc(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Converts an array of objects to a CSV string given a specific header order. */
export function toCsv(header: string[], rows: Array<Record<string, string | number | bigint | boolean | undefined>>): string {
  const lines = [header.map(esc).join(',')];
  for (const r of rows) lines.push(header.map((h) => esc(r[h] === undefined ? '' : String(r[h]))).join(','));
  return lines.join('\n') + '\n';
}
