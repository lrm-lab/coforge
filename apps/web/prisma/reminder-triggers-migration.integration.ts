import { afterAll, expect, test } from "bun:test";
import { Pool } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL");
const pool = new Pool({ connectionString });

const migrationsDirectory = new URL("./migrations/", import.meta.url);
const migrationSql = (name: string) =>
  Bun.file(new URL(`${name}/migration.sql`, migrationsDirectory)).text();

afterAll(async () => {
  await pool.end();
});

test("the migration keeps old reminders and refuses rows outside the kind shape and the trigger limits", async () => {
  const schema = `rt_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      `CREATE TABLE "workspaces" ("id" UUID PRIMARY KEY);
         CREATE TABLE "agents" ("id" UUID NOT NULL, "workspaceId" UUID NOT NULL, PRIMARY KEY ("id"), UNIQUE ("id", "workspaceId"));
         CREATE TABLE "reminders" (
           "id" UUID PRIMARY KEY, "messageId" UUID NOT NULL, "title" TEXT NOT NULL
         )`,
    );
    const oldId = crypto.randomUUID();
    await client.query(`INSERT INTO "reminders" VALUES ($1, $2, 'old')`, [
      oldId,
      crypto.randomUUID(),
    ]);
    await client.query(await migrationSql("20261119130000_reminder_triggers"));
    await client.query(await migrationSql("20261119130100_reminder_triggers_validate"));

    const kinds = await client.query(`SELECT "kind", "triggerKey" FROM "reminders"`);
    expect(kinds.rows).toEqual([{ kind: "scheduled", triggerKey: null }]);

    const insert = (
      kind: string,
      messageId: string | null,
      triggerKey: string | null,
      details: string | null = null,
    ) =>
      client.query(
        `INSERT INTO "reminders" ("id", "messageId", "title", "kind", "triggerKey", "details") VALUES ($1, $2, 't', $3, $4, $5)`,
        [crypto.randomUUID(), messageId, kind, triggerKey, details],
      );
    await insert("trigger", null, "ci.red", "3 jobs failed");
    await insert("scheduled", crypto.randomUUID(), null);
    await expect(insert("scheduled", null, null)).rejects.toThrow(/reminders_kind_shape/);
    await expect(insert("trigger", null, null)).rejects.toThrow(/reminders_kind_shape/);
    await expect(insert("scheduled", crypto.randomUUID(), "ci.red")).rejects.toThrow(
      /reminders_kind_shape/,
    );
    await expect(insert("scheduled", crypto.randomUUID(), null, "x")).rejects.toThrow(
      /reminders_kind_shape/,
    );
    await expect(insert("other", crypto.randomUUID(), null)).rejects.toThrow(
      /reminders_kind_shape/,
    );
    const workspaceId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await client.query(`INSERT INTO "workspaces" VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO "agents" VALUES ($1, $2)`, [agentId, workspaceId]);
    const insertTrigger = (level: string, windowSeconds: number, pending: number) =>
      client.query(
        `INSERT INTO "reminder_triggers" ("id", "workspaceId", "ownerAgentId", "key", "level", "mergeWindowSeconds", "pendingCount", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING "id"`,
        [
          crypto.randomUUID(),
          workspaceId,
          agentId,
          crypto.randomUUID(),
          level,
          windowSeconds,
          pending,
        ],
      );
    const trigger = await insertTrigger("wake", 600, 0);
    await insertTrigger("log", 60, 3);
    await insertTrigger("log", 86400, 0);
    await expect(insertTrigger("loud", 600, 0)).rejects.toThrow(/reminder_triggers_level_check/);
    await expect(insertTrigger("wake", 59, 0)).rejects.toThrow(/reminder_triggers_window_check/);
    await expect(insertTrigger("wake", 86401, 0)).rejects.toThrow(/reminder_triggers_window_check/);
    await expect(insertTrigger("wake", 600, -1)).rejects.toThrow(/reminder_triggers_pending_check/);

    const insertEvent = (level: string, outcome: string) =>
      client.query(
        `INSERT INTO "reminder_trigger_events" ("id", "triggerId", "workspaceId", "ownerAgentId", "level", "outcome", "title", "requestId", "triggerCount", "firstTriggeredAt", "lastTriggeredAt")
         VALUES ($1, $2, $3, $4, $5, $6, 't', $7, 1, now(), now())`,
        [
          crypto.randomUUID(),
          trigger.rows[0].id,
          workspaceId,
          agentId,
          level,
          outcome,
          crypto.randomUUID(),
        ],
      );
    for (const outcome of ["woke", "merged", "recorded", "throttled"])
      await insertEvent("wake", outcome);
    await expect(insertEvent("wake", "dropped")).rejects.toThrow(
      /reminder_trigger_events_outcome_check/,
    );
    await expect(insertEvent("loud", "woke")).rejects.toThrow(
      /reminder_trigger_events_level_check/,
    );
  } finally {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    client.release();
  }
});
