/** Runtime fixtures belong to Anvil; daemon integration tests locate them through this module. */
export const anvilRuntimeFixtures = {
  runtime404Capture: new URL(
    "../../../anvil/test/fixtures/runtime-404-capture.json",
    import.meta.url,
  ).pathname,
  claudeStreamJson: new URL("../../../anvil/test/fixtures/claude-stream-json.ts", import.meta.url)
    .pathname,
  claudeUsage: new URL("../../../anvil/test/fixtures/claude-usage.ts", import.meta.url).pathname,
  claudeUsageControl: new URL(
    "../../../anvil/test/fixtures/claude-usage-control.ts",
    import.meta.url,
  ).pathname,
  codex: new URL("../../../anvil/test/fixtures/codex-app-server.ts", import.meta.url).pathname,
  codexScenarios: new URL(
    "../../../anvil/test/fixtures/codex-app-server-scenarios.ts",
    import.meta.url,
  ).pathname,
  dsh: new URL("../../../anvil/test/fixtures/dsh-acp.ts", import.meta.url).pathname,
  antigravity: new URL("../../../anvil/test/fixtures/antigravity-fixture.ts", import.meta.url)
    .pathname,
  antigravityModels: new URL(
    "../../../anvil/test/fixtures/antigravity-models-fixture.ts",
    import.meta.url,
  ).pathname,
  grok: new URL("../../../anvil/test/fixtures/grok-acp-fixture.ts", import.meta.url).pathname,
  grokUsage: new URL("../../../anvil/test/fixtures/grok-usage-fixture.ts", import.meta.url)
    .pathname,
  grokClientInfo: new URL("../../../anvil/test/fixtures/grok-client-info.ts", import.meta.url)
    .pathname,
  commandCode: new URL("../../../anvil/test/fixtures/command-code-acp.ts", import.meta.url)
    .pathname,
  devin: new URL("../../../anvil/test/fixtures/devin-acp.ts", import.meta.url).pathname,
  kiro: new URL("../../../anvil/test/fixtures/kiro-acp.ts", import.meta.url).pathname,
  kiroClientInfo: new URL("../../../anvil/test/fixtures/kiro-client-info.ts", import.meta.url)
    .pathname,
  invalidJsonl: new URL("../../../anvil/test/fixtures/invalid-jsonl.ts", import.meta.url).pathname,
  cursor: new URL("../../../anvil/test/fixtures/cursor-agent-fixture.ts", import.meta.url).pathname,
  opencode: new URL("../../../anvil/test/fixtures/opencode-fixture.ts", import.meta.url).pathname,
};
