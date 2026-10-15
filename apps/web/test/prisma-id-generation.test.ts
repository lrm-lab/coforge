import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("Prisma id generation uses time-ordered UUIDv7", () => {
  // Task #84 (2026-10-13): every primary key switched from Prisma's default `uuid()` (v4,
  // random) to `uuid(7)`. Random v4 keys cost B-tree locality on every insert — page splits and
  // WAL amplification that grow with the table — while v7 keeps the same guarantees (client-side
  // generation, nothing enumerable, no coordination between writers) and is roughly
  // time-ordered, so inserts touch the right-hand edge of the index like a sequence would.
  // Existing rows stay v4, so ids are ordered only from the switch onward: never use id as a
  // cursor or sort key over historical data. See the PR for the full analysis.
  //
  // The database does not generate ids anywhere: every migration-level `id` DEFAULT
  // gen_random_uuid() was dropped (20260928163000_weekly_report_schema_drift and friends), and
  // all raw-SQL inserts go into the composite-key table thread_reads, which has no id column.
  // This schema default is therefore the single id-generation path; pinning it in text keeps a
  // random v4 from sneaking back in when a new table is added.
  const schema = readFileSync(
    join(fileURLToPath(new URL("..", import.meta.url)), "prisma/schema.prisma"),
    "utf8",
  );

  test("no random v4 defaults remain", () => {
    expect(schema).not.toContain("@default(uuid())");
  });

  // Tables keyed by another row's id (`userId`, `workspaceId`, `messageId`, a key hash) or by a
  // composite `@@id` carry no generated id. Every surrogate `id`, and every other `@id` the schema
  // generates (`deliveryId`), must generate uuid(7).
  test("every generated id is uuid(7)", () => {
    const lines = schema.split("\n");
    const generated = lines.filter(
      (line) => /^\s+id\s+String\s+@id\b/.test(line) || /@id\b.*@default\(/.test(line),
    );
    expect(generated.length).toBe(schema.split("@default(uuid(7))").length - 1);
    expect(generated.filter((line) => !line.includes("@default(uuid(7))"))).toEqual([]);
  });
});
