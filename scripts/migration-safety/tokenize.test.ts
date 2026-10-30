import { describe, expect, test } from "bun:test";
import { SqlSyntaxError, splitStatements, tokenize } from "./tokenize";

const texts = (sql: string) => tokenize(sql).map((token) => token.text);
const statementTexts = (sql: string) =>
  splitStatements(sql).map((statement) => statement.tokens.map((token) => token.text).join(" "));

describe("tokenize", () => {
  test.each([
    ["line comment", "SELECT 1 -- DROP TABLE a;\n", ["SELECT", "1"]],
    ["block comment", "SELECT /* DROP TABLE a; */ 1", ["SELECT", "1"]],
    ["nested block comment", "SELECT /* a /* b */ DROP */ 1", ["SELECT", "1"]],
    ["comment markers inside a string", "SELECT '-- x /* y'", ["SELECT", "-- x /* y"]],
    ["doubled quote in a string", "SELECT 'it''s; DROP'", ["SELECT", "it's; DROP"]],
    ["quoted identifier", 'ALTER TABLE "DROP;TABLE"', ["ALTER", "TABLE", "DROP;TABLE"]],
    ["doubled quote in an identifier", 'SELECT "a""b"', ["SELECT", 'a"b']],
    [
      "E string with an escaped quote",
      String.raw`SELECT E'a\'; DROP'`,
      ["SELECT", String.raw`a\'; DROP`],
    ],
    [
      "plain string keeps a backslash literal",
      String.raw`SELECT 'a\'; SELECT 2`,
      ["SELECT", "a\\", ";", "SELECT", "2"],
    ],
    [
      "anonymous dollar quoting",
      "DO $$ BEGIN DROP TABLE a; END $$",
      ["DO", " BEGIN DROP TABLE a; END "],
    ],
    ["tagged dollar quoting", "DO $fn$ SELECT '$$'; $fn$", ["DO", " SELECT '$$'; "]],
    ["a parameter is not a dollar quote", "SELECT $1, $2", ["SELECT", "$", "1", ",", "$", "2"]],
    ["a cast", "SELECT 1::int", ["SELECT", "1", "::", "int"]],
  ])("%s", (_name, sql, expected) => {
    expect(texts(sql)).toEqual(expected);
  });

  test("keeps line numbers across comments and quoted newlines", () => {
    const tokens = tokenize("-- c\n/* a\nb */ SELECT\n'x\ny' Z");
    expect(tokens.map((token) => [token.text, token.line])).toEqual([
      ["SELECT", 3],
      ["x\ny", 4],
      ["Z", 5],
    ]);
  });

  test.each([
    ["string", "SELECT 'a"],
    ["identifier", 'SELECT "a'],
    ["block comment", "SELECT /* a"],
    ["dollar quote", "DO $$ a"],
  ])("an unterminated %s is an error", (_name, sql) => {
    expect(() => tokenize(sql)).toThrow(SqlSyntaxError);
  });
});

describe("splitStatements", () => {
  test("splits several statements on one line", () => {
    expect(statementTexts("SELECT 1; SELECT 2;SELECT 3")).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
  });

  test("ignores semicolons in strings, identifiers, comments, dollar quotes and parentheses", () => {
    const sql = `SELECT ';'; ALTER TABLE ";" -- ;\n ADD x; /* ; */ DO $$ a; b; $$; CREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1; SELECT 2)`;
    expect(splitStatements(sql)).toHaveLength(4);
  });

  test("drops empty statements and reports each statement's first line", () => {
    const statements = splitStatements(";;\n\nSELECT 1;\n;\nSELECT 2");
    expect(statements.map((statement) => statement.line)).toEqual([3, 5]);
  });
});
