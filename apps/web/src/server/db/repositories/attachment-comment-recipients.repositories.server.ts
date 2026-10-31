import { canReadChannel } from "#src/server/conversations/channel-read-access.server";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import type { Prisma } from "#src/generated/prisma/client";
import type {
  AttachmentCommentAccess,
  AttachmentCommentActor,
} from "#src/server/attachments/attachment-comments.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";

/**
 * Whether an actor may read or write an attachment's comments, judged only on the file's own
 * conversation (a comment conversation's seats are never authority): the file is still attached
 * somewhere it was (messageId or a discussion started), the source is not hidden from the
 * Workspace, the actor is a Workspace member, and they may read the source — a person on a
 * channel by `canReadChannel`, on a DM as its active member; an Agent anywhere only as its
 * active member. `readOnly` says the source is closed to new comments (an app-events or other
 * non-member kind, or a DM with a deleted Agent).
 */
export async function readAccess(
  db: DatabaseScope,
  actor: AttachmentCommentActor,
  attachmentId: string,
): Promise<AttachmentCommentAccess | null> {
  const memberWhere: Prisma.ConversationMemberWhereInput = actor.userId
    ? { userId: actor.userId }
    : { agentId: actor.agentId };
  const attachment = await db.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      workspaceId: true,
      fileName: true,
      contentType: true,
      sizeBytes: true,
      conversationId: true,
      messageId: true,
      commentThread: { select: { conversationId: true } },
      conversation: {
        select: {
          channelName: true,
          visibility: true,
          kind: true,
          hiddenFromWorkspaceAt: true,
          archivedAt: true,
          members: {
            where: { OR: [memberWhere, { agent: { deletedAt: { not: null } } }] },
            select: {
              userId: true,
              agentId: true,
              leftAt: true,
              agent: { select: { deletedAt: true } },
            },
          },
        },
      },
    },
  });
  if (!attachment || attachment.workspaceId !== actor.workspaceId) return null;
  const source = attachment.conversation;
  const member = source.members.find((row) =>
    actor.userId ? row.userId === actor.userId : row.agentId === actor.agentId,
  );
  let workspaceMember = false;
  if (actor.userId)
    workspaceMember = Boolean(
      await db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
        select: { userId: true },
      }),
    );
  else
    workspaceMember = Boolean(
      await db.agent.findFirst({
        where: {
          id: actor.agentId,
          workspaceId: actor.workspaceId,
          deletedAt: null,
          owner: { memberships: { some: { workspaceId: actor.workspaceId } } },
        },
        select: { id: true },
      }),
    );
  const directVisible =
    source.channelName !== null ||
    !actor.userId ||
    Boolean(
      await db.conversation.findFirst({
        where: { id: attachment.conversationId, ...viewerDirectConversationWhere(actor.userId) },
        select: { id: true },
      }),
    );
  const activeMember = Boolean(member && member.leftAt === null);
  return {
    workspaceId: actor.workspaceId,
    attachmentId,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    sourceConversationId: attachment.conversationId,
    conversationId: attachment.commentThread?.conversationId ?? null,
    canRead:
      workspaceMember &&
      directVisible &&
      source.hiddenFromWorkspaceAt === null &&
      Boolean(attachment.messageId || attachment.commentThread) &&
      (actor.userId && source.channelName !== null
        ? canReadChannel(source, activeMember)
        : activeMember),
    activeMember,
    archived: source.archivedAt !== null,
    readOnly:
      source.kind !== null ||
      (source.channelName === null && source.members.some((row) => row.agent?.deletedAt)),
  };
}

/**
 * Who a posted comment notifies, besides its author: the attachment's uploader, everyone who
 * commented on it before (its Messages' senders — discussion seats alone count for nothing, as
 * reactions and Agent read-seats also take them), and the members this comment @-mentioned.
 * Each candidate is re-checked for read access on the SOURCE conversation, by the same rule a
 * comment read applies (`readAccess`); a "mentioned" recipient pierces the source channel's mute,
 * a "subscribed" one respects it. Mentioned wins when both apply.
 */
