import { createFileRoute } from "@tanstack/react-router";
import { getDatabaseClient } from "#src/server/db/client.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ReadinessResult {
  ready: boolean;
  database: "ok" | "unreachable" | "unconfigured";
  redis: "ok" | "unreachable" | "unconfigured";
  schema: "ok" | "missing_migrations" | "error";
  missingMigrations?: string[];
  details?: string;
}

export function getExpectedMigrations(baseDir: string = process.cwd()): string[] {
  const candidates = [
    join(baseDir, ".migrate/prisma/migrations"),
    join(baseDir, "apps/web/prisma/migrations"),
    join(baseDir, "prisma/migrations"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        return readdirSync(c, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(c, d.name, "migration.sql")))
          .map((d) => d.name)
          .sort();
      } catch {
        continue;
      }
    }
  }
  return [];
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const result: ReadinessResult = {
    ready: true,
    database: "ok",
    redis: "ok",
    schema: "ok",
  };

  // 1. Database check
  const db = getDatabaseClient();
  if (!db) {
    result.ready = false;
    result.database = "unconfigured";
  } else {
    try {
      await db.$queryRawUnsafe("SELECT 1");
    } catch (error) {
      result.ready = false;
      result.database = "unreachable";
      result.details = `Database ping failed: ${String(error)}`;
    }
  }

  // 2. Redis check
  const redisUrl = Bun.env.REDIS_URL;
  if (!redisUrl) {
    result.ready = false;
    result.redis = "unconfigured";
  } else {
    try {
      const redis = openRedisClient(redisUrl);
      const pingRes = await redis.ping();
      if (pingRes !== "PONG") {
        result.ready = false;
        result.redis = "unreachable";
      }
    } catch (error) {
      result.ready = false;
      result.redis = "unreachable";
      result.details = result.details
        ? `${result.details}; Redis ping failed: ${String(error)}`
        : `Redis ping failed: ${String(error)}`;
    }
  }

  // 3. Schema check (db_migrations >= code_migrations)
  if (db && result.database === "ok") {
    try {
      const expected = getExpectedMigrations();
      if (expected.length > 0) {
        const rows = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
          'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL',
        );
        const appliedSet = new Set(rows.map((r) => r.migration_name));
        const missing = expected.filter((name) => !appliedSet.has(name));
        if (missing.length > 0) {
          result.ready = false;
          result.schema = "missing_migrations";
          result.missingMigrations = missing;
          result.details = result.details
            ? `${result.details}; Missing migrations: ${missing.join(", ")}`
            : `Missing migrations: ${missing.join(", ")}`;
        }
      }
    } catch (error) {
      result.ready = false;
      result.schema = "error";
      result.details = result.details
        ? `${result.details}; Schema check failed: ${String(error)}`
        : `Schema check failed: ${String(error)}`;
    }
  }

  return result;
}

export const Route = createFileRoute("/ready")({
  server: {
    handlers: {
      GET: async () => {
        const check = await checkReadiness();
        const status = check.ready ? 200 : 503;
        return Response.json(check, { status });
      },
    },
  },
});
