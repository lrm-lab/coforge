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
    // task-ref-tokens writes `#channel:#N` /
    // `dm:@peer:#N` message references as task-ref tokens for QA's write-path check (task #437).
    // agentContextView is on for staging so QA can open the Agent context view on 0.1.29
    // Computers. Production stays without both.
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
