import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { Pool } from "pg";
import { dropScratchDatabase } from "./helpers/drop-scratch-database";

/**
 * The migration that gives a Task an id of its own: the committed migrations up to it, a legacy
 * Task with its history and an execution session, then the migration itself. Skipped unless
 * `MIGRATION_TEST_DATABASE_URL` points at local PostgreSQL whose role can create databases and
 * switch off foreign-key triggers (`session_replication_role`), so the fixtures need no parents.
 */
const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const target = migrations.indexOf("20261030140000_task_own_id");

test.skipIf(!connectionString)(
  "a Task keeps its old key as its id, and its history and sessions follow",
  async () => {
    const admin = new Pool({ connectionString });
    const database = `taskid_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(connectionString!);
    url.pathname = `/${database}`;
    const pool = new Pool({ connectionString: url.href, max: 1 });
    try {
      expect(target).toBeGreaterThan(0);
      const apply = async (names: readonly string[]) => {
        for (const name of names)
          await pool.query(
            await Bun.file(new URL(`${name}/migration.sql`, migrationsDirectory)).text(),
          );
      };
      await apply(migrations.slice(0, target));
      const [message, conversation, workspace, member, agent] = Array.from({ length: 5 }, () =>
        crypto.randomUUID(),
      );
      await pool.query("SET session_replication_role = replica");
      await pool.query(
        `INSERT INTO tasks ("messageId", "conversationId", "workspaceId", number, title, "creatorMemberId", "updatedAt")
         VALUES ($1, $2, $3, 1, 'legacy', $4, now())`,
        [message, conversation, workspace, member],
      );
      await pool.query(
        `INSERT INTO task_history_events (id, "taskMessageId", seq, "eventType", "actorType", payload)
         VALUES ($1, $2, 1, 'created', 'user', '{}')`,
        [crypto.randomUUID(), message],
      );
      await pool.query(
        `INSERT INTO task_execution_sessions (id, "taskMessageId", "conversationId", "workspaceId", "agentId")
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), message, conversation, workspace, agent],
      );
      await pool.query("SET session_replication_role = DEFAULT");

      await apply(migrations.slice(target, target + 1));

      const tasks = await pool.query(`SELECT id, "messageId" FROM tasks`);
      expect(tasks.rows).toEqual([{ id: message, messageId: message }]);
      const history = await pool.query(`SELECT "taskId" FROM task_history_events`);
      expect(history.rows).toEqual([{ taskId: message }]);
      const sessions = await pool.query(`SELECT "taskId" FROM task_execution_sessions`);
      expect(sessions.rows).toEqual([{ taskId: message }]);

      // A task may now exist without a message; its history follows it when it is deleted.
      const bare = crypto.randomUUID();
      await pool.query("SET session_replication_role = replica");
      await pool.query(
        `INSERT INTO tasks (id, "conversationId", "workspaceId", number, title, "creatorMemberId", "updatedAt")
         VALUES ($1, $2, $3, 2, 'bare', $4, now())`,
        [bare, conversation, workspace, member],
      );
      await pool.query("SET session_replication_role = DEFAULT");
      await pool.query(`DELETE FROM tasks WHERE id = $1`, [message]);
      expect((await pool.query(`SELECT 1 FROM task_history_events`)).rowCount).toBe(0);
    } finally {
      await pool.end();
      await dropScratchDatabase(admin, database);
      await admin.end();
    }
  },
);
