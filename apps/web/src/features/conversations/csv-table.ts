/**
 * Parses CSV as RFC 4180 reads it: commas between fields, a field in double quotes may hold commas,
 * line breaks and `""` for a quote, and records end at LF or CRLF. A final line break ends the last
 * record rather than starting an empty one, and a blank line is no record at all, so it takes no
 * row number. Lenient where the RFC is not: a quote inside an unquoted
 * field is kept as text, and an unterminated quoted field runs to the end of the file.
 *
 * Fields are cut out of `text` by index rather than built a character at a time: a 2 MB file built
 * that way leaves millions of short strings behind, and collecting them stalls the page.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let i = 0;
  const length = text.length;
  while (i < length) {
    let field: string;
    const quoted = text[i] === '"';
    if (quoted) {
      // Quoted: runs to the next lone quote; each `""` inside is one quote.
      let value = "";
      let from = i + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote === -1) {
          value += text.slice(from);
          i = length;
          break;
        }
        value += text.slice(from, quote);
        if (text[quote + 1] === '"') {
          value += '"';
          from = quote + 2;
          continue;
        }
        i = quote + 1;
        break;
      }
      // Anything between the closing quote and the next separator stays part of the field.
      const rest = nextSeparator(text, i);
      field = value + text.slice(i, rest);
      i = rest;
    } else {
      const end = nextSeparator(text, i);
      field = text.slice(i, end);
      i = end;
    }
    record.push(field);
    if (i >= length) break;
    if (text[i] === ",") {
      i++;
      if (i === length) record.push("");
      continue;
    }
    // A line break ends the record; CRLF counts once.
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
    if (record.length === 1 && field === "" && !quoted) {
      record = [];
      continue;
    }
    records.push(record);
    record = [];
  }
  if (record.length > 0) records.push(record);
  return records;
}

/** The index of the next comma or line break at or after `from`, or the end of the text. */
function nextSeparator(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (char === 44 || char === 10 || char === 13) return i;
  }
  return text.length;
}
