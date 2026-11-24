import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";

import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import {
  installFeatureFlags,
  isFeatureDefined,
  isFeatureEnabled,
  onFeatureFlagsChanged,
} from "#src/server/feature-flags/feature-flags.server";

const FRANK = { workspaceId: "0199a0b0-0000-7000-8000-000000000001", workspaceSlug: "frank" };
const OTHER = { workspaceId: "0199a0b0-0000-7000-8000-000000000002", workspaceSlug: "other" };

/** A flagd definition file whose flags are each on only for the Workspaces with those slugs. */
function definitionsMap(flags: Record<string, string[]>): string {
  return JSON.stringify({
    $schema: "https://flagd.dev/schema/v0/flags.json",
    flags: Object.fromEntries(
      Object.entries(flags).map(([flag, slugs]) => [
        flag,
        {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "off",
          targeting: { if: [{ in: [{ var: "workspaceSlug" }, slugs] }, "on", "off"] },
        },
      ]),
    ),
  });
}

/** A flagd definition file whose `flag` is on only for the Workspaces with these slugs. */
function definitions(flag: string, slugs: string[]): string {
  return definitionsMap({ [flag]: slugs });
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

test("a flag is defined only while the loaded file marks it ENABLED", async () => {
  expect(isFeatureDefined("app-notifications")).toBe(false);
  await installFeatureFlags(await readFeatureFlagsConfiguration({}));
  expect(isFeatureDefined("app-notifications")).toBe(false);

  await installFile(definitions("app-data-permissions", ["frank"]));
  expect(isFeatureDefined("app-data-permissions")).toBe(true);
  expect(isFeatureDefined("app-notifications")).toBe(false);

  await installFile(
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-notifications": {
          state: "DISABLED",
          variants: { on: true, off: false },
          defaultVariant: "off",
        },
      },
    }),
  );
  expect(isFeatureDefined("app-notifications")).toBe(false);

  await installFeatureFlags({ status: "disabled" });
  expect(isFeatureDefined("app-data-permissions")).toBe(false);
});

// flagd polls the file with `fs.watchFile` (about every five seconds, not configurable).
const FILE_POLL_BOUND_MS = 15_000;

test(
  "a rewritten flag file updates targeting, adds and removes defined flags, and notifies listeners after re-reading",
  async () => {
    const path = await installFile(
      definitionsMap({
        "app-data-permissions": ["other"],
        "app-bot": ["frank"],
      }),
    );
    expect(await isFeatureEnabled("app-data-permissions", FRANK)).toBe(false);
    expect(isFeatureDefined("app-data-permissions")).toBe(true);
    expect(isFeatureDefined("app-bot")).toBe(true);
    expect(isFeatureDefined("app-notifications")).toBe(false);

    // Subscribe to both the OpenFeature event and the app callback before writing so a single
    // real file poll verifies targeting updates, added/removed definitions, and both notifications.
    const providerChanged = Promise.withResolvers<void>();
    const appChanged = Promise.withResolvers<{ addedDefined: boolean; removedDefined: boolean }>();
    const onProviderChanged = () => providerChanged.resolve();
    const stopAppListener = onFeatureFlagsChanged(() => {
      appChanged.resolve({
        addedDefined: isFeatureDefined("app-notifications"),
        removedDefined: isFeatureDefined("app-bot"),
      });
    });
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, onProviderChanged);
    try {
      await Bun.write(
        path,
        definitionsMap({
          "app-data-permissions": ["frank"],
          "app-notifications": ["frank"],
        }),
      );
      const [, observedAtCallback] = await Promise.all([
        providerChanged.promise,
        appChanged.promise,
      ]);
      expect(await isFeatureEnabled("app-data-permissions", FRANK)).toBe(true);
      expect(observedAtCallback).toEqual({ addedDefined: true, removedDefined: false });
      expect(isFeatureDefined("app-notifications")).toBe(true);
      expect(isFeatureDefined("app-bot")).toBe(false);
      expect(isFeatureDefined("app-data-permissions")).toBe(true);
    } finally {
      stopAppListener();
      OpenFeature.removeHandler(ProviderEvents.ConfigurationChanged, onProviderChanged);
    }
  },
  FILE_POLL_BOUND_MS,
);
