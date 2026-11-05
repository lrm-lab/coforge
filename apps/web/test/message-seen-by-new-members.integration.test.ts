import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { addChannelMembers } from "#src/server/conversations/channel-roster.server";
import { markPublicChannelRead } from "#src/server/conversations/channel-read.server";
import { createChannelWithMembers } from "#src/server/conversations/channel-lifecycle.server";
import { readMessageSeenBy } from "#src/server/conversations/message-seen-by.server";

/**
 * Task #549: Frank added two people to a new private channel; neither was online, yet his message
 * listed both as having seen it. "Seen" must mean the person read it, not that the read cursor a
 * join or an add starts them at happens to cover it.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
let db: PrismaClient;
let workspaceId: string;
let ports: { db: PrismaClient; inboxPurge: { purge: () => Promise<void> } };
const people: Record<"frank" | "j" | "li", string> = { frank: "", j: "", li: "" };

beforeAll(async () => {
  if (!connectionString) return;
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ports = { db, inboxPurge: { purge: async () => {} } };
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await db.workspace.create({
    data: {
      slug: `seen-${suffix}`,
      name: "Seen by new members",
      members: {
        create: (["frank", "j", "li"] as const).map((name) => ({
          role: name === "frank" ? "owner" : "member",
          user: { create: { displayName: name, username: `seen-${name}-${suffix}` } },
        })),
      },
    },
    include: { members: { include: { user: true } } },
  });
  workspaceId = workspace.id;
  for (const { user } of workspace.members)
    people[user.displayName as keyof typeof people] = user.id;
});

afterAll(async () => {
  if (!connectionString) return;
  const userIds = Object.values(people);
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
});

async function post(channelId: string, userId: string, body: string) {
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelId, userId },
    select: { id: true },
  });
  const last = await db.message.findFirst({
    where: { conversationId: channelId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return db.message.create({
    data: {
      workspaceId,
      conversationId: channelId,
      senderMemberId: member.id,
      sequence: (last?.sequence ?? 0) + 1,
      body,
    },
  });
}

const seenBy = (channelId: string, messageId: string) =>
  readMessageSeenBy(db, {
    workspaceId,
    userId: people.frank,
    conversationId: channelId,
    messageId,
  }).then((result) => result.seen.map((reader) => reader.id).sort());

test.skipIf(!connectionString)(
  "people added with the channel have not seen a message posted after they were added",
  async () => {
    const { id } = await createChannelWithMembers(ports, workspaceId, people.frank, {
      name: `support-a-${crypto.randomUUID().slice(0, 6)}`,
      visibility: "private",
      userIds: [people.j, people.li],
      agentIds: [],
    });
    const message = await post(id, people.frank, "@mali36 平台使用过程中有啥问题");
    expect(await seenBy(id, message.id)).toEqual([]);
  },
);

test.skipIf(!connectionString)(
  "people added after a message have not seen it just because they were added",
  async () => {
    const { id } = await createChannelWithMembers(ports, workspaceId, people.frank, {
      name: `support-b-${crypto.randomUUID().slice(0, 6)}`,
      visibility: "private",
      userIds: [],
      agentIds: [],
    });
    const message = await post(id, people.frank, "@mali36 平台使用过程中有啥问题");
    await addChannelMembers(ports, workspaceId, { userId: people.frank }, id, {
      userIds: [people.j, people.li],
      agentIds: [],
    });
    expect(await seenBy(id, message.id)).toEqual([]);
  },
);

test.skipIf(!connectionString)(
  "a member who was there when the message was sent and read it has seen it",
  async () => {
    const { id } = await createChannelWithMembers(ports, workspaceId, people.frank, {
      name: `support-c-${crypto.randomUUID().slice(0, 6)}`,
      visibility: "private",
      userIds: [people.j, people.li],
      agentIds: [],
    });
    const message = await post(id, people.frank, "hello");
    await markPublicChannelRead({
      db,
      authorize: async () => undefined,
      workspaceId,
      userId: people.j,
      conversationId: id,
      throughSequence: message.sequence,
    });
    expect(await seenBy(id, message.id)).toEqual([people.j]);
  },
);

test.skipIf(!connectionString)(
  "someone who left and is added back after a message counts from their latest join",
  async () => {
    const { id } = await createChannelWithMembers(ports, workspaceId, people.frank, {
      name: `support-d-${crypto.randomUUID().slice(0, 6)}`,
      visibility: "private",
      userIds: [people.j],
      agentIds: [],
    });
    // J was a member from the start, then left.
    await db.conversationMember.updateMany({
      where: { conversationId: id, userId: people.j },
      data: { leftAt: new Date() },
    });
    const message = await post(id, people.frank, "posted while J was away");
    await addChannelMembers(ports, workspaceId, { userId: people.frank }, id, {
      userIds: [people.j],
      agentIds: [],
    });
    expect(await seenBy(id, message.id)).toEqual([]);

    // Their first membership's join time is gone: the row now dates from the re-add.
    const row = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: id, userId: people.j },
      select: { joinedAt: true },
    });
    expect(row.joinedAt.getTime()).toBeGreaterThan(message.createdAt.getTime());
  },
);
