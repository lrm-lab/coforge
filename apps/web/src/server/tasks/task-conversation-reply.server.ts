import type { MentionSelectorInput, TaskPrincipal } from "@lrm/coforge-sdk/internal";
import {
  MessageRequestInProgressError,
  type MessageRequestIdempotency,
  type MessageRequestRecords,
  type MessageRequestScope,
} from "#src/server/conversations/message-request-idempotency.server";
import type { TaskBoardPorts } from "./task-board-ports.server";
import { postTaskMessage } from "./task-discussion-send.server";
import { publishTaskConversationMessage } from "./task-publication.server";
import { checkTaskReplyFreshness } from "./task-reply-freshness.server";

export type TaskReplyInput = {
  body: string;
  idempotencyKey?: string;
  attachmentIds?: readonly string[];
  mentions?: readonly MentionSelectorInput[];
};

function replyKey(
  workspaceId: string,
  taskId: string,
  principal: TaskPrincipal,
  idempotencyKey: string,
): MessageRequestScope {
  return {
    workspaceId,
    senderKind: principal.agentId ? "agent" : "user",
    senderId: (principal.agentId ?? principal.userId)!,
    idempotencyKey: `task:${taskId}:${idempotencyKey}`,
  };
}

export async function writeTaskReply(
  ports: TaskBoardPorts,
  idempotency: MessageRequestIdempotency | undefined,
  data: {
    scope: { conversationId: string; workspaceId: string };
    taskId: string;
    principal: TaskPrincipal;
    member: { id: string; userId: string | null; agentId: string | null };
    body: string;
    input: TaskReplyInput;
    check?: string;
  },
) {
  const { scope, taskId, principal, member, body, input, check } = data;
  const post = async () => {
    const posted = await ports.db.$transaction((tx) =>
      postTaskMessage(tx, {
        taskId,
        scope,
        member,
        body,
        attachmentIds: input.attachmentIds,
        mentions: input.mentions,
        checkExistingDiscussion: check
          ? (conversationId) => checkTaskReplyFreshness(tx, conversationId, check, taskId)
          : undefined,
      }),
    );
    await publishTaskConversationMessage(ports, posted.messageId, posted.messageId).catch(
      () => undefined,
    );
    return {
      id: posted.messageId,
      sequence: posted.sequence,
      body: posted.body,
      createdAt: posted.createdAt,
      threadRootId: null,
      attachments: [],
      workspaceId: scope.workspaceId,
    };
  };
  const persisted =
    idempotency && input.idempotencyKey
      ? await idempotency.execute(
          replyKey(scope.workspaceId, taskId, principal, input.idempotencyKey),
          post,
        )
      : await post();
  return { messageId: persisted.id, sequence: persisted.sequence };
}

export async function reconcileTaskReply(
  idempotency: MessageRequestIdempotency | undefined,
  workspaceId: string,
  taskId: string,
  principal: TaskPrincipal,
  idempotencyKey: string,
) {
  const records = idempotency as
    | (MessageRequestIdempotency & Partial<MessageRequestRecords>)
    | undefined;
  if (!records?.find) return { state: "not_found" as const };
  const found = await records.find(replyKey(workspaceId, taskId, principal, idempotencyKey));
  if (found?.state === "processing") throw new MessageRequestInProgressError();
  if (found?.state === "completed")
    return {
      state: "committed" as const,
      messageId: found.message.id,
      sequence: found.message.sequence,
    };
  return { state: "not_found" as const };
}
