import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { Pool } from "pg";
import { dropScratchDatabase } from "./helpers/drop-scratch-database";

/**
 * The task #484 backfill: a Task that followed its channel's Project is copied onto the Task
 * itself; a pinned one keeps its own; a channel with no Project changes nothing.
 * `MIGRATION_TEST_DATABASE_URL` must point at local PostgreSQL whose role can create databases.
 */
const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const target = migrations.indexOf("20261105000300_task_project_backfill");

test.skipIf(!connectionString)(
  "a following Task is filed under its channel's Project, a pinned one keeps its own",
  async () => {
    const admin = new Pool({ connectionString });
    const database = `taskproj_${crypto.randomUUID().replaceAll("-", "")}`;
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
      const [workspace, alpha, beta, channel, plainChannel, member, member2, user] = Array.from(
        { length: 8 },
        () => crypto.randomUUID(),
      );
      await pool.query(
        `INSERT INTO workspaces (id, slug, name, "createdAt", "updatedAt") VALUES ($1, 'w', 'W', now(), now())`,
        [workspace],
      );
      await pool.query(
        `INSERT INTO users (id, username, "displayName", "createdAt") VALUES ($1, 'u', 'U', now())`,
        [user],
      );
      await pool.query(
        `INSERT INTO workspace_memberships ("workspaceId", "userId", role) VALUES ($1, $2, 'member')`,
        [workspace, user],
      );
      await pool.query(
        `INSERT INTO projects (id, "workspaceId", name, slug, "createdAt", "updatedAt") VALUES ($1, $2, 'Alpha', 'a', now(), now()), ($3, $2, 'Beta', 'b', now(), now())`,
        [alpha, workspace, beta],
      );
      await pool.query(
        `INSERT INTO conversations (id, "workspaceId", "channelName", "projectId") VALUES ($1, $2, 'c', $3), ($4, $2, 'p', NULL)`,
        [channel, workspace, alpha, plainChannel],
      );
      await pool.query(
        `INSERT INTO conversation_members (id, "conversationId", "workspaceId", "userId")
           VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)`,
        [member, channel, workspace, user, member2, plainChannel],
      );
      const [followed, pinned, elsewhere] = Array.from({ length: 3 }, () => crypto.randomUUID());
      await pool.query(
        `INSERT INTO tasks (id, "workspaceId", "conversationId", number, title, status, "projectId", "projectPinned", "creatorMemberId", "createdAt", "updatedAt")
         VALUES ($2, $1, $5, 1, 'followed', 'todo', NULL, false, $8, now(), now()),
                ($3, $1, $5, 2, 'pinned', 'todo', $6, true, $8, now(), now()),
                ($4, $1, $7, 1, 'elsewhere', 'todo', NULL, false, $9, now(), now());`,
        [workspace, followed, pinned, elsewhere, channel, beta, plainChannel, member, member2],
      );
      await apply([migrations[target]!]);
      const rows = await pool.query(
        `SELECT id, "projectId" FROM tasks WHERE "workspaceId" = $1 ORDER BY id`,
        [workspace],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row.projectId]));
      expect(byId.get(followed)).toBe(alpha);
      expect(byId.get(pinned)).toBe(beta);
      expect(byId.get(elsewhere)).toBeNull();
    } finally {
      await pool.end();
      await dropScratchDatabase(admin, database);
    }
  },
);
