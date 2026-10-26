import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { antigravityProvider } from "./fixtures/antigravity-host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { ANTIGRAVITY_USAGE_BUDGET_MS as USAGE_BUDGET_MS } from "./catalog-discovery-budget";
const FIXTURE = anvilRuntimeFixtures.antigravityModels;
test(
  "the provider reads usage through its own agy command",
  async () => {
    const snapshot = await antigravityProvider({
      command: [process.execPath, FIXTURE],
    }).readUsage({ workingDirectory: tmpdir() });
    expect(snapshot?.primary?.id).toBe("antigravity-gemini-5h");
  },
  USAGE_BUDGET_MS,
);
