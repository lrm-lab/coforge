import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { Pool } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationName = (await readdir(migrationsDirectory)).find((name) =>
  name.endsWith("_drop_user_full_name"),
);
const migration = migrationName
  ? await Bun.file(new URL(`${migrationName}/migration.sql`, migrationsDirectory)).text()
  : "";

afterAll(async () => {
  await pool?.end();
});

/**
 * `displayName` becomes the one name a person has. A person who set a nickname keeps it; one who
 * only gave a full name gets that as their name; one with neither (or only blank space) stays
 * unnamed and is asked at their next sign-in. The `fullName` column is gone afterwards.
 */
test("the migration exists and drops the column", () => {
  expect(migrationName).toBeDefined();
  expect(migration).toMatch(/DROP COLUMN\s+"fullName"/);
});

if (!connectionString) {
  console.warn(
    "drop user full name migration test not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

test.skipIf(!connectionString)(
  "a person keeps their nickname, else takes their full name, else stays unnamed",
  async () => {
    const schema = `dufn_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "username" TEXT NOT NULL, "fullName" TEXT, "displayName" TEXT)`,
      );
      await client.query(
        `INSERT INTO "users" ("id", "username", "fullName", "displayName") VALUES
           ('both', 'ada', 'Ada Lovelace', 'Countess'),
           ('fullonly', 'frank', 'Frank An', NULL),
           ('padded', 'grace', '  Grace Hopper  ', NULL),
           ('cjk', 'andong', '安栋', NULL),
           ('blanknick', 'bob', 'Bob Ross', '   '),
           ('emptynick', 'eve', 'Eve Adams', ''),
           ('nickonly', 'dee', NULL, 'Dee'),
           ('blankboth', 'blank', '  ', '   '),
           ('tabblank', 'tabby', E'\\t', E'\\n'),
           ('tabfull', 'tabfull', E'\\tTab Name\\n', NULL),
           ('nlnick', 'nl', 'NL Full', E'\\n '),
           ('unnamed', 'user', NULL, NULL)`,
      );

      await client.query(migration);

      const rows = await client.query(`SELECT * FROM "users" ORDER BY "id"`);
      expect(rows.rows).toEqual([
        { id: "blankboth", username: "blank", displayName: null },
        { id: "blanknick", username: "bob", displayName: "Bob Ross" },
        { id: "both", username: "ada", displayName: "Countess" },
        { id: "cjk", username: "andong", displayName: "安栋" },
        { id: "emptynick", username: "eve", displayName: "Eve Adams" },
        { id: "fullonly", username: "frank", displayName: "Frank An" },
        { id: "nickonly", username: "dee", displayName: "Dee" },
        { id: "nlnick", username: "nl", displayName: "NL Full" },
        { id: "padded", username: "grace", displayName: "Grace Hopper" },
        { id: "tabblank", username: "tabby", displayName: null },
        { id: "tabfull", username: "tabfull", displayName: "Tab Name" },
        { id: "unnamed", username: "user", displayName: null },
      ]);
    } finally {
      client.release();
      const cleanup = await pool!.connect();
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        cleanup.release();
      }
    }
  },
);
