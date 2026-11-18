import { expect, test } from "bun:test";

import { LEGACY_ANTIGRAVITY_EFFORT_MODELS } from "#src/server/agents/agent-runtime-config.server";

const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20261118150000_split_legacy_antigravity_model_runtime_key/migration.sql",
    import.meta.url,
  ),
).text();

const splitTable = [...migration.matchAll(/\('([^']+)', '([^']+)', '([^']+)'\)/g)]
  .map(([, legacyId, model, reasoning]) => ({ legacyId, model, reasoning }))
  .sort((left, right) => left.legacyId.localeCompare(right.legacyId));

const expectedSplits = Object.entries(LEGACY_ANTIGRAVITY_EFFORT_MODELS)
  .map(([legacyId, split]) => ({ legacyId, ...split }))
  .sort((left, right) => left.legacyId.localeCompare(right.legacyId));

test("the migration splits exactly the ids the code knows, and reads the stored runtime key", () => {
  expect(splitTable).toEqual(expectedSplits);
  expect(migration).toContain("SET lock_timeout = '5s';");
  expect(migration).toContain("RESET lock_timeout;");
  expect(migration).toContain("-- Rollback:");
  expect(migration).toMatch(
    /^-- Rollback: .*"runtimeConfigRevision" = GREATEST\("runtimeConfigRevision" - 1, 0\)/m,
  );
  expect(migration).toContain("\"runtimeConfig\"->>'runtime' = 'antigravity'");
  expect(migration).not.toContain("\"runtimeConfig\"->>'provider' = 'antigravity'");
  expect(migration).toMatch(/COALESCE\("a"\."runtimeConfig"->>'reasoning', ''\) = ''/);
  expect(migration).not.toContain("CASE");
  expect(migration).not.toContain("gpt-oss-120b-medium");
  expect(migration).not.toContain("claude-opus-4-6-thinking");
});
