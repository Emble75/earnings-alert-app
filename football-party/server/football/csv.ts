/**
 * Streaming-friendly RFC-4180 CSV reader: yields one record (header → value) at a time so 80 MB
 * files do not need a second in-memory copy as an array of objects. Handles quotes, escaped quotes
 * and CRLF.
 */
export function* csvRecords(text: string): Generator<Record<string, string>> {
  let header: string[] | null = null;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const n = text.length;
  const flush = function* (): Generator<Record<string, string>> {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') {
      if (!header) header = row.map((h) => h.replace(/^\uFEFF/, ''));
      else {
        const rec: Record<string, string> = {};
        for (let i = 0; i < header.length; i++) rec[header[i]!] = row[i] ?? '';
        yield rec;
      }
    }
    row = [];
  };
  for (let i = 0; i < n; i++) {
    const ch = text.charCodeAt(i);
    if (quoted) {
      if (ch === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          field += '"';
          i++;
        } else quoted = false;
      } else field += text[i];
    } else if (ch === 34) quoted = true;
    else if (ch === 44) {
      row.push(field);
      field = '';
    } else if (ch === 10 || ch === 13) {
      if (ch === 13 && text.charCodeAt(i + 1) === 10) i++;
      yield* flush();
    } else field += text[i];
  }
  if (field !== '' || row.length) yield* flush();
}

export const parseCsv = (text: string): Record<string, string>[] => [...csvRecords(text)];
