// Reads table sizes and the applied migrations from a live database, with Bun's built-in client
// (the migrate image holds the Prisma CLI and Bun, nothing else). Only pg_class sizes leave the
// database: no row, column value or connection string.
import { SQL } from "bun";
import type { Snapshot, TableStat } from "./snapshot";

export type CatalogSource = {
  /** Migrations `_prisma_migrations` records as finished; none when the table does not exist yet. */
  applied(): Promise<string[]>;
  tables(): Promise<TableStat[]>;
  close(): Promise<void>;
};

export function liveSource(url: string): CatalogSource {
  const sql = new SQL(url, { max: 1 });
  return {
    async applied() {
      const [{ present }] =
        await sql`SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present`;
      if (!present) return [];
      const rows =
        await sql`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      return rows.map((row: { migration_name: string }) => row.migration_name);
    },
    async tables() {
      // relkind r and p: ordinary and partitioned tables. reltuples is -1 until the first ANALYZE.
      // A partitioned parent holds no data and reports 0 bytes and -1 rows: it is the sum of its
      // leaf partitions (rows -1 when none has been analysed).
      const rows = await sql`
        SELECT n.nspname AS schema, c.relname AS name, s.rows, s.bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL (
          SELECT CASE WHEN bool_or(l.reltuples >= 0) THEN sum(greatest(l.reltuples, 0)) ELSE -1 END::bigint AS rows,
                 sum(pg_total_relation_size(l.oid))::bigint AS bytes
          FROM pg_partition_tree(c.oid) t JOIN pg_class l ON l.oid = t.relid
          WHERE t.isleaf
        ) s
        WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname, c.relname`;
      return rows.map(
        (row: {
          schema: string;
          name: string;
          rows: string | number | bigint;
          bytes: string | number | bigint;
        }) => ({
          schema: row.schema,
          name: row.name,
          approxRows: Number(row.rows),
          totalBytes: Number(row.bytes),
        }),
      );
    },
    close: () => sql.close(),
  };
}

export async function liveSnapshot(url: string, environment: string, now: Date): Promise<Snapshot> {
  const source = liveSource(url);
  try {
    return {
      version: 1,
      generatedAt: now.toISOString(),
      environment,
      tables: await source.tables(),
    };
  } finally {
    await source.close();
  }
}
