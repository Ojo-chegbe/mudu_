// RFC 4180-style quoted fields, including embedded commas and newlines.
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const input = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else field += ch;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      closed = false;
      if (ch !== ',') {
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        if (ch === '\r' && input[i + 1] === '\n') i++;
      }
    } else if (ch === '"' && !field && !closed) quoted = true;
    else {
      if (closed || ch === '"')
        throw new Error('Invalid CSV quoting. Check the file and try again.');
      field += ch;
    }
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function writeCsv(rows: string[][]): string {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((cell) => {
            const safe = /^[\s]*[=+\-@]/.test(cell) || /^[\t\r\n]/.test(cell) ? `'${cell}` : cell;
            return `"${safe.replaceAll('"', '""')}"`;
          })
          .join(','),
      )
      .join('\r\n')
  );
}
