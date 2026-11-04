import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import {
  installFeatureFlags,
  isFeatureEnabled,
} from "#src/server/feature-flags/feature-flags.server";

const FRANK = { workspaceId: "0199a0b0-0000-7000-8000-000000000001", workspaceSlug: "frank" };
const OTHER = { workspaceId: "0199a0b0-0000-7000-8000-000000000002", workspaceSlug: "other" };

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-deployed-flags-"));
});

afterEach(async () => {
  await installFeatureFlags({ status: "disabled" });
  await rm(directory, { recursive: true, force: true });
});

async function deployedDefinition(environment: "staging" | "production") {
  const compose = Bun.YAML.parse(
    await Bun.file(
      new URL(`../../../infra/${environment}/docker-compose.yml`, import.meta.url),
    ).text(),
  ) as { configs: { coforge_feature_flags: { content: string } } };
  return compose.configs.coforge_feature_flags.content;
}

/** Boots the flag provider the way the deployed Web does: the Compose file's inline definitions,
 * through the same strict boot validation. */
async function installDeployed(environment: "staging" | "production"): Promise<void> {
  const path = join(directory, "flags.json");
  await Bun.write(path, await deployedDefinition(environment));
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
}

test("staging's flag file passes boot validation", async () => {
  await installDeployed("staging");
  expect(await isFeatureEnabled("task-ref-tokens", OTHER)).toBe(false);
});

test("production's flag file passes boot validation", async () => {
  await installDeployed("production");
  expect(await isFeatureEnabled("task-ref-tokens", FRANK)).toBe(false);
});

test("no deployed flag targets a Workspace by its slug (task #491)", async () => {
  for (const environment of ["staging", "production"] as const) {
    const content = await deployedDefinition(environment);
    expect(content.includes("workspaceSlug")).toBe(false);
  }
});
