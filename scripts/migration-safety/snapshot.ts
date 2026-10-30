// The catalog snapshot: table sizes only (no business data, no connection strings), written on the
// deploy host by catalog-snapshot.ts and read by every consumer of the safety check.
import { existsSync, readFileSync } from "node:fs";
import { normalizeName } from "./effects";

export type TableStat = { schema: string; name: string; approxRows: number; totalBytes: number };
export type Snapshot = {
  version: 1;
  generatedAt: string;
  environment: string;
  tables: TableStat[];
};

/** A table at or above either bound is large: statements that lock or scan it must be rewritten. */
export const LARGE_ROWS = 100_000;
export const LARGE_BYTES = 64 * 1024 * 1024;
/** A snapshot older than this is not evidence of what the tables hold now. */
export const MAX_SNAPSHOT_AGE_DAYS = 14;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseSnapshot(text: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the catalog snapshot is not valid JSON");
  }
  if (!isRecord(value) || value.version !== 1)
    throw new Error("the catalog snapshot is not version 1");
  const { generatedAt, environment, tables } = value;
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt)))
    throw new Error("the catalog snapshot has no valid generatedAt");
  if (typeof environment !== "string" || !/^[a-z][a-z0-9-]*$/.test(environment))
    throw new Error("the catalog snapshot has no valid environment");
  if (!Array.isArray(tables)) throw new Error("the catalog snapshot has no tables list");
  for (const table of tables)
    if (
      !isRecord(table) ||
      typeof table.schema !== "string" ||
      typeof table.name !== "string" ||
      typeof table.approxRows !== "number" ||
      typeof table.totalBytes !== "number"
    )
      throw new Error("the catalog snapshot has a malformed table entry");
  return {
    version: 1,
    generatedAt,
    environment,
    tables: tables as TableStat[],
  };
}

/** The tables by the name a statement uses for them (`public.` dropped; see normalizeName). */
export type Catalog = Map<string, TableStat>;

export function catalogOf(snapshot: Pick<Snapshot, "tables">): Catalog {
  const catalog: Catalog = new Map();
  for (const table of snapshot.tables) {
    const schema = { kind: "ident" as const, text: table.schema, line: 0 };
    const name = { kind: "ident" as const, text: table.name, line: 0 };
    catalog.set(normalizeName([schema, name]), table);
  }
  return catalog;
}

/** Large by estimated rows or by size. A table never analysed (reltuples -1) has no row estimate:
 * its size alone decides. */
export const isLarge = (stat: Pick<TableStat, "approxRows" | "totalBytes">): boolean =>
  stat.approxRows >= LARGE_ROWS || stat.totalBytes >= LARGE_BYTES;

export function snapshotAgeDays(snapshot: Snapshot, now: Date): number {
  return (now.getTime() - Date.parse(snapshot.generatedAt)) / 86_400_000;
}

/** The snapshot file at `path`, or undefined when there is none or it cannot be read (said on stderr). */
export function loadSnapshot(path: string | undefined): Snapshot | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return parseSnapshot(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`migration-safety: ${(error as Error).message}`);
    return undefined;
  }
}
