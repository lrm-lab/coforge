import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { firstUnreadOnOpen } from "#src/server/conversations/conversation-open.server";

/**
 * Where a pane's "New messages" divider goes when it opens (task #378), against real PostgreSQL:
 * the first message someone else wrote past the viewer's cursor, in a channel, a DM and a thread,
 * by the rule the badge and Activity count with.
 */
test("the open read names the first unread message of a channel, a DM and a thread", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const [viewer, peer, outsider] = await Promise.all(
    ["viewer", "peer", "outsider"].map((name) =>
      db.user.create({
        data: { displayName: `${name}-${suffix}`, username: `${name}-${suffix}` },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Open read",
      members: { create: [viewer!, peer!, outsider!].map((user) => ({ userId: user.id })) },
    },
  });
  const workspaceId = workspace.id;
  try {
    /** A conversation of the viewer and the peer, the viewer having read through `readThrough`. */
    const seed = async (
      conversation: { channelName: string } | { directKey: string },
      readThrough: number,
    ) => {
      const { id } = await db.conversation.create({ data: { workspaceId, ...conversation } });
      const [mine, theirs] = await Promise.all(
        [viewer!, peer!].map((user) =>
          db.conversationMember.create({
            data: {
              conversationId: id,
              workspaceId,
              userId: user.id,
              readThroughSequence: user === viewer ? readThrough : 0,
            },
          }),
        ),
      );
      let sequence = 0;
      const post = async (from: "viewer" | "peer" | "system", threadRootId?: string) =>
        db.message.create({
          data: {
            conversationId: id,
            workspaceId,
            sequence: (sequence += 1),
            body: `${from} ${sequence}`,
            senderMemberId: from === "system" ? null : (from === "viewer" ? mine : theirs)!.id,
            threadRootId: threadRootId ?? null,
          },
          select: { id: true, sequence: true },
        });
      return { id, member: mine!, post };
    };
    const open = (conversationId: string, threadRootId?: string, userId = viewer!.id) =>
      firstUnreadOnOpen(db, { workspaceId, userId, conversationId, threadRootId });

    // A channel read through 1: the viewer's own message and a system notice past the cursor are
    // not unread; the peer's message after them is where the divider goes.
    const channel = await seed({ channelName: `open-${suffix}` }, 1);
    await channel.post("peer");
    await channel.post("viewer");
    await channel.post("system");
    const first = await channel.post("peer");
    await channel.post("peer");
    expect(await open(channel.id)).toEqual(first);

    // A thread reply is not the channel's unread.
    const read = await seed({ channelName: `read-${suffix}` }, 2);
    const root = await read.post("peer");
    await read.post("peer");
    await read.post("peer", root.id);
    expect(await open(read.id)).toBeNull();

    // A thread the viewer never read has no cursor and so no divider; once read through its first
    // reply, the peer's next reply is where it goes, past the viewer's own.
    expect(await open(read.id, root.id)).toBeNull();
    await db.threadRead.create({
      data: {
        memberId: read.member.id,
        rootMessageId: root.id,
        conversationId: read.id,
        workspaceId,
        readThroughSequence: 3,
      },
    });
    expect(await open(read.id, root.id)).toBeNull();
    await read.post("viewer", root.id);
    const reply = await read.post("peer", root.id);
    expect(await open(read.id, root.id)).toEqual(reply);

    // Marked unread at a message already read: the divider goes there, as the badge counts.
    await db.conversationMember.update({
      where: { id: read.member.id },
      data: { unreadFromSequence: root.sequence },
    });
    expect(await open(read.id)).toEqual(root);

    // A DM between the two people, by the same rule.
    const direct = await seed({ directKey: peopleDirectKey(viewer!.id, peer!.id) }, 0);
    await direct.post("viewer");
    const dm = await direct.post("peer");
    expect(await open(direct.id)).toEqual(dm);

    // Someone not in the conversation, or no longer in it, has no divider there.
    expect(await open(channel.id, undefined, outsider!.id)).toBeNull();
    await db.conversationMember.update({
      where: { id: channel.member.id },
      data: { leftAt: new Date() },
    });
    expect(await open(channel.id)).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({
      where: { id: { in: [viewer!.id, peer!.id, outsider!.id] } },
    });
    await db.$disconnect();
  }
});
