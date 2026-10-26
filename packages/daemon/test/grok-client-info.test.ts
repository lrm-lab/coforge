import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
import { expect, test } from "bun:test";
import { grokProvider } from "./fixtures/grok-host";
import { discoverGrokCatalog, readGrokUsage } from "@lrm/coforge-anvil";
import { COFORGE_DAEMON_VERSION } from "#src/version";

const command = [process.execPath, anvilRuntimeFixtures.grokClientInfo];

test("Grok session sends its original daemon clientInfo", async () => {
  const session = await grokProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: process.cwd(),
    instructions: "fixture",
  });
  try {
    expect(JSON.parse((await session.readSessionIdentity!())!.sessionId!)).toEqual({
      name: "coforge-daemon",
      version: COFORGE_DAEMON_VERSION,
    });
  } finally {
    await session.dispose();
  }
});

test("Grok catalog sends its original fixed clientInfo", async () => {
  const catalog = await discoverGrokCatalog(command, process.cwd(), {}, grokRuntimeHost);
  expect(JSON.parse(catalog!.models[0]!.id)).toEqual({
    name: "coforge-daemon-catalog",
    version: "0.1.0",
  });
});

test("Grok usage sends its original fixed clientInfo", async () => {
  const usage = await readGrokUsage(process.cwd(), { command }, grokRuntimeHost);
  expect(JSON.parse(usage!.planType!)).toEqual({ name: "coforge-daemon-usage", version: "0.1.0" });
});
