import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import {
  isServerTimingEnabled,
  recordDatabaseQuery,
} from "#src/server/observability/server-timing.server";
import { databasePoolConfig } from "./pool-config.server";
import { StatementPool } from "./statement-pool.server";

/** The database the server connects to, or nothing where none is configured. */
export function configuredDatabaseUrl(): string | undefined {
  return Bun.env.DATABASE_URL || undefined;
}

let client: PrismaClient | undefined;
export function getDatabaseClient(): PrismaClient | undefined {
  const url = configuredDatabaseUrl();
  if (!url) return undefined;
  if (!client) {
    const created = createDatabaseClient(url);
    client = created;
    // Close the pool when the process stops. A later `getDatabaseClient()` would build a new one.
    onServerShutdown(async () => {
      if (client === created) client = undefined;
      await created.$disconnect();
    });
  }
  return client;
}

/** How long a request waits for a pooled connection before it fails, rather than queueing forever. */
const DATABASE_CONNECT_TIMEOUT_MS = 5_000;

function createDatabaseClient(url: string): PrismaClient {
  const pool = new StatementPool({
    ...databasePoolConfig(url),
    connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
  });
  // The adapter ends a pool it was handed only when asked to.
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
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
