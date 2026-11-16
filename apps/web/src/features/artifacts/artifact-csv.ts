export type CsvRecord = { cells: string[]; line: number; endLine: number };

export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let fieldOpened = false;
  let line = 1;
  let startLine = 1;
  const finish = () => {
    cells.push(field);
    records.push({ cells, line: startLine, endLine: line });
    cells = [];
    field = "";
    fieldOpened = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else {
        field += char;
        if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) line += 1;
      }
    } else if (char === '"') {
      quoted = true;
      fieldOpened = true;
    } else if (char === ",") {
      cells.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      const crlf = char === "\r" && text[index + 1] === "\n";
      if (crlf) index += 1;
      finish();
      line += 1;
      startLine = line;
    } else field += char;
  }
  if (field !== "" || fieldOpened || cells.length > 0) finish();
  return records;
}
