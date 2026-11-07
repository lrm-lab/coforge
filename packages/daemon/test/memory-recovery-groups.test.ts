import { expect, test } from "bun:test";
import type { AgentRecoveryMessage } from "@lrm/coforge-sdk/internal";
import { groupMemoryRecovery } from "#src/daemon-runtime/memory-recovery-groups";

const message = (id: string, conversationId: string, target: string): AgentRecoveryMessage => ({
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  conversationId,
  sequence: 1,
  target,
  latestSenderKind: "human",
  latestSenderHandle: "ada",
  latestSenderDescription: "",
  body: id,
});

test("groups Memory recovery messages and summaries by canonical conversation", () => {
  const groups = groupMemoryRecovery(
    [
      message("a-1", "conversation-a", "@ada"),
      message("b-1", "conversation-b", "@grace"),
      message("a-2", "conversation-a", "@ada"),
    ],
    { "@ada": 2, "@grace": 1, "#general": 3, "@remembered": 4 },
    { "#general": "conversation-general" },
    new Map([["@remembered", "conversation-remembered"]]),
  );

  expect(groups).toEqual([
    {
      conversationId: "conversation-a",
      target: "@ada",
      messages: [
        message("a-1", "conversation-a", "@ada"),
        message("a-2", "conversation-a", "@ada"),
      ],
      unreadSummary: { "@ada": 2 },
    },
    {
      conversationId: "conversation-b",
      target: "@grace",
      messages: [message("b-1", "conversation-b", "@grace")],
      unreadSummary: { "@grace": 1 },
    },
    {
      conversationId: "conversation-general",
      target: "#general",
      messages: [],
      unreadSummary: { "#general": 3 },
    },
    {
      conversationId: "conversation-remembered",
      target: "@remembered",
      messages: [],
      unreadSummary: { "@remembered": 4 },
    },
  ]);
});

test("requires a canonical conversation for every unread summary target", () => {
  expect(() => groupMemoryRecovery([], { "@missing": 1 }, {}, new Map())).toThrow(
    "Memory recovery requires a canonical conversation id",
  );
});
