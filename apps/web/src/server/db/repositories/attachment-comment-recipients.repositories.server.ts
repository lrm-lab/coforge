import { canReadChannel } from "#src/server/conversations/channel-read-access.server";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import type {
  AttachmentCommentAccess,
  AttachmentCommentActor,
  AttachmentCommentAudience,
} from "#src/server/attachments/attachment-comments.server";
import { conversationMentionables } from "#src/server/conversations/channel-mentionables.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";

type ActorKey = `user:${string}` | `agent:${string}`;
const keyOf = (kind: "user" | "agent", id: string): ActorKey => `${kind}:${id}`;
const actorKey = (actor: AttachmentCommentActor): ActorKey =>
  actor.userId ? keyOf("user", actor.userId) : keyOf("agent", actor.agentId!);
const actorOf = (
  workspaceId: string,
  kind: "user" | "agent",
  id: string,
): AttachmentCommentActor =>
  kind === "user" ? { workspaceId, userId: id } : { workspaceId, agentId: id };

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
  return (await readAccessAmong(db, [actor], attachmentId))?.get(actorKey(actor)) ?? null;
}

/**
 * `readAccess` for several actors of one Workspace at once, in a fixed number of reads (and one
 * per person on a DM) rather than a few per actor: keyed `user:<id>` / `agent:<id>`, or null
 * when the attachment is not the Workspace's.
 */
async function readAccessAmong(
  db: DatabaseScope,
  actors: readonly AttachmentCommentActor[],
  attachmentId: string,
): Promise<Map<ActorKey, AttachmentCommentAccess> | null> {
  const workspaceId = actors[0]?.workspaceId;
  if (!workspaceId || actors.some((actor) => actor.workspaceId !== workspaceId)) return null;
  const userIds = actors.flatMap((actor) => (actor.userId ? [actor.userId] : []));
  const agentIds = actors.flatMap((actor) => (actor.agentId ? [actor.agentId] : []));
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
            where: {
              OR: [
                { userId: { in: userIds } },
                { agentId: { in: agentIds } },
                { agent: { deletedAt: { not: null } } },
              ],
            },
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
  if (!attachment || attachment.workspaceId !== workspaceId) return null;
  const source = attachment.conversation;
  // One after another: `db` may be a transaction, which runs one query at a time.
  const memberships = userIds.length
    ? await db.workspaceMembership.findMany({
        where: { workspaceId, userId: { in: userIds } },
        select: { userId: true },
      })
    : [];
  const agents = agentIds.length
    ? await db.agent.findMany({
        where: {
          id: { in: agentIds },
          workspaceId,
          deletedAt: null,
          owner: { memberships: { some: { workspaceId } } },
        },
        select: { id: true },
      })
    : [];
  const workspaceMembers = new Set<ActorKey>([
    ...memberships.map(({ userId }) => keyOf("user", userId)),
    ...agents.map(({ id }) => keyOf("agent", id)),
  ]);
  // A DM is visible to a person only while `viewerDirectConversationWhere` keeps it in their list:
  // one read per person, of the few a DM has.
  const directHidden = new Set<string>();
  if (source.channelName === null)
    for (const userId of userIds)
      if (
        !(await db.conversation.findFirst({
          where: { id: attachment.conversationId, ...viewerDirectConversationWhere(userId) },
          select: { id: true },
        }))
      )
        directHidden.add(userId);
  const attached = Boolean(attachment.messageId || attachment.commentThread);
  const readOnly =
    source.kind !== null ||
    (source.channelName === null && source.members.some((row) => row.agent?.deletedAt));
  const access = new Map<ActorKey, AttachmentCommentAccess>();
  for (const actor of actors) {
    const member = source.members.find((row) =>
      actor.userId ? row.userId === actor.userId : row.agentId === actor.agentId,
    );
    const activeMember = Boolean(member && member.leftAt === null);
    access.set(actorKey(actor), {
      workspaceId,
      attachmentId,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      sourceConversationId: attachment.conversationId,
      conversationId: attachment.commentThread?.conversationId ?? null,
      canRead:
        workspaceMembers.has(actorKey(actor)) &&
        !(actor.userId && directHidden.has(actor.userId)) &&
        source.hiddenFromWorkspaceAt === null &&
        attached &&
        (actor.userId && source.channelName !== null
          ? canReadChannel(source, activeMember)
          : activeMember),
      activeMember,
      archived: source.archivedAt !== null,
      readOnly,
    });
  }
  return access;
}

