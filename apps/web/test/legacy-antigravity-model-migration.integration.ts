import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import pg from "pg";
import { agentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { dropScratchDatabase } from "./helpers/drop-scratch-database";

const connectionString = Bun.env.MIGRATION_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required");
}

const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const fixedName = "20261118150000_split_legacy_antigravity_model_runtime_key";
const fixed = migrations.indexOf(fixedName);
const firstName = "20261118110000_split_legacy_antigravity_model_reasoning";
const first = migrations.indexOf(firstName);

const antigravity = (model: string, reasoning = "") => ({
  ...agentRuntimeConfig(
    { provider: "antigravity", model: "gemini-3.8-flash", modelProvider: "", reasoning: "" },
    { kind: "default" },
  ),
  model,
  reasoning,
});

test("the shipped migration's condition matches no row this shape stores, and the fixed one splits them", async () => {
  const admin = new pg.Pool({ connectionString });
  const database = `agymodel_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 1 });
  try {
    expect(first).toBeGreaterThan(0);
    expect(fixed).toBeGreaterThan(first);
    const apply = async (names: readonly string[]) => {
      for (const name of names) {
        await pool.query(
          await Bun.file(new URL(`${name}/migration.sql`, migrationsDirectory)).text(),
        );
      }
    };
    await apply(migrations.slice(0, first));

    const workspaceId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const ids = {
      legacyMedium: crypto.randomUUID(),
      legacyHigh: crypto.randomUUID(),
      catalogModel: crypto.randomUUID(),
      userPickedReasoning: crypto.randomUUID(),
      unlistedSuffix: crypto.randomUUID(),
      otherRuntime: crypto.randomUUID(),
    };
    await pool.query("SET session_replication_role = 'replica'");
    const insertAgent = (
      id: string,
      name: string,
      runtimeConfig: Record<string, unknown>,
      revision = 3,
    ) =>
      pool.query(
        `INSERT INTO "agents" ("id", "workspaceId", "name", "displayName", "ownerId", "runtimeConfig", "runtimeConfigRevision")
         VALUES ($1, $2, $3, $3, $4, $5::jsonb, $6)`,
        [id, workspaceId, name, ownerId, JSON.stringify(runtimeConfig), revision],
      );

    await insertAgent(ids.legacyMedium, "legacy-medium", antigravity("gemini-3.8-flash-medium"));
    await insertAgent(ids.legacyHigh, "legacy-high", antigravity("gemini-3.1-pro-high"));
    await insertAgent(ids.catalogModel, "catalog-model", antigravity("gpt-oss-120b-medium"));
    await insertAgent(
      ids.userPickedReasoning,
      "picked-reasoning",
      antigravity("gemini-3.8-flash-high", "low"),
    );
    await insertAgent(ids.unlistedSuffix, "unlisted-suffix", antigravity("custom-model-medium"));
    await insertAgent(ids.otherRuntime, "other-runtime", {
      ...antigravity("gemini-3.8-flash-medium"),
      runtime: "codex",
    });
    await pool.query("SET session_replication_role = 'origin'");

    const { rows: oldConditionHits } = await pool.query<{ id: string }>(
      `SELECT "id" FROM "agents" WHERE "runtimeConfig"->>'provider' = 'antigravity'`,
    );
    expect(oldConditionHits).toHaveLength(0);

    await apply([fixedName]);
    await apply([fixedName]);

    const { rows } = await pool.query<{
      id: string;
      runtimeConfig: { runtime: string; provider: unknown; model: string; reasoning: string };
      runtimeConfigRevision: number;
    }>(
      `SELECT "id", "runtimeConfig", "runtimeConfigRevision" FROM "agents" WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(ids.legacyMedium)).toMatchObject({
      runtimeConfig: {
        runtime: "antigravity",
        provider: { kind: "default" },
        model: "gemini-3.8-flash",
        reasoning: "medium",
      },
      runtimeConfigRevision: 4,
    });
    expect(byId.get(ids.legacyHigh)).toMatchObject({
      runtimeConfig: { model: "gemini-3.1-pro", reasoning: "high" },
      runtimeConfigRevision: 4,
    });
    expect(byId.get(ids.catalogModel)).toMatchObject({
      runtimeConfig: { model: "gpt-oss-120b-medium", reasoning: "" },
      runtimeConfigRevision: 3,
    });
    expect(byId.get(ids.userPickedReasoning)).toMatchObject({
      runtimeConfig: { model: "gemini-3.8-flash-high", reasoning: "low" },
      runtimeConfigRevision: 3,
    });
    expect(byId.get(ids.unlistedSuffix)).toMatchObject({
      runtimeConfig: { model: "custom-model-medium", reasoning: "" },
      runtimeConfigRevision: 3,
    });
    expect(byId.get(ids.otherRuntime)).toMatchObject({
      runtimeConfig: { runtime: "codex", model: "gemini-3.8-flash-medium", reasoning: "" },
      runtimeConfigRevision: 3,
    });
  } finally {
    await pool.end().catch(() => {});
    await dropScratchDatabase(admin, database).catch(() => {});
    await admin.end().catch(() => {});
  }
});
