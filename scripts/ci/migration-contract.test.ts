import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractDrops,
  findContractViolationsInSnapshot,
  MIGRATION_CONTRACT_FIX,
  resolveContractBaseline,
} from "./migration-contract";
import { runSchemaHistoryDiff } from "../migration-safety/check-schema-history";

const PRISMA_MODELS = new Map([
  [
    "apps/web/prisma/models/users.prisma",
    `
model UserPreference {
  id                   String @id
  conversationOpenMode String @default("split") @map("conversation_open_mode")

  @@unique([id], map: "user_preferences_id_uniq")
  @@map("user_preferences")
}
`,
  ],
]);

describe("migration-contract hard rule (#37)", () => {
  test("extractDrops parses DROP TABLE, DROP COLUMN, and DROP CONSTRAINT", () => {
    const sql = `
      ALTER TABLE "public"."user_preferences" DROP COLUMN IF EXISTS "conversation_open_mode", DROP CONSTRAINT "user_preferences_id_uniq";
      DROP TABLE IF EXISTS "legacy_sessions";
    `;
    expect(extractDrops(sql)).toEqual([
      { kind: "column", table: "user_preferences", column: "conversation_open_mode", line: 2 },
      {
        kind: "constraint",
        table: "user_preferences",
        constraint: "user_preferences_id_uniq",
        line: 2,
      },
      { kind: "table", table: "legacy_sessions", line: 3 },
    ]);
  });

  test("extractDrops ignores ALTER COLUMN ... DROP DEFAULT / NOT NULL / EXPRESSION / IDENTITY", () => {
    const sql = `
      ALTER TABLE "tasks" ALTER COLUMN "dueAt" DROP DEFAULT;
      ALTER TABLE "tasks" ALTER COLUMN "dueAt" DROP NOT NULL;
      ALTER TABLE "tasks" ALTER COLUMN "computed" DROP EXPRESSION;
      ALTER TABLE "tasks" ALTER COLUMN "seq" DROP IDENTITY IF EXISTS;
    `;
    expect(extractDrops(sql)).toEqual([]);
  });

  test("rejects DROP COLUMN / DROP TABLE / DROP CONSTRAINT when base or current schema/code still references them", () => {
    const drops = [
      {
        file: "apps/web/prisma/migrations/20261118120000_drop_open_mode/migration.sql",
        drop: {
          kind: "column" as const,
          table: "user_preferences",
          column: "conversation_open_mode",
          line: 1,
        },
      },
      {
        file: "apps/web/prisma/migrations/20261118120001_drop_uniq/migration.sql",
        drop: {
          kind: "constraint" as const,
          table: "user_preferences",
          constraint: "user_preferences_id_uniq",
          line: 1,
        },
      },
    ];

    const schemaViolations = findContractViolationsInSnapshot(
      drops,
      "base (origin/main)",
      PRISMA_MODELS,
      new Map(),
    );
    expect(schemaViolations).toHaveLength(2);
    expect(schemaViolations[0]!.found).toContain("UserPreference.conversationOpenMode");
    expect(schemaViolations[1]!.found).toContain("user_preferences_id_uniq");
    expect(MIGRATION_CONTRACT_FIX).toContain("拆到下一个版本");

    const codeViolations = findContractViolationsInSnapshot(
      [
        {
          file: "apps/web/prisma/migrations/20261118120002_drop_table/migration.sql",
          drop: { kind: "table", table: "legacy_sessions", line: 1 },
        },
      ],
      "base (origin/main)",
      new Map(),
      new Map([
        [
          "apps/web/src/server/legacy.server.ts",
          `await db.$queryRaw\`SELECT * FROM "legacy_sessions"\`;`,
        ],
      ]),
    );
    expect(codeViolations).toHaveLength(1);
    expect(codeViolations[0]!.found).toContain("legacy.server.ts");
  });

  test("passes a compliant DROP migration when neither base nor current schema/code references the dropped object", () => {
    const emptySchema = new Map([
      [
        "apps/web/prisma/models/users.prisma",
        `
model UserPreference {
  id String @id
  @@map("user_preferences")
}
`,
      ],
    ]);
    const violations = findContractViolationsInSnapshot(
      [
        {
          file: "apps/web/prisma/migrations/20261118120000_drop_open_mode/migration.sql",
          drop: {
            kind: "column",
            table: "user_preferences",
            column: "conversation_open_mode",
            line: 1,
          },
        },
        {
          file: "apps/web/prisma/migrations/20261118120001_drop_legacy/migration.sql",
          drop: { kind: "table", table: "legacy_sessions", line: 1 },
        },
      ],
      "base (origin/main)",
      emptySchema,
      new Map([
        [
          "apps/web/src/server/prefs.server.ts",
          `return db.userPreference.findUnique({ where: { id } });`,
        ],
      ]),
    );
    expect(violations).toEqual([]);
  });

  test("runSchemaHistoryDiff reports missing database URL cleanly", async () => {
    const res = await runSchemaHistoryDiff({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain("SHADOW_DATABASE_URL");
  });

  test("resolveContractBaseline prefers refs/tags/web-production over range base and falls back when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "migration-contract-base-"));
    try {
      const run = (args: string[]) =>
        Bun.spawnSync(["git", ...args], {
          cwd: dir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          },
        });
      run(["init"]);
      writeFileSync(join(dir, "a.txt"), "v1\n");
      run(["add", "a.txt"]);
      run(["commit", "-m", "v1"]);
      const firstSha = run(["rev-parse", "HEAD"]).stdout.toString().trim();

      writeFileSync(join(dir, "a.txt"), "v2\n");
      run(["add", "a.txt"]);
      run(["commit", "-m", "v2"]);
      const secondSha = run(["rev-parse", "HEAD"]).stdout.toString().trim();

      const withoutTag = resolveContractBaseline(
        { kind: "range", base: secondSha, head: secondSha },
        dir,
        false,
      );
      expect(withoutTag.revision).toBe(secondSha);

      run(["tag", "web-production", firstSha]);
      const withTag = resolveContractBaseline(
        { kind: "range", base: secondSha, head: secondSha },
        dir,
        false,
      );
      expect(withTag.revision).toBe("refs/tags/web-production");
      expect(withTag.label).toBe("production (web-production)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
