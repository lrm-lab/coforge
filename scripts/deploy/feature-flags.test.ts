import { describe, expect, test } from "bun:test";
import { readCompose } from "./deploy-test-support";

type FlagDefinitions = { flags: Record<string, unknown> };

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
    expect(definitions.flags).toEqual({});
  });

  test("production turns no flag on", async () => {
    const compose = await readCompose("production");
    expect(compose.services.web?.environment?.COFORGE_FEATURE_FLAGS_FILE).toBeUndefined();
    expect(compose.configs).toBeUndefined();
  });
});
