import { createAgentAttachmentMessages } from "#src/server/attachments/agent-attachment-messages.server";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { attachmentCommentsFixture } from "./attachment-comments-fixture";

export async function agentAttachmentMessagesFixture() {
  const f = await attachmentCommentsFixture();
  const agent = await f.db.agent.create({
    data: {
      workspaceId: f.workspace.id,
      ownerId: f.owner.id,
      name: `reviewer-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Reviewer",
      runtimeConfig: {},
    },
  });
  await f.db.conversationMember.create({
    data: {
      workspaceId: f.workspace.id,
      agentId: agent.id,
      conversationId: f.conversation.id,
    },
  });
  const principal = { workspaceId: f.workspace.id, agentId: agent.id };
  const messages = createAgentAttachmentMessages(f.db, getMessageRequestIdempotency());
  const comments = new AttachmentComments(new PrismaAttachmentCommentStore(f.db));
  return { ...f, principal, messages, comments, target: `attachment:${f.attachment.id}` };
}
