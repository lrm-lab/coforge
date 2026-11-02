import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { isSystemNotice } from "#src/server/conversations/system-notices.server";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationName = (await readdir(migrationsDirectory)).find((name) =>
  name.endsWith("_system_messages_backfill"),
);
const migration = migrationName
  ? await Bun.file(new URL(`${migrationName}/migration.sql`, migrationsDirectory)).text()
  : "";
const readMigration = async (suffix: string) => {
  const name = (await readdir(migrationsDirectory)).find((entry) => entry.endsWith(suffix));
  return name ? await Bun.file(new URL(`${name}/migration.sql`, migrationsDirectory)).text() : "";
};
const helperPerson = await readMigration("_helper_person");
const helperTask = await readMigration("_helper_task");
const helperDrop = await readMigration("_helper_drop");
const paramsMigration = await readMigration("_backfill_params");

afterAll(async () => {
  await pool?.end();
});

const SYSTEM_ROWS: Array<[string, string, string]> = [
  ['📋 1 new task created: #4 "Fix login"', "task.created", "task.created"],
  ['📋 Ada converted a message to task #4 "Fix login"', "task.converted", "task.converted"],
  ["📋 Ada made task #4 from this message", "task.from_message", "task.from_message"],
  ['📌 Ada assigned #4 "Fix login" to @bob', "task.assigned", "task.assigned"],
  ['📌 Assigned @coforge-anvil to task #215 "Old wording"', "task.assigned", "task.assigned"],
  ['📌 bob claimed #4 "Fix login"', "task.claimed", "task.claimed"],
  ['🔄 Ada moved #4 "Fix login" to In Progress', "task.moved", "task.moved"],
  ['🔓 Ada unassigned #4 "Fix login"', "task.unassigned", "task.unassigned"],
  ["@bob assigned you task #4: Fix login", "task.assigned_you", "task.assigned_you"],
  ["Ada stopped following this task: done", "task.unfollowed", "task.unfollowed"],
  [
    "Ada made @bot the coordinator of #team",
    "channel.coordinator_changed",
    "channel.coordinator_changed",
  ],
  [
    "[CoForge coordinator change] #team: coordinator=bot",
    "channel.coordinator_changed",
    "channel.coordinator_changed",
  ],
  [
    "[CoForge paused] These Agents have exchanged too many messages in a row. They can continue after 10 minutes without a message.",
    "agent_dm.chain_limit",
    "agent_dm.chain_limit",
  ],
];

async function withSchema(run: (client: PoolClient) => Promise<void>) {
  const schema = `smb_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool!.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      `CREATE TABLE messages (id uuid PRIMARY KEY, "conversationId" uuid, "workspaceId" uuid, "senderMemberId" uuid, "threadRootId" uuid, body text)`,
    );
    await client.query(
      `CREATE TABLE system_messages ("messageId" uuid PRIMARY KEY, "conversationId" uuid, "workspaceId" uuid, kind text, params jsonb, "createdAt" timestamp NOT NULL DEFAULT now())`,
    );
    await client.query(
      `CREATE TABLE users (id uuid PRIMARY KEY, username text, "displayName" text)`,
    );
    await client.query(`CREATE TABLE agents (id uuid PRIMARY KEY, name text, "displayName" text)`);
    await client.query(
      `CREATE TABLE conversation_members (id uuid PRIMARY KEY, "workspaceId" uuid, "userId" uuid, "agentId" uuid)`,
    );
    await client.query(
      `CREATE TABLE conversations (id uuid PRIMARY KEY, "workspaceId" uuid, "channelName" text)`,
    );
    await client.query(
      `CREATE TABLE tasks (id uuid PRIMARY KEY, "workspaceId" uuid, number int, title text, "messageId" uuid)`,
    );
    await run(client);
  } finally {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    client.release();
  }
}

test("the backfill migration exists and carries its guard", () => {
  expect(migrationName).toBeDefined();
  expect(migration).toMatch(/unclassified > 50/);
  expect(migration).toMatch(/RAISE EXCEPTION/);
});

if (!connectionString) {
  console.warn(
    "system messages backfill migration test not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

test.skipIf(!connectionString)(
  "every known system message format gets its kind, and a row keeps a row",
  async () =>
    withSchema(async (client) => {
      for (const [body] of SYSTEM_ROWS)
        await client.query(
          `INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body)
           VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, $1)`,
          [body],
        );
      await client.query(helperPerson);
      await client.query(helperTask);
      await client.query(migration);
      await client.query(paramsMigration);
      await client.query(helperDrop);
      const rows = await client.query<{ kind: string; count: string }>(
        `SELECT kind, count(*)::text AS count FROM system_messages GROUP BY kind`,
      );
      const kinds = Object.fromEntries(rows.rows.map((row) => [row.kind, Number(row.count)]));
      for (const [, , kind] of SYSTEM_ROWS)
        expect(kinds[kind] ?? 0).toBeGreaterThanOrEqual(
          SYSTEM_ROWS.filter(([, , expected]) => expected === kind).length,
        );
      expect(kinds.unclassified).toBeUndefined();
      const stored = await client.query<{ kind: string; params: unknown }>(
        `SELECT kind, params FROM system_messages`,
      );
      for (const row of stored.rows) expect(isSystemNotice(row), row.kind).toBe(true);
      const missing = await client.query(
        `SELECT count(*)::int AS count FROM messages m
         LEFT JOIN system_messages s ON s."messageId" = m.id
         WHERE m."senderMemberId" IS NULL AND s."messageId" IS NULL`,
      );
      expect(missing.rows[0]!.count).toBe(0);
    }),
  30_000,
);

test.skipIf(!connectionString)(
  "more than 1% unclassified aborts the whole backfill",
  async () =>
    withSchema(async (client) => {
      for (let index = 0; index < 60; index++)
        await client.query(
          `INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body)
           VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, $1)`,
          [`unknown notice ${index}`],
        );
      await client.query(helperPerson);
      await client.query(helperTask);
      await expect(client.query(migration)).rejects.toThrow(/unclassified/);
      const rows = await client.query(`SELECT count(*)::int AS count FROM system_messages`);
      expect(rows.rows[0]!.count).toBe(0);
    }),
  30_000,
);
