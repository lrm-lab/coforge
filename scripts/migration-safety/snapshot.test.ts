import { describe, expect, test } from "bun:test";
import { assertPlausibleTables, parseSnapshot, type TableStat } from "./snapshot";

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
    expect(() => assertPlausibleTables([stat("messages", -1, 0), stat("tasks", -1, 0)])).toThrow(
      "every table as zero bytes",
    );
    expect(() => assertPlausibleTables([])).toThrow("every table as zero bytes");
  });

  test("one table with bytes is enough: genuinely small tables may read zero", () => {
    expect(() =>
      assertPlausibleTables([stat("messages", 21_000, 74_000_000), stat("fresh", -1, 0)]),
    ).not.toThrow();
  });
});

const snapshotJson = (tables: TableStat[]) =>
  JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    environment: "production",
    tables,
  });

describe("parseSnapshot plausibility", () => {
  test("an all-zero snapshot is refused when read", () => {
    expect(() =>
      parseSnapshot(snapshotJson([stat("messages", -1, 0), stat("tasks", -1, 0)])),
    ).toThrow("every table as zero bytes");
  });

  test("a known data table at zero bytes is refused even when the rest look real", () => {
    for (const name of ["messages", "agent_activities"])
      expect(() =>
        parseSnapshot(snapshotJson([stat(name, -1, 0), stat("tasks", 900, 8_192)])),
      ).toThrow(`${name} as zero bytes`);
  });

  test("a plausible snapshot parses; small nonzero data tables are fine", () => {
    const snapshot = parseSnapshot(
      snapshotJson([
        stat("messages", 21_000, 74_000_000),
        stat("agent_activities", 860_000, 90_000_000),
        stat("tasks", 783, 8_192),
      ]),
    );
    expect(snapshot.tables).toHaveLength(3);
    expect(() =>
      parseSnapshot(snapshotJson([stat("messages", 3, 8_192), stat("tasks", 900, 8_192)])),
    ).not.toThrow();
  });
});
