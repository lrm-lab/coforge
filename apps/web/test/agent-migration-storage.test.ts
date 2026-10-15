import { expect, test } from "bun:test";
import { readAgentMigrationStorageConfig } from "#src/server/agent-migrations/agent-migration-storage.server";

const oss = {
  COFORGE_FILE_STORAGE: "oss",
  COFORGE_OSS_BUCKET: "coforge-files-staging",
  COFORGE_OSS_REGION: "cn-beijing",
};

test("a deployment without a migration bucket has no migration storage", async () => {
  expect(await readAgentMigrationStorageConfig({ ...oss })).toBeNull();
  expect(await readAgentMigrationStorageConfig({})).toBeNull();
});

test("the migration bucket is OSS, in the private store's account and region, and its own bucket", async () => {
  expect(
    await readAgentMigrationStorageConfig({
      ...oss,
      COFORGE_MIGRATION_OSS_BUCKET: "coforge-agent-migrations-staging",
    }),
  ).toMatchObject({
    kind: "oss",
    bucket: "coforge-agent-migrations-staging",
    region: "cn-beijing",
  });
  await expect(
    readAgentMigrationStorageConfig({
      COFORGE_MIGRATION_OSS_BUCKET: "coforge-agent-migrations-staging",
    }),
  ).rejects.toThrow(/COFORGE_FILE_STORAGE=oss/);
  await expect(
    readAgentMigrationStorageConfig({
      ...oss,
      COFORGE_MIGRATION_OSS_BUCKET: "coforge-files-staging",
    }),
  ).rejects.toThrow(/must not be COFORGE_OSS_BUCKET/);
});
