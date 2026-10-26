import { expect, test } from "bun:test";
import { discoverGrokCatalog, readGrokUsage } from "@lrm/coforge-anvil/grok";
import { fixtureGrokHost, grokProvider } from "./fixtures/grok-host";
const command = [
  process.execPath,
  new URL("./fixtures/grok-client-info.ts", import.meta.url).pathname,
];
test("Grok session sends its injected clientInfo", async () => {
  const session = await grokProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: process.cwd(),
    instructions: "fixture",
  });
  try {
    expect(JSON.parse((await session.readSessionIdentity!())!.sessionId!)).toEqual(
      fixtureGrokHost.sessionClientInfo,
    );
  } finally {
    await session.dispose();
  }
});
test("Grok catalog sends its injected clientInfo", async () => {
  const catalog = await discoverGrokCatalog(command, process.cwd(), {}, fixtureGrokHost);
  expect(JSON.parse(catalog!.models[0]!.id)).toEqual(fixtureGrokHost.catalogClientInfo);
});
test("Grok usage sends its injected clientInfo", async () => {
  const usage = await readGrokUsage(process.cwd(), { command }, fixtureGrokHost);
  expect(JSON.parse(usage!.planType!)).toEqual(fixtureGrokHost.usageClientInfo);
});