export async function commentRecipients(
  tx: DatabaseScope,
  scope: {
    workspaceId: string;
    attachmentId: string;
    sourceConversationId: string;
    commentConversationId: string;
    author: AttachmentCommentActor;
    uploaderId: string | null;
    uploaderAgentId: string | null;
    mentions: readonly { type: string; id: string; handle: string }[];
  },
): Promise<{
  users: Map<string, { reason: string; handle: string }>;
  agents: Map<string, string>;
}> {
  const commenterMemberIds = (
    await tx.message.groupBy({
      by: ["senderMemberId"],
      where: { conversationId: scope.commentConversationId, senderMemberId: { not: null } },
    })
  ).flatMap((row) => (row.senderMemberId ? [row.senderMemberId] : []));
  const commenters = commenterMemberIds.length
    ? await tx.conversationMember.findMany({
        where: { id: { in: commenterMemberIds } },
        select: { userId: true, agentId: true },
      })
    : [];
  const authorId = scope.author.userId ?? scope.author.agentId;
  // Candidate actor ids, uploader and prior commenters first as subscribers; mentions merge on top.
  const candidates = new Map<string, { kind: "user" | "agent"; reason: string; handle?: string }>();
  const add = (kind: "user" | "agent", id: string | null, reason: string, handle?: string) => {
    if (!id || id === authorId) return;
    if (reason === "mentioned" || !candidates.has(id)) candidates.set(id, { kind, reason, handle });
  };
  add("user", scope.uploaderId, "subscribed");
  add("agent", scope.uploaderAgentId, "subscribed");
  for (const member of commenters) {
    add("user", member.userId, "subscribed");
    add("agent", member.agentId, "subscribed");
  }
  for (const mention of scope.mentions)
    add(mention.type === "user" ? "user" : "agent", mention.id, "mentioned", mention.handle);
  if (!candidates.size) return { users: new Map(), agents: new Map() };
  const source = await tx.conversation.findUniqueOrThrow({
    where: { id: scope.sourceConversationId },
    select: { channelName: true },
  });
  // A subscribed recipient on a muted source channel is not woken; a mentioned one always is.
  // The mute lives on the recipient's source member row, whatever its leave state.
  const muted = new Set(
    source.channelName === null
      ? []
      : (
          await tx.conversationMember.findMany({
            where: {
              conversationId: scope.sourceConversationId,
              channelMuted: true,
              OR: [
                { userId: { in: [...candidates.keys()] } },
                { agentId: { in: [...candidates.keys()] } },
              ],
            },
            select: { userId: true, agentId: true },
          })
        ).map((member) => member.userId ?? member.agentId!),
  );
  const users = new Map<string, { reason: string; handle: string }>();
  const agents = new Map<string, string>();
  for (const [id, candidate] of candidates) {
    if (candidate.reason === "subscribed" && muted.has(id)) continue;
    const actor =
      candidate.kind === "user"
        ? { workspaceId: scope.workspaceId, userId: id }
        : { workspaceId: scope.workspaceId, agentId: id };
    const access = await readAccess(tx, actor, scope.attachmentId);
    if (!access?.canRead) continue;
    if (candidate.kind === "user")
      users.set(id, { reason: candidate.reason, handle: candidate.handle ?? "" });
    else agents.set(id, candidate.reason);
  }
  // A subscribed person's row needs the handle it is addressed by; mentioned ones carry it.
  const unnamed = [...users].flatMap(([id, { handle }]) => (handle ? [] : [id]));
  if (unnamed.length) {
    const names = await tx.user.findMany({
      where: { id: { in: unnamed } },
      select: { id: true, username: true },
    });
    for (const { id, username } of names) users.get(id)!.handle = username;
  }
  return { users, agents };
}
