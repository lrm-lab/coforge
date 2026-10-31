import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { seededUuid } from "./browser-e2e";
import { announceMessage } from "#src/server/conversations/conversation-activity.server";
import type { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { rowItems } from "./activity-inbox-e2e";

/** The seeded rows' key prefix: the channels, their peer and their messages (task #358). */
export const key = "e2e-activity-open-unread:";

/** The divider sits after message `before` and before message `after` in the pane. */
export function dividerBetween(before: string, after: string) {
  return `(() => {
    const divider = document.querySelector('[role="separator"][aria-label="New messages"]');
    const rows = [${JSON.stringify(before)}, ${JSON.stringify(after)}].map((id) => document.getElementById("message-" + id));
    if (!divider || !rows[0] || !rows[1]) return false;
    return Boolean(rows[0].compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      Boolean(divider.compareDocumentPosition(rows[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
  })()`;
}

/** Message `id`'s row lies wholly inside the visible part of the conversation's history. */
export function inView(id: string) {
  return `(() => {
    const history = document.querySelector('[data-scroll-restoration-id^="conversation-"]');
    const row = document.getElementById("message-" + ${JSON.stringify(id)});
    if (!history || !row) return false;
    const box = history.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.top >= box.top && rect.bottom <= box.bottom;
  })()`;
}

/** The Activity row whose text includes `text`, or null. */
export function row(text: string) {
  return `([...document.querySelectorAll(${rowItems})].find((item) => item.textContent.includes(${JSON.stringify(text)}))?.textContent ?? null)`;
}

/**
 * A channel of the viewer and the peer, emptied and filled with `messages` (sequence 1 on), the
 * viewer having read through `readThrough`. A message names its sender, `viewer` or `peer`, and its
 * thread root's index when it is a reply.
 */
export async function seedChannel(
  db: PrismaClient,
  workspaceId: string,
  name: string,
  readThrough: number,
  messages: { from: "viewer" | "peer"; body: string; rootIndex?: number }[],
) {
  const peer = await db.user.upsert({
    where: { id: seededUuid(`${key}peer`) },
    update: {},
    create: {
      id: seededUuid(`${key}peer`),
      username: "e2e-open-unread-peer",
      displayName: "Open Unread Peer",
    },
  });
  await db.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId, userId: peer.id } },
    update: {},
    create: { workspaceId, userId: peer.id },
  });
  const channelId = seededUuid(`${key}${name}`);
  await db.conversation.upsert({
    where: { id: channelId },
    update: { archivedAt: null },
    create: { id: channelId, workspaceId, channelName: name },
  });
  await db.message.deleteMany({ where: { conversationId: channelId } });
  const [viewer, other] = await Promise.all(
    [DEV_BROWSER_USER.id, peer.id].map((userId) =>
      db.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: channelId, userId } },
        update: {
          leftAt: null,
          hiddenAt: null,
          readThroughSequence: readThrough,
          doneThroughSequence: null,
          unreadFromSequence: null,
        },
        create: {
          conversationId: channelId,
          workspaceId,
          userId,
          readThroughSequence: readThrough,
        },
      }),
    ),
  );
  const ids = messages.map((_, index) => seededUuid(`${key}${name}:${index}`));
  for (const [index, message] of messages.entries())
    await db.message.create({
      data: {
        id: ids[index]!,
        conversationId: channelId,
        workspaceId,
        sequence: index + 1,
        body: message.body,
        senderMemberId: (message.from === "viewer" ? viewer : other)!.id,
        threadRootId: message.rootIndex === undefined ? null : ids[message.rootIndex]!,
      },
    });
  return { channelId, viewer: viewer!, ids };
}

/** The peer's message `body` at `sequence` in channel `channelId`, announced as a live send is. */
export async function postLive(
  db: PrismaClient,
  realtime: CentrifugoConversationRealtime,
  message: { channelId: string; workspaceId: string; sequence: number; body: string },
) {
  const { channelId, workspaceId, sequence, body } = message;
  // A new id each run: Centrifugo drops a publication whose idempotency key (the message id) it
  // saw minutes ago, so a rerun's messages would never reach the stream.
  const id = crypto.randomUUID();
  const peer = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelId, userId: { not: DEV_BROWSER_USER.id } },
  });
  await db.message.create({
    data: { id, conversationId: channelId, workspaceId, sequence, body, senderMemberId: peer.id },
  });
  await announceMessage(db, realtime, {
    conversationId: channelId,
    messageId: id,
    sequence,
    workspaceId,
  });
  return id;
}
