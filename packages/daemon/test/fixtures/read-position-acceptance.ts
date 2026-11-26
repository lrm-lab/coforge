import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import { forwardedTaskReadResponse } from "#src/daemon-runtime/forwarded-task-read-response";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { session } from "./attention-delivery";

export const agentId = `read-position-${crypto.randomUUID()}`;
export const taskTarget = "#acceptance:#42";
export const oldConversation = "conversation-a";
export const newConversation = "conversation-b";

export function temporaryReadPositionState() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "coforge-read-position-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export function taskDelivery(
  conversationId: string,
  sequence: number,
  body = `Task reply ${sequence}: ${"details ".repeat(50)}`,
  target = taskTarget,
): AgentMessageDelivery & { target: string } {
  const id = `${conversationId}-${sequence}-${target}`;
  return {
    protocolMajor: 1,
    requestId: `request-${id}`,
    deliveryId: `delivery-${id}`,
    messageId: `message-${id}`,
    workspaceId: "workspace-1",
    agentId,
    method: "agent:v1:message:deliver",
    conversationId,
    target,
    sequence,
    body,
    latestSenderKind: "human",
    latestSenderHandle: "ada",
    attachmentCount: 0,
  };
}

export function replay(message: AgentMessageDelivery): AgentMessageDelivery {
  return { ...message, deliveryId: `${message.deliveryId}-replay` };
}

export function readPositionHarness(stateDirectory: string) {
  const store = new AgentConsumedSeqStore(stateDirectory);
  const notices: string[] = [];
  const activeSession = session((notice) => notices.push(notice));
  const attention = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => activeSession },
    async () => {},
    () => {},
    { shouldHold: () => false, enqueue: () => {}, busy: () => {}, consumedSeqs: store },
  );
  return {
    store,
    notices,
    attention,
    async readPage(
      conversationId: string,
      boundary: number,
      messages: readonly AgentMessageDelivery[] = [],
    ) {
      const query = { channel: "#acceptance", task_number: "42", unread: "true" };
      await forwardedTaskReadResponse(
        {
          agentId,
          request: { route: "read", query },
          recordRead: (id, request, body) => settleForwardedTaskRead(attention, id, request, body),
        },
        Response.json({
          consumptionScope: { agentId, conversationId, channelType: "thread", target: taskTarget },
          messages: messages.map((message) => ({
            id: message.messageId,
            sequence: message.sequence,
            senderKind: "human",
            senderHandle: "ada",
            senderDescription: "",
            target: message.target,
            body: message.body,
            createdAt: "2026-11-01T00:00:00.000Z",
            attachments: [],
          })),
          modelSeenUpToSeq: boundary,
          hasOlder: false,
          hasNewer: false,
          moreUnread: false,
        }),
      );
    },
    close: () => store.close(),
  };
}
