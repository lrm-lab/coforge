import { describe, expect, test } from "bun:test";
import { readCompose } from "./deploy-test-support";

type FlagDefinitions = {
  flags: Record<
    string,
    {
      state: string;
      variants: Record<string, boolean>;
      defaultVariant: string;
    }
  >;
};

const FLAGS_PATH = "/etc/coforge/feature-flags.json";

/** On for every Workspace: Agents see an app's Agent manifest as soon as it is granted. */
const APP_AGENT_MANIFEST_ON = {
  state: "ENABLED",
  variants: { on: true, off: false },
  defaultVariant: "on",
};

describe("feature flags in the deployed Compose files", () => {
  for (const environment of ["staging", "production"] as const) {
    test(`${environment} Web reads its flag definitions from a config inlined in its Compose file`, async () => {
      const compose = await readCompose(environment);
      const web = compose.services.web;
      expect(web?.environment?.COFORGE_FEATURE_FLAGS_FILE).toBe(FLAGS_PATH);
      expect(web?.configs).toContainEqual({ source: "coforge_feature_flags", target: FLAGS_PATH });
      const content = compose.configs?.coforge_feature_flags?.content;
      expect(typeof content).toBe("string");
      const definitions = JSON.parse(content as string) as FlagDefinitions;
      expect(Object.keys(definitions.flags)).toEqual(["app-agent-manifest"]);
      expect(definitions.flags["app-agent-manifest"]).toEqual(APP_AGENT_MANIFEST_ON);
    });
  }
});
