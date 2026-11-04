import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { AntigravityAcpProvider } from "@lrm/coforge-anvil/antigravity";
import { antigravityAcpRuntimeHost } from "#src/code-agent/antigravity/acp-host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { ANTIGRAVITY_USAGE_BUDGET_MS as USAGE_BUDGET_MS } from "./catalog-discovery-budget";
const FIXTURE = anvilRuntimeFixtures.antigravityUsage;
test(
  "the provider reads usage through its own agy command",
  async () => {
    const snapshot = await new AntigravityAcpProvider({
      host: antigravityAcpRuntimeHost,
      command: [process.execPath, FIXTURE],
    }).readUsage({ workingDirectory: tmpdir() });
    expect(snapshot?.primary?.id).toBe("antigravity-gemini-5h");
  },
  USAGE_BUDGET_MS,
);
