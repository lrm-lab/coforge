import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import pg from "pg";
import {
  agentRuntimeConfig,
  LEGACY_ANTIGRAVITY_EFFORT_MODELS,
} from "#src/server/agents/agent-runtime-config.server";
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

const storedBeforeTheSplit = (model: string, reasoning = "") => ({
  ...agentRuntimeConfig(
    { provider: "antigravity", model: "gemini-3.8-flash", modelProvider: "", reasoning: "" },
    { kind: "default" },
  ),
  model,
  reasoning,
});

type StoredAgent = {
  runtimeConfig: Record<string, unknown>;
  runtimeConfigRevision: number;
};

test("the shipped migration moves no row of the stored shape, and the fixed one splits every listed id", async () => {
  const admin = new pg.Pool({ connectionString });
  const database = `agymodel_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 1 });
  try {
    expect(first).toBeGreaterThanOrEqual(0);
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
    const legacyIds = Object.keys(LEGACY_ANTIGRAVITY_EFFORT_MODELS);
    const untouched = {
      catalogModel: crypto.randomUUID(),
      userPickedReasoning: crypto.randomUUID(),
      unlistedSuffix: crypto.randomUUID(),
      otherRuntime: crypto.randomUUID(),
    };
    const seeded = new Map<string, StoredAgent>();
    await pool.query("SET session_replication_role = 'replica'");
    const insertAgent = async (
      id: string,
      name: string,
      runtimeConfig: Record<string, unknown>,
      revision = 3,
    ) => {
      seeded.set(id, { runtimeConfig, runtimeConfigRevision: revision });
      await pool.query(
        `INSERT INTO "agents" ("id", "workspaceId", "name", "displayName", "ownerId", "runtimeConfig", "runtimeConfigRevision")
         VALUES ($1, $2, $3, $3, $4, $5::jsonb, $6)`,
        [id, workspaceId, name, ownerId, JSON.stringify(runtimeConfig), revision],
      );
    };

    const legacyRows = legacyIds.map((legacyId, index) => ({
      id: crypto.randomUUID(),
      legacyId,
      name: `legacy-${index}`,
    }));
    for (const row of legacyRows)
      await insertAgent(row.id, row.name, storedBeforeTheSplit(row.legacyId));
    await insertAgent(
      untouched.catalogModel,
      "catalog-model",
      storedBeforeTheSplit("gpt-oss-120b-medium"),
    );
    await insertAgent(
      untouched.userPickedReasoning,
      "picked-reasoning",
      storedBeforeTheSplit("gemini-3.8-flash-high", "low"),
    );
    await insertAgent(
      untouched.unlistedSuffix,
      "unlisted-suffix",
      storedBeforeTheSplit("custom-model-medium"),
    );
    await insertAgent(untouched.otherRuntime, "other-runtime", {
      ...storedBeforeTheSplit("gemini-3.8-flash-medium"),
      runtime: "codex",
    });
    await pool.query("SET session_replication_role = 'origin'");

    const readAll = async () => {
      const { rows } = await pool.query<StoredAgent & { id: string }>(
        `SELECT "id", "runtimeConfig", "runtimeConfigRevision" FROM "agents" WHERE "workspaceId" = $1`,
        [workspaceId],
      );
      return new Map(rows.map((row) => [row.id, row]));
    };

    await apply([firstName]);
    const afterShipped = await readAll();
    for (const [id, before] of seeded) expect(afterShipped.get(id)).toEqual({ id, ...before });

    await apply([fixedName]);
    await apply([fixedName]);
    const afterFixed = await readAll();

    for (const row of legacyRows) {
      const split = LEGACY_ANTIGRAVITY_EFFORT_MODELS[row.legacyId]!;
      expect(afterFixed.get(row.id)?.runtimeConfig).toEqual(
        storedBeforeTheSplit(split.model, split.reasoning),
      );
      expect(afterFixed.get(row.id)?.runtimeConfigRevision).toBe(4);
    }
    for (const id of Object.values(untouched))
      expect(afterFixed.get(id)).toEqual({ id, ...seeded.get(id)! });

    const statement = await Bun.file(
      new URL(`${fixedName}/migration.sql`, migrationsDirectory),
    ).text();
    const rollback = statement.match(/^-- Rollback: (.+)$/m)?.[1];
    if (!rollback) throw new Error("the migration carries no Rollback comment");
    await pool.query(rollback);
    const afterRollback = await readAll();
    for (const [id, before] of seeded) expect(afterRollback.get(id)).toEqual({ id, ...before });
  } finally {
    await pool.end().catch(() => {});
    await dropScratchDatabase(admin, database).catch(() => {});
    await admin.end().catch(() => {});
  }
});
