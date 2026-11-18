import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20261118110000_split_legacy_antigravity_model_reasoning/migration.sql",
    import.meta.url,
  ),
).text();

test("legacy antigravity model migration splits only the known suffixed ids with lock_timeout and rollback", () => {
  expect(migration).toContain("SET lock_timeout = '5s';");
  expect(migration).toContain("-- Rollback:");
  expect(migration).toContain("RESET lock_timeout;");
  expect(migration).toContain("\"runtimeConfig\"->>'provider' = 'antigravity'");
  expect(migration).toContain("COALESCE(\"runtimeConfig\"->>'reasoning', '') = ''");
  for (const model of [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low",
    "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
  ]) {
    expect(migration).toContain(`'${model}'`);
  }
  expect(migration).not.toContain("gpt-oss-120b-medium");
  expect(migration).not.toContain("claude-opus-4-6-thinking");
});
