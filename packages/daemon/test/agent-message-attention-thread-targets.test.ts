import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

test("thread attention counts sparse pending messages and preserves other targets", async () => {
  const notices: string[] = [];
  const sharedSession = session((notice) => {
    notices.push(notice);
  });
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => sharedSession },
    async () => {},
  );
  for (const [id, sequence, target] of [
    ["a", 2, "@alice:12345678"],
    ["b", 9, "@alice:12345678"],
    ["c", 4, "@alice"],
    ["d", 7, "@alice:87654321"],
  ] as const)
    await index.receive({ ...delivery(id, "human", "alice"), sequence, target });
  index.recordModelSeen("agent-1", "@alice:12345678", 2);
  expect(index.check("agent-1")).toEqual([
    expect.objectContaining({
      target: "@alice:12345678",
      pendingCount: 1,
      firstPendingSequence: 9,
      flags: ["thread"],
    }),
    expect.objectContaining({ target: "@alice", pendingCount: 1 }),
    expect.objectContaining({ target: "@alice:87654321", pendingCount: 1 }),
  ]);
  // Each target's line shows its own newest message; nothing else is copied.
  expect(notices.join("\n")).toContain("  @alice: private body");
});
