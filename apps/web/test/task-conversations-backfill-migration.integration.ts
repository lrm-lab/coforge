import { afterAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("MIGRATION_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const pool = new Pool({ connectionString });

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
const migrationName = (await readdir(migrationsDirectory)).find((name) =>
  name.endsWith("_task_conversations_backfill"),
);
const migration = migrationName
  ? await Bun.file(new URL(`${migrationName}/migration.sql`, migrationsDirectory)).text()
  : "";

afterAll(async () => {
  await pool.end();
});

async function withSchema(run: (client: PoolClient) => Promise<void>) {
  const schema = `tcb_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(
      `CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspaceId" uuid NOT NULL, kind text, "channelName" text, description text NOT NULL DEFAULT '', "createdAt" timestamp NOT NULL DEFAULT now())`,
    );
    await client.query(
      `CREATE TABLE tasks (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "deletedAt" timestamp, "discussionConversationId" uuid UNIQUE REFERENCES conversations(id))`,
    );
    await run(client);
  } finally {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    client.release();
  }
}

const addTask = async (
  client: PoolClient,
  workspaceId: string,
  options: { linked?: boolean; deleted?: boolean } = {},
) => {
  const id = crypto.randomUUID();
  let conversationId: string | null = null;
  if (options.linked) {
    conversationId = crypto.randomUUID();
    await client.query(
      `INSERT INTO conversations (id, "workspaceId", kind) VALUES ($1, $2, 'task_thread')`,
      [conversationId, workspaceId],
    );
  }
  await client.query(
    `INSERT INTO tasks (id, "workspaceId", "deletedAt", "discussionConversationId") VALUES ($1, $2, $3, $4)`,
    [id, workspaceId, options.deleted ? new Date() : null, conversationId],
  );
  return { id, conversationId };
};

test("the backfill migration exists", () => {
  expect(migrationName).toBeDefined();
});

test(
  "every task without a conversation gets its own, linked once, in its workspace",
  async () =>
    withSchema(async (client) => {
      const workspaceA = crypto.randomUUID();
      const workspaceB = crypto.randomUUID();
      const linked = await addTask(client, workspaceA, { linked: true });
      const bare = await addTask(client, workspaceA);
      const other = await addTask(client, workspaceB);
      const deleted = await addTask(client, workspaceB, { deleted: true });
      await client.query(migration);

      const rows = await client.query<{
        id: string;
        discussionConversationId: string;
        workspaceId: string;
        kind: string;
        conversationWorkspace: string;
      }>(
        `SELECT t.id, t."discussionConversationId", t."workspaceId", c.kind, c."workspaceId" AS "conversationWorkspace"
         FROM tasks t JOIN conversations c ON c.id = t."discussionConversationId"`,
      );
      expect(rows.rows).toHaveLength(4);
      for (const row of rows.rows) {
        expect(row.kind).toBe("task_thread");
        expect(row.conversationWorkspace).toBe(row.workspaceId);
      }
      const byTask = new Map(rows.rows.map((row) => [row.id, row.discussionConversationId]));
      expect(byTask.get(linked.id)).toBe(linked.conversationId!);
      expect(new Set(byTask.values()).size).toBe(4);
      for (const task of [bare, other, deleted]) expect(byTask.get(task.id)).toBeString();
      expect((await client.query(`SELECT 1 FROM conversations`)).rowCount).toBe(4);
    }),
  30_000,
);

test(
  "running it again changes nothing",
  async () =>
    withSchema(async (client) => {
      const workspace = crypto.randomUUID();
      await addTask(client, workspace);
      await addTask(client, workspace, { deleted: true });
      await client.query(migration);
      const first = await client.query(
        `SELECT id, "discussionConversationId" FROM tasks ORDER BY id`,
      );
      await client.query(migration);
      const second = await client.query(
        `SELECT id, "discussionConversationId" FROM tasks ORDER BY id`,
      );
      expect(second.rows).toEqual(first.rows);
      expect((await client.query(`SELECT 1 FROM conversations`)).rowCount).toBe(2);
    }),
  30_000,
);

test(
  "with no task to fill it writes nothing",
  async () =>
    withSchema(async (client) => {
      await client.query(migration);
      expect((await client.query(`SELECT 1 FROM conversations`)).rowCount).toBe(0);
    }),
  30_000,
);
