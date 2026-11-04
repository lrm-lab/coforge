import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import { delivery, session } from "./fixtures/attention-delivery";

test("a forwarded task read consumes its messages, so a replayed delivery stays quiet", async () => {
  let notifications = 0;
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => void notifications++) },
    async () => {},
  );
  // What `coforge task read` forwarded to the cloud answered: the scope names the discussion's
  // own spelling, `#board:#N` — canonical for task conversations.
  settleForwardedTaskRead(
    index,
    "agent-1",
    {},
    {
      consumptionScope: {
        agentId: "agent-1",
        conversationId: "conversation-1",
        channelType: "thread",
        target: "#coforge:#442",
      },
      messages: [
        {
          id: "m1",
          sequence: 6,
          senderKind: "human",
          senderHandle: "ada",
          senderDescription: "",
          target: "#coforge:#442",
          body: "looks good",
          createdAt: "2026-11-03T19:00:00.000Z",
          attachments: [],
        },
      ],
      hasOlder: false,
      hasNewer: false,
      modelSeenUpToSeq: 6,
    },
  );
  // The replay a reconnect brings back: the same delivery, spelled exactly as the scope's target.
  await index.receive({ ...delivery("task-reply"), target: "#coforge:#442", sequence: 6 });
  expect(notifications).toBe(0);
});

test("a forwarded read response without this Agent's scope records nothing", async () => {
  let notifications = 0;
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => void notifications++) },
    async () => {},
  );
  settleForwardedTaskRead(
    index,
    "agent-1",
    {},
    {
      consumptionScope: {
        agentId: "other-agent",
        conversationId: "conversation-1",
        channelType: "thread",
        target: "#coforge:#442",
      },
      messages: [],
      hasOlder: false,
      hasNewer: false,
      modelSeenUpToSeq: null,
    },
  );
  await index.receive({ ...delivery("task-reply"), target: "#coforge:#442", sequence: 6 });
  expect(notifications).toBe(1);
});
