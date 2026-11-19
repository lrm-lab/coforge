import { describe, expect, test } from "bun:test";
import { readCompose } from "./deploy-test-support";

type FlagDefinitions = {
  flags: Record<string, { defaultVariant: string; variants: Record<string, unknown> }>;
};

const FLAGS_PATH = "/etc/coforge/feature-flags.json";

describe("feature flags in the deployed Compose files", () => {
  test("staging Web reads its flag definitions from a config inlined in its Compose file", async () => {
    const compose = await readCompose("staging");
    const web = compose.services.web;
    expect(web?.environment?.COFORGE_FEATURE_FLAGS_FILE).toBe(FLAGS_PATH);
    expect(web?.configs).toContainEqual({ source: "coforge_feature_flags", target: FLAGS_PATH });
    const content = compose.configs?.coforge_feature_flags?.content;
    expect(typeof content).toBe("string");
    const definitions = JSON.parse(content as string) as FlagDefinitions;
    expect(definitions.flags).toEqual({
      agentContextView: {
        state: "ENABLED",
        variants: { on: true, off: false },
        defaultVariant: "on",
      },
      "task-ref-tokens": {
        state: "ENABLED",
        variants: { on: true, off: false },
        defaultVariant: "on",
      },
      "computer-offline-alerts": {
        state: "ENABLED",
        variants: { on: true, off: false },
        defaultVariant: "on",
      },
    });
  });

  test("production defines agentContextView and defaults every inlined flag to off", async () => {
    const compose = await readCompose("production");
    const web = compose.services.web;
    expect(web?.environment?.COFORGE_FEATURE_FLAGS_FILE).toBe(FLAGS_PATH);
    expect(web?.configs).toContainEqual({ source: "coforge_feature_flags", target: FLAGS_PATH });
    const definitions = JSON.parse(
      compose.configs?.coforge_feature_flags?.content as string,
    ) as FlagDefinitions;
    expect(definitions.flags.agentContextView).toEqual({
      state: "ENABLED",
      variants: { on: true, off: false },
      defaultVariant: "off",
    });
    for (const flag of Object.values(definitions.flags)) {
      expect(flag.defaultVariant).toBe("off");
      expect(flag.variants[flag.defaultVariant]).toBe(false);
    }
  });
});
