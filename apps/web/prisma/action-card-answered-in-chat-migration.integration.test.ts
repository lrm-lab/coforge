import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { Pool } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationName = (await readdir(migrationsDirectory)).find((name) =>
  name.endsWith("_action_card_answered_in_chat_expire"),
);
const migration = migrationName
  ? await Bun.file(new URL(`${migrationName}/migration.sql`, migrationsDirectory)).text()
  : "";

afterAll(async () => {
  await pool?.end();
});

/**
 * Task #624 contract step 1: every row still carrying the `answered_in_chat` state #616 removed is
 * rewritten to `expired` — the state those rows already read as — so the follow-up release can drop
 * the state and its two columns. Other states are untouched.
 */
test("the migration exists and rewrites answered_in_chat to expired", () => {
  expect(migrationName).toBeDefined();
  expect(migration).toMatch(
    /UPDATE "action_cards" SET "state" = 'expired' WHERE "state" = 'answered_in_chat'/,
  );
});

if (!connectionString) {
  console.warn(
    "action card answered-in-chat migration test not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

test.skipIf(!connectionString)(
  "answered_in_chat rows become expired and every other state is kept",
  async () => {
    const schema = `acice_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `CREATE TABLE "action_cards" ("id" TEXT PRIMARY KEY, "state" TEXT NOT NULL)`,
      );
      await client.query(
        `INSERT INTO "action_cards" ("id", "state") VALUES
           ('a1', 'answered_in_chat'),
           ('a2', 'answered_in_chat'),
           ('a3', 'answered_in_chat'),
           ('p1', 'pending'),
           ('e1', 'executed'),
           ('c1', 'cancelled'),
           ('x1', 'expired')`,
      );

      await client.query(migration);

      const rows = await client.query(`SELECT "id", "state" FROM "action_cards" ORDER BY "id"`);
      expect(rows.rows).toEqual([
        { id: "a1", state: "expired" },
        { id: "a2", state: "expired" },
        { id: "a3", state: "expired" },
        { id: "c1", state: "cancelled" },
        { id: "e1", state: "executed" },
        { id: "p1", state: "pending" },
        { id: "x1", state: "expired" },
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
