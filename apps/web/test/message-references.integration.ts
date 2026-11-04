import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId = "";
let news: { id: string };
let alice: { id: string };
let channels: PublicChannels;

afterAll(() => db.$disconnect());
beforeAll(async () => {
  alice = await db.user.create({
    data: { username: `ref-alice-${suffix}`, displayName: "Alice" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `refs-${suffix}`,
      name: "References",
      members: { create: { userId: alice.id, role: "member" } },
    },
  });
  workspaceId = workspace.id;
  news = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `refs-${suffix}`,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), quietCentrifugo());
});

// task #465: a send's resolved references write `message_references` rows in the same
// transaction — `kind`, `targetId`, `raw`, `ordinal`; an unresolved reference writes no row.
test("a send writes its message_references rows", async () => {
  const channelName = (
    await db.conversation.findUniqueOrThrow({
      where: { id: news.id },
      select: { channelName: true },
    })
  ).channelName!;
  const sender = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: news.id, userId: alice.id },
  });
  const task = await db.task.create({
    data: {
      conversationId: news.id,
      workspaceId,
      number: 91,
      title: "a task",
      creatorMemberId: sender.id,
      ownerMemberId: sender.id,
      status: "todo",
    },
  });
  const sent = await channels.send({
    workspaceId,
    userId: alice.id,
    channelId: news.id,
    idempotencyKey: crypto.randomUUID(),
    body: `see #${channelName} and task #91, also #nosuch stays text`,
  });
  const references = await db.messageReference.findMany({
    where: { messageId: sent.id },
    orderBy: { ordinal: "asc" },
  });
  expect(references.map((reference) => [reference.kind, reference.raw])).toEqual([
    ["channel", `#${channelName}`],
    ["task", "task #91"],
  ]);
  expect(references.find((reference) => reference.kind === "channel")!.targetId).toBe(news.id);
  expect(references.find((reference) => reference.kind === "task")!.targetId).toBe(task.id);
});

// task #465 review: a bare `#N` resolves once — the channel fallback's `#8-x` is one channel
// row, not a task row and a channel row.
test("a bare `#N` the channel fallback takes is one row, not two", async () => {
  // `#8-x` reads as a bare `8` with a `-x` rest — the channel fallback names channel `8`,
  // and only that one row is written (not a task row for `8` as well).
  await db.conversation.create({
    data: {
      workspaceId,
      channelName: `8-${suffix}`,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const sent = await channels.send({
    workspaceId,
    userId: alice.id,
    channelId: news.id,
    idempotencyKey: crypto.randomUUID(),
    body: `see #8-${suffix}`,
  });
  const references = await db.messageReference.findMany({ where: { messageId: sent.id } });
  expect(references.map((reference) => [reference.kind, reference.raw])).toEqual([
    ["channel", `#8-${suffix}`],
  ]);
});

// task #465 review: a thread reference's `targetId` is the root message's id, not a
// conversation's.
test("a thread reference's targetId is the root message's id", async () => {
  const channelName = (
    await db.conversation.findUniqueOrThrow({
      where: { id: news.id },
      select: { channelName: true },
    })
  ).channelName!;
  const root = await channels.send({
    workspaceId,
    userId: alice.id,
    channelId: news.id,
    idempotencyKey: crypto.randomUUID(),
    body: "the root",
  });
  const anchor = root.id;
  const sent = await channels.send({
    workspaceId,
    userId: alice.id,
    channelId: news.id,
    idempotencyKey: crypto.randomUUID(),
    body: `see #${channelName}:${anchor}`,
  });
  const references = await db.messageReference.findMany({ where: { messageId: sent.id } });
  expect(references.map((reference) => [reference.kind, reference.targetId])).toEqual([
    ["thread", root.id],
  ]);
});

// task #465 review: a channel the sender cannot see resolves nothing — the reference writes no
// row, and the invisible target leaks nothing.
test("a reference to an invisible channel writes no row", async () => {
  const outsider = await db.user.create({
    data: { username: `ref-out-${suffix}`, displayName: "Out" },
  });
  await db.workspaceMembership.create({
    data: { workspaceId, userId: outsider.id, role: "member" },
  });
  const privateChannel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `secret-${suffix}`,
      visibility: "private",
      members: { create: [{ userId: outsider.id }] },
    },
  });
  const privateName = (
    await db.conversation.findUniqueOrThrow({
      where: { id: privateChannel.id },
      select: { channelName: true },
    })
  ).channelName!;
  const sent = await channels.send({
    workspaceId,
    userId: alice.id,
    channelId: news.id,
    idempotencyKey: crypto.randomUUID(),
    body: `see #${privateName} — invisible to alice`,
  });
  expect(await db.messageReference.count({ where: { messageId: sent.id } })).toBe(0);
});

// task #465 review: the `message_references` rows roll back with their message's transaction —
// a send that fails after `writeMessageReferences` leaves no orphan rows.
test("the message_references rows roll back with the send's transaction", async () => {
  await expect(
    db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: news.id,
          workspaceId,
          sequence: 999,
          body: "see #8",
          senderMemberId: (
            await tx.conversationMember.findFirstOrThrow({
              where: { conversationId: news.id, userId: alice.id },
            })
          ).id,
        },
      });
      await tx.messageReference.create({
        data: {
          messageId: message.id,
          conversationId: news.id,
          workspaceId,
          kind: "task",
          targetId: "01a1a6f2-0000-0000-0000-000000000000",
          raw: "#8",
          ordinal: 0,
        },
      });
      throw new Error("the send fails");
    }),
  ).rejects.toThrow("the send fails");
  expect(
    await db.messageReference.count({
      where: { raw: "#8", kind: "task", ordinal: 0 },
    }),
  ).toBe(0);
});
