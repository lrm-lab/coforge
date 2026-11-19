import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { controlledClaude, waitForEvent } from "./fixtures/claude-feed";

async function finishedCompaction(metadata: unknown) {
  const fixture = await controlledClaude();
  const events: AgentRuntimeEvent[] = [];
  fixture.session.subscribe((event) => events.push(event));
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit({
      type: "system",
      subtype: "compact_boundary",
      ...(metadata === undefined ? {} : { compact_metadata: metadata }),
    });
    await waitForEvent(events, "compaction-finished");
    return events.find((event) => event.type === "compaction-finished");
  } finally {
    await fixture.dispose();
  }
}

test("a Claude Code compact_boundary hands its own token estimates to the daemon under their own names", async () => {
  const event = await finishedCompaction({
    trigger: "manual",
    pre_tokens: 29578,
    post_tokens: 9690,
    cumulative_dropped_tokens: 19888,
    duration_ms: 8720,
  });
  expect(event).toMatchObject({ runtimePreTokens: 29578, runtimePostTokens: 9690 });
  expect(event).not.toHaveProperty("tokensBefore");
  expect(event).not.toHaveProperty("tokensAfter");
});

test.each([
  ["no metadata", undefined],
  ["metadata that is not an object", "oops"],
  ["fields that are not whole non-negative numbers", { pre_tokens: "29578", post_tokens: -1 }],
])("a compact_boundary with %s carries no runtime estimates", async (_name, metadata) => {
  const event = await finishedCompaction(metadata);
  expect(event).not.toHaveProperty("runtimePreTokens");
  expect(event).not.toHaveProperty("runtimePostTokens");
});
