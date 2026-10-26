/** Runtime fixtures belong to Anvil; daemon integration tests locate them through this module. */
export const anvilRuntimeFixtures = {
  grok: new URL("../../../anvil/test/fixtures/grok-acp-fixture.ts", import.meta.url).pathname,
  grokUsage: new URL("../../../anvil/test/fixtures/grok-usage-fixture.ts", import.meta.url)
    .pathname,
  grokClientInfo: new URL("../../../anvil/test/fixtures/grok-client-info.ts", import.meta.url)
    .pathname,
  kiro: new URL("../../../anvil/test/fixtures/kiro-acp.ts", import.meta.url).pathname,
  kiroClientInfo: new URL("../../../anvil/test/fixtures/kiro-client-info.ts", import.meta.url)
    .pathname,
  invalidJsonl: new URL("../../../anvil/test/fixtures/invalid-jsonl.ts", import.meta.url).pathname,
  cursor: new URL("../../../anvil/test/fixtures/cursor-agent-fixture.ts", import.meta.url).pathname,
  opencode: new URL("../../../anvil/test/fixtures/opencode-fixture.ts", import.meta.url).pathname,
};
