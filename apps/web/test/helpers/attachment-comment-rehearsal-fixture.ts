import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { legacyDiscussion } from "./attachment-comment-migration-fixture";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** An empty copy of the real migrated tables, checks, indexes and FK actions. */
export async function attachmentCommentRehearsalFixture() {
  const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_TEST_DATABASE_URL is required");
  const schema = `attachment_rehearsal_${crypto.randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString, max: 1 });
  const sql = await pool.connect();
  const db = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString, options: `-c search_path=${schema},public` },
      { schema },
    ),
  });
  let created = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await db.$disconnect();
    } finally {
      try {
        if (created) await sql.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
      } finally {
        sql.release();
        await pool.end();
      }
    }
  };
  try {
    const {
      rows: [scope],
    } = await sql.query<{ database: string; schema: string }>(
      "SELECT current_database() AS database, current_schema() AS schema",
    );
    if (!scope) throw new Error("Missing fixture source schema");
    const { rows: defaults } = await sql.query(
      `
      SELECT 1 FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND pg_get_expr(d.adbin, d.adrelid) LIKE '%nextval(%'`,
      [scope.schema],
    );
    if (defaults.length) throw new Error("Fixture cannot share stateful sequence defaults");
    const { rows: tables } = await sql.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY tablename`,
      [scope.schema],
    );
    if (!tables.some((row) => row.name === "attachment_comment_threads"))
      throw new Error("Missing migrated fixture tables");
    await sql.query(`CREATE SCHEMA ${quote(schema)}`);
    created = true;
    for (const table of tables) {
      await sql.query(
        `CREATE TABLE ${quote(schema)}.${quote(table.name)} (LIKE ${quote(scope.schema)}.${quote(table.name)} INCLUDING ALL)`,
      );
    }
    const { rows: keys } = await sql.query<{
      table: string;
      name: string;
      definition: string;
      targetSchema: string;
    }>(
      `
      SELECT child.relname AS "table", fk.conname AS name, pg_get_constraintdef(fk.oid) AS definition,
        pn.nspname AS "targetSchema"
      FROM pg_constraint fk JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace cn ON cn.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = fk.confrelid JOIN pg_namespace pn ON pn.oid = parent.relnamespace
      WHERE fk.contype = 'f' AND cn.nspname = $1 ORDER BY child.relname, fk.conname`,
      [scope.schema],
    );
    await sql.query(`SET search_path TO ${quote(schema)}, public`);
    for (const key of keys) {
      if (key.targetSchema !== scope.schema)
        throw new Error("Fixture cannot reference a different source schema");
      const definition = key.definition
        .replaceAll(`${quote(scope.schema)}.`, `${quote(schema)}.`)
        .replaceAll(`REFERENCES ${scope.schema}.`, `REFERENCES ${quote(schema)}.`);
      await sql.query(
        `ALTER TABLE ${quote(schema)}.${quote(key.table)} ADD CONSTRAINT ${quote(key.name)} ${definition}`,
      );
    }
    const { rows: escaped } = await sql.query(
      `
      SELECT 1 FROM pg_constraint fk JOIN pg_class c ON c.oid = fk.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class p ON p.oid = fk.confrelid
      JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE fk.contype = 'f' AND n.nspname = $1 AND pn.nspname <> $1`,
      [schema],
    );
    if (escaped.length) throw new Error("Copied foreign key escaped its isolated schema");
    const fixture = await legacyDiscussion({ db, localCopy: { database: scope.database, schema } });
    const inventory = async () => {
      const data: Record<string, unknown[]> = {};
      for (const table of tables) {
        const rows = await db.$queryRaw<{ value: unknown }[]>(Prisma.sql`
          SELECT to_jsonb(t) AS value FROM ${Prisma.raw(quote(schema))}.${Prisma.raw(quote(table.name))} t ORDER BY to_jsonb(t)::text
        `);
        data[table.name] = rows.map((row) => row.value);
      }
      const constraints = await db.$queryRaw`
        SELECT c.relname::text AS "table", fk.conname::text AS name, pg_get_constraintdef(fk.oid) AS definition,
          fk.condeferrable, fk.condeferred, fk.convalidated
        FROM pg_constraint fk JOIN pg_class c ON c.oid = fk.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() ORDER BY c.relname, fk.conname
      `;
      const indexes =
        await db.$queryRaw`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`;
      return { data, constraints, indexes };
    };
    return { ...fixture, schema, inventory, close };
  } catch (error) {
    await close();
    throw error;
  }
}
