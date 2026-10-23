import { afterAll, expect, test } from "bun:test";
import { Pool } from "pg";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : undefined;
const migration = await Bun.file(
  new URL("./migrations/20261024130000_avatar_cartoon_people/migration.sql", import.meta.url),
).text();

afterAll(async () => {
  await pool?.end();
});

if (!connectionString) {
  console.warn(
    "avatar cartoon people migration test not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

// Frank, 2026-10-24: the thirty portrait photos give way to four cartoon people. Whoever chose
// `preset:portrait-NN` now has `preset:person-((NN - 1) % 4 + 1)`; uploads and people with no
// avatar are untouched.
test.skipIf(!connectionString)(
  "a portrait preset becomes a cartoon person; uploads and no avatar stay as they are",
  async () => {
    const schema = `acp_${crypto.randomUUID().replaceAll("-", "")}`;
    const client = await pool!.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "avatarObjectKey" TEXT)`);
      await client.query(
        `INSERT INTO "users" ("id", "avatarObjectKey") VALUES
           ('p01', 'preset:portrait-01'),
           ('p04', 'preset:portrait-04'),
           ('p05', 'preset:portrait-05'),
           ('p30', 'preset:portrait-30'),
           ('person', 'preset:person-3'),
           ('upload', 'users/u1/avatars/a1/original'),
           ('none', NULL)`,
      );

      await client.query(migration);

      const rows = await client.query(`SELECT "id", "avatarObjectKey" FROM "users" ORDER BY "id"`);
      expect(rows.rows).toEqual([
        { id: "none", avatarObjectKey: null },
        { id: "p01", avatarObjectKey: "preset:person-1" },
        { id: "p04", avatarObjectKey: "preset:person-4" },
        { id: "p05", avatarObjectKey: "preset:person-1" },
        { id: "p30", avatarObjectKey: "preset:person-2" },
        { id: "person", avatarObjectKey: "preset:person-3" },
        { id: "upload", avatarObjectKey: "users/u1/avatars/a1/original" },
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
