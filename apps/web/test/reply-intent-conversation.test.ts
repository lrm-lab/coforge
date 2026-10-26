import { expect, test } from "bun:test";
import {
  encodeAgentReplyIntent,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";
import {
  applyConversationChannelPublication,
  createReplyIntentStore,
} from "#src/features/agents/reply-intents";

const frame = (intent: AgentReplyIntent["intent"], workspaceId = "workspace-1") =>
  encodeAgentReplyIntent({
    protocolMajor: 1,
    requestId: "r",
    workspaceId,
    agentId: "a",
    observedAtMs: 1,
    intent,
  });
const start = (conversationId: string) =>
  frame({ phase: "start", callId: "call-1", conversationId });
const end = frame({ phase: "end", callId: "call-1" });

test("a conversation consumes its own start and pairs its stripped end", () => {
  const intents = createReplyIntentStore();
  try {
    applyConversationChannelPublication(intents, start("c1"), "workspace-1", "c1");
    expect(intents.store.state).toEqual([
      { agentId: "a", callId: "call-1", conversationId: "c1", threadRootId: null },
    ]);
    applyConversationChannelPublication(intents, end, "workspace-1", "c2");
    expect(intents.store.state).toHaveLength(1);
    applyConversationChannelPublication(intents, end, "workspace-1", "c1");
    expect(intents.store.state).toEqual([]);
  } finally {
    intents.clear();
  }
});

test("a conversation publication cannot introduce another conversation or Workspace", () => {
  const intents = createReplyIntentStore();
  try {
    applyConversationChannelPublication(intents, start("c2"), "workspace-1", "c1");
    applyConversationChannelPublication(
      intents,
      frame({ phase: "start", callId: "call-1", conversationId: "c1" }, "workspace-2"),
      "workspace-1",
      "c1",
    );
    expect(intents.store.state).toEqual([]);
  } finally {
    intents.clear();
  }
});

test("ordinary message data and malformed bytes leave reply intent state unchanged", () => {
  const intents = createReplyIntentStore();
  try {
    applyConversationChannelPublication(intents, start("c1"), "workspace-1", "c1");
    for (const data of [{ type: "message.available.v1" }, new Uint8Array([255]), null])
      applyConversationChannelPublication(intents, data, "workspace-1", "c1");
    expect(intents.store.state).toHaveLength(1);
  } finally {
    intents.clear();
  }
});
