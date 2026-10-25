/** Runtime fixtures belong to Anvil; daemon integration tests locate them through this module. */
export const anvilRuntimeFixtures = {
  cursor: new URL("../../../anvil/test/fixtures/cursor-agent-fixture.ts", import.meta.url).pathname,
  opencode: new URL("../../../anvil/test/fixtures/opencode-fixture.ts", import.meta.url).pathname,
};
