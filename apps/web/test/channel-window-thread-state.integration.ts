import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { setUserThreadFollowed } from "#src/server/conversations/channel-threads.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import {
  connectionString,
  errorOf,
  privateChannelFixture,
} from "./helpers/private-channel-fixture";

test("channel pages read the viewer's thread state once for their window", async () => {
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const fixture = await privateChannelFixture(connectionString);
  const { db, ws, open, closed, people } = fixture;
  const viewer = people.insider;
  const observer = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: [{ emit: "event", level: "query" }],
  });
  const channels = new PublicChannels(observer);
  const queries: string[] = [];
  observer.$on("query", ({ query }) => queries.push(query));
  const page = (cursor: { beforeSequence?: number; afterSequence?: number } = {}) =>
    channels.open(ws, viewer, open.id, { ...cursor, limit: 1 });
  const setFollowed = (rootId: string, followed: boolean) =>
    setUserThreadFollowed(
      { db, inboxPurge: { async purge() {} } },
      ws,
      viewer,
      open.id,
      rootId,
      followed,
    );
  try {
    const { id: memberId } = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: open.id, userId: viewer } },
    });
    const latestRoot = await db.message.findUniqueOrThrow({
      where: { conversationId_sequence: { conversationId: open.id, sequence: 3 } },
    });
    const latestReply = await db.message.create({
      data: {
        workspaceId: ws,
        conversationId: open.id,
        senderMemberId: memberId,
        sequence: 4,
        threadRootId: latestRoot.id,
        body: "latest reply",
      },
    });
    const roots = [
      { root: open.message, reply: open.reply },
      { root: latestRoot, reply: latestReply },
    ];
    await db.threadRead.createMany({
      data: roots.map(({ root, reply }) => ({
        memberId,
        rootMessageId: root.id,
        conversationId: open.id,
        workspaceId: ws,
        readThroughSequence: reply.sequence,
      })),
    });
    for (const { root } of roots) await setFollowed(root.id, true);

    queries.length = 0;
    const latest = await page();
    const threadStateSelects = queries.filter((query) =>
      /^SELECT\b.*\bFROM (?:"[^"]+"\.)?"thread_(reads|follows)"/s.test(query),
    );
    expect(threadStateSelects).toHaveLength(2);
    expect(latest.messages.map(({ id }) => id)).toEqual([latestRoot.id]);
    expect(latest.threadReadThrough).toEqual({ [latestRoot.id]: latestReply.sequence });
    expect(latest.followedThreadRootIds).toEqual([latestRoot.id]);
    expect(latest).toMatchObject({ hasOlder: true, hasNewer: false, senderMemberId: memberId });

    const older = await page({ beforeSequence: latestRoot.sequence });
    expect(older.messages.map(({ id }) => id)).toEqual([open.message.id]);
    expect(older).toMatchObject({ hasOlder: false, hasNewer: true });
    expect(older.threadReadThrough).toEqual({ [open.message.id]: open.reply.sequence });
    expect(older.followedThreadRootIds).toEqual([open.message.id]);
    expect(older.threads[open.message.id]).toMatchObject({
      replyCount: 1,
      lastReplySequence: open.reply.sequence,
    });
    expect(await page({ afterSequence: open.message.sequence })).toEqual(latest);
    expect(await page({ afterSequence: latestRoot.sequence })).toMatchObject({
      messages: [],
      threads: {},
      threadReadThrough: {},
      followedThreadRootIds: [],
      hasOlder: true,
      hasNewer: false,
    });

    await setFollowed(latestRoot.id, false);
    expect(await page()).toEqual({ ...latest, followedThreadRootIds: [] });

    await db.conversationMember.update({ where: { id: memberId }, data: { leftAt: new Date() } });
    const preview = await page({ beforeSequence: latestRoot.sequence });
    expect(preview.messages.map(({ id }) => id)).toEqual([open.message.id]);
    expect(preview.senderMemberId).toBe("");
    expect(preview.viewerId).toBeUndefined();
    expect(preview.threadReadThrough).toEqual({});
    expect(preview.followedThreadRootIds).toEqual([]);
    expect(preview.threads[open.message.id]?.unread).toBe(0);

    expect(await channels.open(ws, viewer, closed.id)).toMatchObject({ visibility: "private" });
    expect(await errorOf(channels.open(ws, people.outsider, closed.id))).toBe("NOT_FOUND");
    expect(await errorOf(channels.open(ws, crypto.randomUUID(), open.id))).toBe("ACCESS_DENIED");
  } finally {
    await observer.$disconnect();
    await fixture.dispose();
  }
});
