import type { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { seedChannel } from "./activity-inbox-e2e";

/**
 * Four Activity rows for the viewer, reset on every run: an unread channel with a thread the
 * viewer is mentioned in (so a channel row and a thread row, three new messages in the channel),
 * and a second channel and thread read to the end. All of them carry `e2e-keys` in their text.
 */
export async function seedActivityKeys(db: PrismaClient, workspaceId: string) {
  const unread = await seedChannel(db, {
    workspaceId,
    key: "e2e-keys:unread:",
    channelName: "e2e-keys-design",
    root: "e2e-keys thread about the launch",
    reply: `<@human:${DEV_BROWSER_USER.id}> can you look at the launch copy`,
    newest: { key: "newest", body: "e2e-keys the draft is ready" },
    mention: "reply",
  });
  const peer = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: unread.channelId, NOT: { userId: DEV_BROWSER_USER.id } },
  });
  for (const [index, body] of ["e2e-keys one more thing", "e2e-keys and another"].entries())
    await db.message.create({
      data: {
        conversationId: unread.channelId,
        workspaceId,
        senderMemberId: peer.id,
        sequence: 4 + index,
        body,
      },
    });
  const read = await seedChannel(db, {
    workspaceId,
    key: "e2e-keys:read:",
    channelName: "e2e-keys-ops",
    root: "e2e-keys thread about the rota",
    reply: "e2e-keys swapped the Friday slots",
    newest: { key: "newest", body: "e2e-keys rota is final" },
    mention: "newest",
  });
  await db.conversationMember.update({
    where: { id: read.viewer.id },
    data: { readThroughSequence: 3 },
  });
  await db.messageMention.deleteMany({ where: { conversationId: read.channelId } });
  await db.threadRead.create({
    data: {
      memberId: read.viewer.id,
      rootMessageId: read.rootId,
      conversationId: read.channelId,
      workspaceId,
      readThroughSequence: 2,
    },
  });
  return { unread, read };
}
