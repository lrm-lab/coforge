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
    // Task #491 stopped pinning experiments to a Workspace in flagd: task-conversations and
    // artifacts now show for every Workspace, switched on per Workspace in Settings > Experiments.
    // The one rule left is artifact-web-pages, on for every Workspace in staging so QA can make
    // web pages, which an artifact's page previews (task #514); production stays without it.
    expect(definitions.flags).toEqual({
      "artifact-web-pages": {
        state: "ENABLED",
        variants: { on: true, off: false },
        defaultVariant: "on",
      },
    });
  });

  test("production reads the same kind of inlined definitions, now with no flag rules", async () => {
    const compose = await readCompose("production");
    const web = compose.services.web;
    expect(web?.environment?.COFORGE_FEATURE_FLAGS_FILE).toBe(FLAGS_PATH);
    expect(web?.configs).toContainEqual({ source: "coforge_feature_flags", target: FLAGS_PATH });
    const definitions = JSON.parse(
      compose.configs?.coforge_feature_flags?.content as string,
    ) as FlagDefinitions;
    expect(Object.keys(definitions.flags)).toEqual([]);
  });
});
