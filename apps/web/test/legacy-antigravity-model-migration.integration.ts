import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import pg from "pg";
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
const targetName = "20261118110000_split_legacy_antigravity_model_reasoning";
const target = migrations.indexOf(targetName);

test("legacy antigravity model migration splits suffixed ids idempotently and leaves other rows intact", async () => {
  const admin = new pg.Pool({ connectionString });
  const database = `agymodel_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 1 });
  try {
    expect(target).toBeGreaterThan(0);
    const apply = async (names: readonly string[]) => {
      for (const name of names) {
        await pool.query(
          await Bun.file(new URL(`${name}/migration.sql`, migrationsDirectory)).text(),
        );
      }
    };
    await apply(migrations.slice(0, target));

    const workspaceId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const ids = {
      legacyMedium: crypto.randomUUID(),
      legacyHigh: crypto.randomUUID(),
      alreadySplit: crypto.randomUUID(),
      alreadyHasReasoning: crypto.randomUUID(),
      unlistedSuffix: crypto.randomUUID(),
      otherProvider: crypto.randomUUID(),
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

    await insertAgent(ids.legacyMedium, "legacy-medium", {
      provider: "antigravity",
      model: "gemini-3.8-flash-medium",
      modelProvider: "",
      reasoning: "",
    });
    await insertAgent(ids.legacyHigh, "legacy-high", {
      provider: "antigravity",
      model: "gemini-3.1-pro-high",
      modelProvider: "",
      reasoning: "",
    });
    await insertAgent(ids.alreadySplit, "already-split", {
      provider: "antigravity",
      model: "gemini-4-hydrogen",
      modelProvider: "",
      reasoning: "medium",
    });
    await insertAgent(ids.alreadyHasReasoning, "has-reasoning", {
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
      modelProvider: "",
      reasoning: "low",
    });
    await insertAgent(ids.unlistedSuffix, "unlisted-suffix", {
      provider: "antigravity",
      model: "custom-model-medium",
      modelProvider: "",
      reasoning: "",
    });
    await insertAgent(ids.otherProvider, "other-provider", {
      provider: "codex",
      model: "gemini-3.8-flash-medium",
      modelProvider: "",
      reasoning: "",
    });
    await pool.query("SET session_replication_role = 'origin'");

    await apply([targetName]);
    await apply([targetName]);

    const { rows } = await pool.query<{
      id: string;
      runtimeConfig: { provider: string; model: string; reasoning: string };
      runtimeConfigRevision: number;
    }>(
      `SELECT "id", "runtimeConfig", "runtimeConfigRevision" FROM "agents" WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(ids.legacyMedium)).toMatchObject({
      runtimeConfig: { provider: "antigravity", model: "gemini-3.8-flash", reasoning: "medium" },
      runtimeConfigRevision: 4,
    });
    expect(byId.get(ids.legacyHigh)).toMatchObject({
      runtimeConfig: { provider: "antigravity", model: "gemini-3.1-pro", reasoning: "high" },
      runtimeConfigRevision: 4,
    });
    expect(byId.get(ids.alreadySplit)).toMatchObject({
      runtimeConfig: { provider: "antigravity", model: "gemini-4-hydrogen", reasoning: "medium" },
      runtimeConfigRevision: 3,
    });
    expect(byId.get(ids.alreadyHasReasoning)).toMatchObject({
      runtimeConfig: {
        provider: "antigravity",
        model: "gemini-3.8-flash-high",
        reasoning: "low",
      },
      runtimeConfigRevision: 3,
    });
    expect(byId.get(ids.unlistedSuffix)).toMatchObject({
      runtimeConfig: {
        provider: "antigravity",
        model: "custom-model-medium",
        reasoning: "",
      },
      runtimeConfigRevision: 3,
    });
    expect(byId.get(ids.otherProvider)).toMatchObject({
      runtimeConfig: { provider: "codex", model: "gemini-3.8-flash-medium", reasoning: "" },
      runtimeConfigRevision: 3,
    });
  } finally {
    await pool.end().catch(() => {});
    await dropScratchDatabase(admin, database).catch(() => {});
    await admin.end().catch(() => {});
  }
});
