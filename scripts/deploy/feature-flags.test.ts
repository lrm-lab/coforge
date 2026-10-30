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
    expect(Object.keys(definitions.flags)).toEqual(["task-conversations"]);
  });

  test("production reads the same kind of inlined definitions, with task conversations for frank only", async () => {
    const compose = await readCompose("production");
    const web = compose.services.web;
    expect(web?.environment?.COFORGE_FEATURE_FLAGS_FILE).toBe(FLAGS_PATH);
    expect(web?.configs).toContainEqual({ source: "coforge_feature_flags", target: FLAGS_PATH });
    const definitions = JSON.parse(
      compose.configs?.coforge_feature_flags?.content as string,
    ) as FlagDefinitions;
    expect(Object.keys(definitions.flags)).toEqual(["task-conversations"]);
  });
});
