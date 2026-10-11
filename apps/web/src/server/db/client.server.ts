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

/**
 * Every pooled connection runs with PostgreSQL's JIT off. The planner compiles a query with LLVM
 * once its estimated cost passes `jit_above_cost`, and an estimate that a correlated bound leaves
 * wide crosses it on short OLTP reads: the channel list's per-channel unread count, on a Workspace
 * of 60 channels with 10,000 messages each, spent 280 ms compiling to run for 3 ms. This app
 * runs no query long enough for compiled code to pay that back.
 */
export const DATABASE_SESSION_OPTIONS = "-c jit=off";

export function databasePoolConfig(url: string) {
  return {
    connectionString: url,
    idleTimeoutMillis: DATABASE_POOL_IDLE_TIMEOUT_MS,
    options: DATABASE_SESSION_OPTIONS,
  };
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
