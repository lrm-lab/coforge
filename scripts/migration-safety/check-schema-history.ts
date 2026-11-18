import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_HISTORY_FIX =
  "Prisma schema (apps/web/prisma/models/*.prisma) and migration history (apps/web/prisma/migrations/) have drifted. Run `bun scripts/migration-safety/check-schema-history.ts` against PostgreSQL and align them.";

export async function schemaHistoryViolations(changes: Array<{ path: string }>) {
  if (!changes.some((c) => c.path.startsWith("apps/web/prisma/"))) return [];
  const hasDb =
    Boolean(process.env.SHADOW_DATABASE_URL?.trim()) ||
    Boolean(process.env.INTEGRATION_DATABASE_URL?.trim()) ||
    Boolean(process.env.DATABASE_URL?.trim());
  if (!hasDb) return [];
  const res = await runSchemaHistoryDiff();
  return res.ok
    ? []
    : [{ rule: "schema-history" as const, location: "apps/web/prisma", found: res.detail }];
}

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/web");

function adminUrlFrom(databaseUrl: string, dbName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

export async function runSchemaHistoryDiff(
  env: NodeJS.ProcessEnv = process.env,
  webDir: string = WEB_DIR,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const explicitShadow = env.SHADOW_DATABASE_URL?.trim();
  const baseUrl =
    env.INTEGRATION_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || explicitShadow;
  if (!baseUrl) {
    return {
      ok: false,
      detail: "Set SHADOW_DATABASE_URL, INTEGRATION_DATABASE_URL, or DATABASE_URL.",
    };
  }

  let shadowUrl = explicitShadow;
  let tempDbName: string | undefined;
  const { Client } = await import(join(webDir, "node_modules/pg"));

  if (!shadowUrl) {
    tempDbName = `coforge_schema_diff_${Date.now()}_${process.pid}`;
    const admin = new Client(adminUrlFrom(baseUrl, "postgres"));
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${tempDbName}"`);
    } finally {
      await admin.end();
    }
    shadowUrl = adminUrlFrom(baseUrl, tempDbName);
  }

  try {
    const result = Bun.spawnSync(
      [
        "bunx",
        "--bun",
        "prisma",
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema",
        "prisma",
        "--exit-code",
      ],
      {
        cwd: webDir,
        env: {
          ...env,
          DATABASE_URL: baseUrl,
          SHADOW_DATABASE_URL: shadowUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode === 0) return { ok: true };
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim();
    return { ok: false, detail: output || `prisma migrate diff exited with ${result.exitCode}` };
  } finally {
    if (tempDbName) {
      const admin = new Client(adminUrlFrom(baseUrl, "postgres"));
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${tempDbName}"`);
      } finally {
        await admin.end();
      }
    }
  }
}

if (import.meta.main) {
  const result = await runSchemaHistoryDiff();
  if (!result.ok) {
    console.error(`schema-history-diff failed:\n${result.detail}`);
    process.exit(1);
  }
  console.log("Prisma schema matches migration history (empty diff).");
}
