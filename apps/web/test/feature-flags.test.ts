import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";

import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import {
  installFeatureFlags,
  isFeatureEnabled,
} from "#src/server/feature-flags/feature-flags.server";

const FRANK = { workspaceId: "0199a0b0-0000-7000-8000-000000000001", workspaceSlug: "frank" };
const OTHER = { workspaceId: "0199a0b0-0000-7000-8000-000000000002", workspaceSlug: "other" };

/** A flagd definition file whose `flag` is on only for the Workspaces with these slugs. */
function definitions(flag: string, slugs: string[]): string {
  return JSON.stringify({
    $schema: "https://flagd.dev/schema/v0/flags.json",
    flags: {
      [flag]: {
        state: "ENABLED",
        variants: { on: true, off: false },
        defaultVariant: "off",
        targeting: { if: [{ in: [{ var: "workspaceSlug" }, slugs] }, "on", "off"] },
      },
    },
  });
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-feature-flags-"));
});

afterEach(async () => {
  // Back to no provider: closes the flagd provider, which stops watching the file.
  await installFeatureFlags({ status: "disabled" });
  await rm(directory, { recursive: true, force: true });
});

async function installFile(content: string): Promise<string> {
  const path = join(directory, "flags.json");
  await Bun.write(path, content);
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
  return path;
}

test("every flag is off when no flag file is configured", async () => {
  const warn = spyOn(console, "warn");
  try {
    await installFeatureFlags(await readFeatureFlagsConfiguration({}));
    expect(await isFeatureEnabled("app-data-permissions", FRANK)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("a flag targeted at a Workspace slug is on for that Workspace and off for another", async () => {
  await installFile(definitions("app-data-permissions", ["frank"]));
  expect(await isFeatureEnabled("app-data-permissions", FRANK)).toBe(true);
  expect(await isFeatureEnabled("app-data-permissions", OTHER)).toBe(false);
});

test("a registered flag the file does not define is off, and its error is logged once", async () => {
  await installFile(definitions("some-other-flag", ["frank"]));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await isFeatureEnabled("app-data-permissions", FRANK)).toBe(false);
    expect(await isFeatureEnabled("app-data-permissions", OTHER)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "feature_flags:evaluation_failed",
      flag: "app-data-permissions",
      error_code: "FLAG_NOT_FOUND",
      workspace_id: FRANK.workspaceId,
    });
  } finally {
    warn.mockRestore();
  }
});

test.each([
  ["is missing", undefined],
  ["is not JSON", "flags: {}"],
  // The provider itself loads this one (it validates leniently), so only the boot check stops it.
  [
    "breaks the flagd schema in a targeting rule",
    definitions("app-data-permissions", ["frank"]).replace('"in"', '"inn"'),
  ],
])("the configuration names the variable when the file %s", async (_, content) => {
  const path = join(directory, "flags.json");
  if (content !== undefined) await Bun.write(path, content);
  const promise = readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path });
  await expect(promise).rejects.toThrow(/COFORGE_FEATURE_FLAGS_FILE/);
});

// flagd polls the file with `fs.watchFile` (about every five seconds, not configurable).
const FILE_POLL_BOUND_MS = 15_000;

test(
  "a rewritten flag file is picked up without a restart",
  async () => {
    const path = await installFile(definitions("app-data-permissions", ["other"]));
    expect(await isFeatureEnabled("app-data-permissions", FRANK)).toBe(false);
    // The provider's documented change event is the completion this test awaits.
    const { promise: changed, resolve } = Promise.withResolvers<void>();
    const onChanged = () => resolve();
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, onChanged);
    try {
      await Bun.write(path, definitions("app-data-permissions", ["frank"]));
      await changed;
      expect(await isFeatureEnabled("app-data-permissions", FRANK)).toBe(true);
    } finally {
      OpenFeature.removeHandler(ProviderEvents.ConfigurationChanged, onChanged);
    }
  },
  FILE_POLL_BOUND_MS,
);