/** Of `actors`, those who may read the attachment's comments (`readAccess`), by `ActorKey`. */
async function readersAmong(
  db: DatabaseScope,
  actors: readonly AttachmentCommentActor[],
  attachmentId: string,
): Promise<Set<ActorKey>> {
  const access = await readAccessAmong(db, actors, attachmentId);
  return new Set([...(access ?? [])].flatMap(([key, { canRead }]) => (canRead ? [key] : [])));
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
    commentConversationId: string | null;
    author: AttachmentCommentActor;
    uploaderId: string | null;
    uploaderAgentId: string | null;
    mentions: readonly { type: string; id: string; handle: string }[];
  },
): Promise<{
  users: Map<string, { reason: string; handle: string }>;
  agents: Map<string, string>;
}> {
  // No discussion yet means no one has commented. Every comment message carries this
  // attachment's `attachment_comments` row — the mark that finds its senders whatever
  // conversation the discussion lives in.
  const commenterMemberIds = scope.commentConversationId
    ? (
        await tx.message.groupBy({
          by: ["senderMemberId"],
          where: {
            conversationId: scope.commentConversationId,
            senderMemberId: { not: null },
            attachmentComment: { attachmentId: scope.attachmentId },
          },
        })
      ).flatMap((row) => (row.senderMemberId ? [row.senderMemberId] : []))
    : [];
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
  const woken = [...candidates].filter(
    ([id, candidate]) => candidate.reason === "mentioned" || !muted.has(id),
  );
  const readers = await readersAmong(
    tx,
    woken.map(([id, candidate]) => actorOf(scope.workspaceId, candidate.kind, id)),
    scope.attachmentId,
  );
  const users = new Map<string, { reason: string; handle: string }>();
  const agents = new Map<string, string>();
  for (const [id, candidate] of woken) {
    if (!readers.has(keyOf(candidate.kind, id))) continue;
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

/**
 * Who a comment on this attachment can name and who it already notifies, for the comment field,
 * by the rules a posted comment is held to. `members` are the active members of the file's own
 * conversation, among whom a comment's `@handle`s resolve (`channelMentionTargets`); a mention
 * notifies one, whatever their mute, when they `read` its comments. `subscribed` are those
 * `commentRecipients` wakes for a comment that names no one. The viewer is among the members
 * (they also resolve a stored mention of the viewer) and never subscribed.
 */
export async function commentAudience(
  db: PrismaClient,
  viewer: { workspaceId: string; userId: string },
  access: AttachmentCommentAccess,
): Promise<AttachmentCommentAudience> {
  const { workspaceId } = viewer;
  const [attachment, directory] = await Promise.all([
    db.attachment.findUniqueOrThrow({
      where: { id: access.attachmentId },
      select: { uploaderId: true, uploaderAgentId: true },
    }),
    conversationMentionables(db, workspaceId, viewer.userId, access.sourceConversationId),
  ]);
  const [readers, recipients] = await Promise.all([
    readersAmong(
      db,
      directory.map((member) => actorOf(workspaceId, member.kind, member.id)),
      access.attachmentId,
    ),
    commentRecipients(db, {
      workspaceId,
      attachmentId: access.attachmentId,
      sourceConversationId: access.sourceConversationId,
      commentConversationId: access.conversationId,
      author: viewer,
      uploaderId: attachment.uploaderId,
      uploaderAgentId: attachment.uploaderAgentId,
      mentions: [],
    }),
  ]);
  const members = directory.map((member) => ({
    ...member,
    reads: readers.has(keyOf(member.kind, member.id)),
  }));
  const subscribed = [
    ...[...recipients.users.keys()].map((id) => ({ kind: "user" as const, id })),
    ...[...recipients.agents.keys()].map((id) => ({ kind: "agent" as const, id })),
  ];
  // A subscriber need not be a member (one who left, or reads a public channel from outside).
  const labels = new Map<ActorKey, string>(
    members.map((member) => [keyOf(member.kind, member.id), member.label]),
  );
  const unlabelled = (kind: "user" | "agent") =>
    subscribed.flatMap((actor) =>
      actor.kind === kind && !labels.has(keyOf(kind, actor.id)) ? [actor.id] : [],
    );
  const [userIds, agentIds] = [unlabelled("user"), unlabelled("agent")];
  if (userIds.length)
    for (const user of await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true },
    }))
      labels.set(keyOf("user", user.id), humanLabel(user));
  if (agentIds.length)
    for (const agent of await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true, displayName: true },
    }))
      labels.set(keyOf("agent", agent.id), agent.displayName?.trim() || agent.name);
  return {
    viewerId: viewer.userId,
    members,
    subscribed: subscribed.map((actor) => ({
      ...actor,
      label: labels.get(keyOf(actor.kind, actor.id)) ?? "",
    })),
  };
}
