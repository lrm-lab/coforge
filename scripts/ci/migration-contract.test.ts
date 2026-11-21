import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function checkOpenModeDrop(
  field: string,
  snapshot: "production" | "fallback" | "current",
  source = "",
) {
  const prisma = `
model UserPreference {
  id String @id
  conversationOpenMode String ${field}
  @@map("user_preferences")
}
`;
  return findContractViolationsInSnapshot(
    extractDrops('ALTER TABLE "user_preferences" DROP COLUMN "conversation_open_mode";').map(
      (drop) => ({ file: "migration.sql", drop }),
    ),
    snapshot,
    new Map([["users.prisma", prisma]]),
    new Map([["prefs.server.ts", source]]),
    { allowIgnoredFields: snapshot === "production" },
  );
}

describe("migration-contract hard rule (#37)", () => {
  test("only the tagged production snapshot tolerates a genuinely ignored field", () => {
    const field = '@map("conversation_open_mode") @ignore';
    expect(
      checkOpenModeDrop(field, "production", "db.userPreference.findUnique({ where: { id } })"),
    ).toEqual([]);
    expect(checkOpenModeDrop(field, "fallback")[0]?.found).toContain("still maps");
    expect(checkOpenModeDrop(field, "current")[0]?.found).toContain("still maps");
    expect(
      checkOpenModeDrop(
        '@default("https://example.test/ignored") @ignore @map("conversation_open_mode")',
        "production",
      ),
    ).toEqual([]);
  });

  test("production rejects active mappings when @ignore is only in a literal or comment", () => {
    const fields = [
      '@map("conversation_open_mode")',
      '@map("conversation_open_mode") @default("@ignore")',
      '@map("conversation_open_mode") @default("before \\" @ignore")',
      '@map("conversation_open_mode") // @ignore',
    ];
    for (const field of fields) {
      expect(checkOpenModeDrop(field, "production")[0]?.found).toContain("still maps");
    }
  });

  test("production source references block ignored column drops through Prisma names and raw SQL", () => {
    const sources = [
      "db.userPreference.findUnique({ select: { conversationOpenMode: true } })",
      'db.$queryRaw`SELECT p."conversation_open_mode" FROM "user_preferences" AS p`',
      "db.$queryRaw`SELECT p.conversation_open_mode FROM user_preferences AS p`",
      "db.$queryRaw`SELECT p.CONVERSATION_OPEN_MODE FROM USER_PREFERENCES AS p`",
    ];
    for (const source of sources) {
      expect(
        checkOpenModeDrop('@ignore @map("conversation_open_mode")', "production", source)[0]?.found,
      ).toContain("code (prefs.server.ts) still references it");
    }
  });

  test("the production allowance leaves table and constraint checks in force", () => {
    const drops = extractDrops(
      'ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_id_uniq"; DROP TABLE "user_preferences";',
    ).map((drop) => ({ file: "migration.sql", drop }));
    const violations = findContractViolationsInSnapshot(
      drops,
      "production",
      PRISMA_MODELS,
      new Map(),
      { allowIgnoredFields: true },
    );
    expect(violations.map(({ found }) => found)).toEqual([
      expect.stringContaining("Prisma schema still declares it"),
      expect.stringContaining("Prisma model UserPreference still maps to it"),
    ]);
  });

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

  test("only a freshly fetched production tag allows an ignored field through the migration gate", () => {
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
      const schemaPath = "apps/web/prisma/models/users.prisma";
      const migrationDir = "apps/web/prisma/migrations/20261121120000_drop_open_mode";
      mkdirSync(join(dir, "apps/web/prisma/models"), { recursive: true });
      writeFileSync(
        join(dir, schemaPath),
        PRISMA_MODELS.get(schemaPath)!.replace('@default("split")', "@ignore"),
      );
      run(["add", schemaPath]);
      run(["commit", "-m", "v1"]);
      const firstSha = run(["rev-parse", "HEAD"]).stdout.toString().trim();

      writeFileSync(join(dir, "a.txt"), "v2\n");
      run(["add", "a.txt"]);
      run(["commit", "-m", "v2"]);
      const secondSha = run(["rev-parse", "HEAD"]).stdout.toString().trim();

      mkdirSync(join(dir, migrationDir), { recursive: true });
      writeFileSync(
        join(dir, migrationDir, "migration.sql"),
        'ALTER TABLE "user_preferences" DROP COLUMN "conversation_open_mode";\n',
      );
      writeFileSync(
        join(dir, schemaPath),
        PRISMA_MODELS.get(schemaPath)!.replace(/.*conversationOpenMode.*\n/, ""),
      );
      expect(run(["add", "apps"]).exitCode).toBe(0);

      const checkStagedMigration = () => {
        const result = Bun.spawnSync(
          [
            process.execPath,
            "--eval",
            `import { migrationContractViolations } from ${JSON.stringify(
              join(import.meta.dir, "migration-contract.ts"),
            )};
             console.log(JSON.stringify(migrationContractViolations({ kind: "staged" })));`,
          ],
          { cwd: dir },
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
      };

      expect(checkStagedMigration()[0]?.found).toContain("base (HEAD) Prisma model");
      expect(run(["tag", "web-production", firstSha]).exitCode).toBe(0);
      expect(checkStagedMigration()[0]?.found).toContain(
        "production (web-production) Prisma model",
      );

      expect(run(["init", "--bare", "remote.git"]).exitCode).toBe(0);
      expect(run(["push", "./remote.git", `${secondSha}:refs/tags/web-production`]).exitCode).toBe(
        0,
      );
      expect(run(["remote", "add", "origin", "./remote.git"]).exitCode).toBe(0);
      expect(checkStagedMigration()).toEqual([]);
      expect(resolveContractBaseline({ kind: "staged" }, dir).revision).toBe(secondSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
