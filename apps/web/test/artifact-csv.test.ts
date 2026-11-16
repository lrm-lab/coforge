import { expect, test } from "bun:test";

import { parseCsv } from "#src/features/artifacts/artifact-csv";

const lines = (text: string) => parseCsv(text).map(({ line, endLine }) => [line, endLine]);

test("each record knows the file lines it starts and ends on", () => {
  expect(lines("a,b\n1,2\n3,4\n")).toEqual([
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
});

test("a quoted cell that spans lines advances the count", () => {
  expect(lines('name,note\r\nLee,"first\nsecond\nthird"\nBo,ok\n')).toEqual([
    [1, 1],
    [2, 4],
    [5, 5],
  ]);
});

test("a blank line is a record of its own and cells are unquoted", () => {
  const records = parseCsv('a,"x ""y"""\n\nb\n');
  expect(records.map((record) => record.cells)).toEqual([["a", 'x "y"'], [""], ["b"]]);
  expect(records.map((record) => record.line)).toEqual([1, 2, 3]);
});

test("a lone carriage return ends a record and advances the line like a newline", () => {
  expect(lines("a\rb\rc")).toEqual([
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  expect(lines('a,"x\ry"\rb')).toEqual([
    [1, 2],
    [3, 3],
  ]);
});

test("a final record that is only an empty quoted cell is kept", () => {
  expect(parseCsv('a\n""').map((record) => record.cells)).toEqual([["a"], [""]]);
});
