import { expect, test } from "bun:test";
import type { LocalAgentMessageRequest } from "@lrm/coforge-sdk/internal";
import { createAgentMessageHttpClient } from "#src/connection/agent-http-clients";
import { agentMessage as forwardAgentMessage } from "#src/connection/agent-message-operations";
import { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";
import { AgentContinuationStore } from "#src/persistence/agent-continuation-store";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import {
  agentId,
  newConversation,
  oldConversation,
  readPositionHarness,
  taskDelivery,
  temporaryReadPositionState,
} from "./fixtures/read-position-acceptance";

const target = "@ada";
const draft = { content: "Reply drafted in A", idempotencyKey: "original-draft" };
const originalEvidence = [{ target: { conversationId: oldConversation }, entry: { seq: 31 } }];

function draftHarness(
  stateDirectory: string,
  writes: unknown[],
  conversationId: string,
  sequence: number,
  holdWrites = false,
) {
  const { attention, store, close } = readPositionHarness(stateDirectory);
  const agentDb = store.stateDb(agentId);
  const drafts = new AgentMessageDraftStore(agentDb);
  const inbox = new AgentInboxStateMachine(drafts, new AgentContinuationStore(agentDb));
  const consumptionScope = { agentId, conversationId, channelType: "dm" as const, target };
  const client = createAgentMessageHttpClient(async (input, init) => {
    if (init?.method === "POST") {
      const write = JSON.parse(String(init.body)) as { idempotencyKey: string };
      writes.push(write);
      return Response.json({
        idempotencyKey: write.idempotencyKey,
        state: holdWrites ? "held" : "sent",
        decision: holdWrites ? "local_hold" : "forward",
        heldMessages: [],
        messageId: holdWrites ? "" : "accepted-message",
        consumptionScope: { conversationId },
      });
    }
    return Response.json({
      idempotencyKey: new URL(String(input)).searchParams.get("idempotencyKey"),
      messages: [],
      hasOlder: false,
      hasNewer: false,
      modelSeenUpToSeq: sequence,
      consumptionScope,
    });
  });
  const connection = {
    assertConnected() {},
    serverHttpUrl: "https://acceptance.invalid",
    keys: (agentApiKey: string) => ({ agentApiKey, daemonApiKey: "fixture-daemon" }),
    client,
  };
  const operations = new AgentMessageOperations({
    connection: { workspaceId: "workspace-1", computerId: "acceptance-computer" },
    attention,
    inbox: () => inbox,
    transport: {
      agentMessage: (request, key) => forwardAgentMessage(connection, request, key),
    },
    reportFreshnessHold: () => {},
  });
  return {
    drafts,
    close,
    call(request: Omit<LocalAgentMessageRequest, "context">) {
      return operations.handle(
        agentId,
        { ...request, context: "acceptance" },
        request.target,
        "fixture",
      );
    },
    async read() {
      await attention.receive(taskDelivery(conversationId, sequence, undefined, target));
      return operations.handle(
        agentId,
        { operation: "read", target, context: "acceptance", idempotencyKey: "read" },
        target,
        "fixture",
      );
    },
  };
}

test.each(["send-draft", "continuation"] as const)(
  "resuming a held send with %s retains its original scope after reopening under another conversation",
  async (resumeWith) => {
    const state = temporaryReadPositionState();
    const writes: unknown[] = [];
    try {
      const original = draftHarness(state.path, writes, oldConversation, 31, true);
      let continuationId: string | undefined;
      try {
        await original.read();
        const held = await original.call({ ...draft, operation: "send", target });
        expect(held.state).toBe("held");
        continuationId = held.continuation?.id;
        expect(continuationId).toBeString();
      } finally {
        original.close();
      }

      const reopened = draftHarness(state.path, writes, newConversation, 5);
      try {
        await reopened.read();
        const result = await reopened.call(
          resumeWith === "send-draft"
            ? { operation: "send", target, sendDraft: true, idempotencyKey: "resume" }
            : {
                operation: "continue",
                continuationId,
                continuationChoice: "a",
                idempotencyKey: "resume",
              },
        );
        expect(result.accepted).toBe(true);
        expect(writes).toHaveLength(2);
        for (const write of writes) {
          expect(write).toMatchObject({
            content: draft.content,
            idempotencyKey: draft.idempotencyKey,
          });
          expect(write).toHaveProperty("consumptionEvidence", originalEvidence);
        }
      } finally {
        reopened.close();
      }
    } finally {
      state.remove();
    }
  },
);

test("resuming an old unscoped draft cannot borrow current read evidence", async () => {
  const state = temporaryReadPositionState();
  const writes: unknown[] = [];
  const harness = draftHarness(state.path, writes, newConversation, 5);
  try {
    await harness.drafts.save(target, { ...draft, seenUpToSeq: 31, seenExactSeqs: [34] });
    await harness.read();
    const result = await harness.call({
      operation: "send",
      target,
      sendDraft: true,
      idempotencyKey: "resume",
    });
    expect(result.accepted).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      content: draft.content,
      idempotencyKey: draft.idempotencyKey,
    });
    expect(writes[0]).not.toHaveProperty("consumptionEvidence");
    expect(writes[0]).not.toHaveProperty("seenUpToSeq");
    expect(writes[0]).not.toHaveProperty("seenExactSeqs");
  } finally {
    harness.close();
    state.remove();
  }
});
