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
  const stats = tables as TableStat[];
  assertPlausibleSnapshot(stats);
  return {
    version: 1,
    generatedAt,
    environment,
    tables: stats,
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

/** Throws when every table reports zero bytes: the signature of a catalog read that returned
 * nothing (a broken query or the wrong database), not of an empty database — a real schema's
 * tables each hold at least their fork files. Such a "snapshot" must not be uploaded or judged:
 * every table would read as small. */
export function assertPlausibleTables(tables: TableStat[]): void {
  if (tables.every((table) => table.totalBytes === 0))
    throw new Error("the catalog reports every table as zero bytes");
}

/** Tables a deployed database is known to hold data in; a zero-byte read of one is the same broken
 * signature as an all-zero catalog, caught even when the other tables look plausible. Checked on
 * the read side only: a staging catalog may legitimately hold an empty `messages`, but the
 * production snapshot the check consumes never does. */
const KNOWN_DATA_TABLES = ["messages", "agent_activities"];

/** The read-side plausibility bar for a snapshot file: the all-zero signature, plus the known data
 * tables. `liveSnapshot` already refuses an all-zero live catalog; a snapshot can also arrive by
 * hand or from a changed generator, so the same evidence is required when it is read back. */
export function assertPlausibleSnapshot(tables: TableStat[]): void {
  assertPlausibleTables(tables);
  for (const name of KNOWN_DATA_TABLES) {
    const table = tables.find((entry) => entry.name === name);
    if (table !== undefined && table.totalBytes === 0)
      throw new Error(`the catalog reports ${name} as zero bytes`);
  }
}

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
