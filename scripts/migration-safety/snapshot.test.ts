import { describe, expect, test } from "bun:test";
import { assertPlausibleTables, type TableStat } from "./snapshot";

const stat = (name: string, approxRows: number, totalBytes: number): TableStat => ({
  schema: "public",
  name,
  approxRows,
  totalBytes,
});

describe("assertPlausibleTables", () => {
  test("a real catalog passes", () => {
    expect(() =>
      assertPlausibleTables([stat("messages", 21_000, 74_000_000), stat("tasks", 900, 8_192)]),
    ).not.toThrow();
  });

  test("every table at zero bytes is the broken-read signature, not an empty database", () => {
    expect(() =>
      assertPlausibleTables([stat("messages", -1, 0), stat("tasks", -1, 0)]),
    ).toThrow("every table as zero bytes");
    expect(() => assertPlausibleTables([])).toThrow("every table as zero bytes");
  });

  test("one table with bytes is enough: genuinely small tables may read zero", () => {
    expect(() =>
      assertPlausibleTables([stat("messages", 21_000, 74_000_000), stat("fresh", -1, 0)]),
    ).not.toThrow();
  });
});
