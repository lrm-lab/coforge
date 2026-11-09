import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { Pool } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationName = (await readdir(migrationsDirectory)).find((name) =>
  name.endsWith("_cloud_computer_english_names"),
);
const migration = migrationName
  ? await Bun.file(new URL(`${migrationName}/migration.sql`, migrationsDirectory)).text()
  : "";

afterAll(async () => {
  await pool?.end();
});

test("the migration exists", () => {
  expect(migrationName).toBeDefined();
  expect(migration).toMatch(/UPDATE\s+"computers"/);
});

if (!connectionString) {
  console.warn(
    "cloud computer English names migration test not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

/**
 * Existing cloud Computers carry a name built from the owner (a stored nickname or, for older rows,
 * the username) plus a Chinese suffix. The migration renames exactly those generated names, using
 * the current display name, and leaves a name the owner edited and every local Computer alone.
 */
test.skipIf(!connectionString)(
  "renames generated cloud computer names and keeps edited and local ones",
  async () => {
    const schema = `ccen_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `CREATE TABLE "users" (
           "id" TEXT PRIMARY KEY,
           "username" TEXT NOT NULL,
           "displayName" TEXT NOT NULL
         )`,
      );
      await client.query(
        `CREATE TABLE "computers" (
           "id" TEXT PRIMARY KEY,
           "ownerId" TEXT NOT NULL,
           "name" TEXT NOT NULL,
           "displayName" TEXT NOT NULL,
           "kind" TEXT NOT NULL,
           "cloudSlot" TEXT,
           "deletedAt" TIMESTAMP(3)
         )`,
      );
      await client.query(
        `INSERT INTO "users" ("id", "username", "displayName") VALUES
           ('username-named', 'lijian40', '李建'),
           ('display-named', 'ada', 'Ada Lovelace'),
           ('renamed', 'grace', 'Grace Hopper'),
           ('renamed-after', 'old-handle', 'Ada King'),
           ('local-owner', 'frank', 'frank')`,
      );
      await client.query(
        `INSERT INTO "computers"
           ("id", "ownerId", "name", "displayName", "kind", "cloudSlot", "deletedAt") VALUES
           ('old-username-default', 'username-named', 'lijian40的默认云电脑', 'lijian40的默认云电脑', 'cloud', 'default', NULL),
           ('old-username-extra', 'username-named', 'lijian40的新建云电脑', 'lijian40的新建云电脑', 'cloud', 'extra', NULL),
           ('old-display-default', 'display-named', 'Ada Lovelace的默认云电脑', 'Ada Lovelace的默认云电脑', 'cloud', 'default', NULL),
           ('old-nickname-default', 'renamed-after', 'Earlier Name的默认云电脑', 'Earlier Name的默认云电脑', 'cloud', 'default', NULL),
           ('custom-display', 'renamed', 'Grace Hopper的默认云电脑', 'My Grace Box', 'cloud', 'default', NULL),
           ('unrelated', 'renamed', 'Something else', 'Something else', 'cloud', 'default', NULL),
           ('local-one', 'local-owner', 'frank的默认云电脑', 'frank的默认云电脑', 'local', NULL, NULL)`,
      );

      await client.query(migration);

      const rows = await client.query(
        `SELECT "id", "name", "displayName" FROM "computers" ORDER BY "id"`,
      );
      expect(rows.rows).toEqual([
        { id: "custom-display", name: "Grace Hopper的默认云电脑", displayName: "My Grace Box" },
        { id: "local-one", name: "frank的默认云电脑", displayName: "frank的默认云电脑" },
        {
          id: "old-display-default",
          name: "Ada Lovelace's Default Cloud Computer",
          displayName: "Ada Lovelace's Default Cloud Computer",
        },
        {
          id: "old-nickname-default",
          name: "Ada King's Default Cloud Computer",
          displayName: "Ada King's Default Cloud Computer",
        },
        {
          id: "old-username-default",
          name: "李建's Default Cloud Computer",
          displayName: "李建's Default Cloud Computer",
        },
        {
          id: "old-username-extra",
          name: "李建's New Cloud Computer",
          displayName: "李建's New Cloud Computer",
        },
        { id: "unrelated", name: "Something else", displayName: "Something else" },
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
