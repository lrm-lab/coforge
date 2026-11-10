import { expect, test } from "bun:test";
import type { AgentRecoveryMessage } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { session } from "./fixtures/attention-delivery";

test("recover returns the targets it announced, and none when everything was already read", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const message = (target: string, sequence: number): AgentRecoveryMessage => ({
    messageId: `message-${target}-${sequence}`,
    deliveryId: `delivery-${target}-${sequence}`,
    conversationId: `conversation-${target}`,
    sequence,
    target,
    latestSenderKind: "human",
    latestSenderHandle: "alice",
    latestSenderDescription: "",
    body: "body",
  });

  // A new message and a summary-only target are announced.
  expect(await index.recover("agent-1", [message("#general", 1)], { "#ops": 2 })).toEqual(
    new Set(["#general", "#ops"]),
  );

  // The Agent already read #general up to sequence 5: nothing is left to announce for it, even
  // though the recovery names it, so it announces nothing and sends no notice.
  index.recordModelSeen("agent-1", "#research", 5);
  const before = notices.length;
  expect(await index.recover("agent-1", [message("#research", 5)], { "#research": 1 })).toEqual(
    new Set(),
  );
  expect(notices).toHaveLength(before);
});
