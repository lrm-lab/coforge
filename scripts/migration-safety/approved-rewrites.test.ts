import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { split } from "./annotation";
import { approvedRewrite } from "./approved-rewrites";
import { analyze, judge } from "./rules";
import { catalogOf } from "./snapshot";

const DROP = "20261118150000_task_thread_duplicate_notices_drop";
const dropFile = new URL(`../../apps/web/prisma/migrations/${DROP}/migration.sql`, import.meta.url)
  .pathname;
const dropBody = split(readFileSync(dropFile, "utf8")).body;
const large = catalogOf({
  tables: [
    { schema: "public", name: "messages", approxRows: 20_000, totalBytes: 101 * 1024 * 1024 },
  ],
});
const DELETE = `DELETE FROM "messages" WHERE "id" = '00000000-0000-0000-0000-000000000000';\n`;

describe("approved rewrites", () => {
  test("an approved migration is approved only with the body that was approved", () => {
    expect(approvedRewrite(dropFile, dropBody)).toBe(true);
    expect(approvedRewrite(dropFile, `${dropBody}\nSELECT 1;\n`)).toBe(false);
  });

  test("any other migration is not approved, whatever its body", () => {
    const other = dropFile.replace(DROP, "20261118150001_other");
    expect(approvedRewrite(other, dropBody)).toBe(false);
  });

  test("an approved rewrite is judged as its locks alone, and still says it rewrites", () => {
    const refused = judge(analyze(DELETE), large, new Set());
    const approved = judge(analyze(DELETE), large, new Set(), true);
    expect(refused.verdict).toBe("rewrite");
    expect(approved.verdict).toBe("ok");
    expect(approved.lines).toEqual(refused.lines);
    expect(approved.lines.every((line) => line.rewrite)).toBe(true);
  });
});
