import { expect, test } from "bun:test";
import { OpenCodeAcpTurnEvents } from "@lrm/coforge-anvil/opencode";

const host = {
  isShellToolName: () => false,
  createReplyIntentScanner: () => ({ feed: () => undefined, complete: () => {}, reset: () => [] }),
};

test("OpenCode usage_update emits context-usage for valid readings and ignores malformed ones", () => {
  const turn = new OpenCodeAcpTurnEvents(host as never);
  expect(turn.read({ sessionUpdate: "usage_update", used: 140_000, size: 200_000 })).toEqual([
    { type: "context-usage", usedTokens: 140_000, windowTokens: 200_000 },
  ]);
  expect(turn.read({ sessionUpdate: "usage_update", used: -1, size: 200_000 })).toEqual([]);
  expect(turn.read({ sessionUpdate: "usage_update", used: 100, size: 0 })).toEqual([]);
});
