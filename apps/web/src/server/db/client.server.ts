import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  isServerTimingEnabled,
  recordDatabaseQuery,
} from "#src/server/observability/server-timing.server";

let client: PrismaClient | undefined;
export function getDatabaseClient(): PrismaClient | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  return (client ??= createDatabaseClient(url));
}

/**
 * How long an idle pooled connection stays open. `pg`'s default closes it after 10 s, so any
 * request after a 10 s lull first opens a new connection (TCP, startup, SCRAM) for each query it
 * runs concurrently: about 20 ms on a local PostgreSQL. Agents check and send in bursts minutes
 * apart, so most of their requests landed after such a lull.
 */
export const DATABASE_POOL_IDLE_TIMEOUT_MS = 5 * 60_000;

export function databasePoolConfig(url: string) {
  return { connectionString: url, idleTimeoutMillis: DATABASE_POOL_IDLE_TIMEOUT_MS };
}

function createDatabaseClient(url: string): PrismaClient {
  const adapter = new PrismaPg(databasePoolConfig(url));
  // Query events make Prisma format every query's parameters, so they are on only while the
  // deployment asks for Server-Timing.
  if (!isServerTimingEnabled()) return new PrismaClient({ adapter });
  const timed = new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] });
  // Prisma emits the event when the query finishes, in the async context of its caller.
  timed.$on("query", (event) => {
    const endedAt = performance.now();
    recordDatabaseQuery(endedAt - event.duration, endedAt);
  });
  return timed;
}

export function requireDatabaseClient() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return db;
}
