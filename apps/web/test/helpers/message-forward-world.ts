import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";

import { PrismaClient } from "#src/generated/prisma/client";
import { MessageForwards } from "#src/server/conversations/message-forwards.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { openPeopleDirectConversation } from "#src/server/conversations/user-direct-conversations.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { quietCentrifugo } from "./fake-centrifugo";

/**
 * The world the message-forward integration suites forward in: a Workspace with alice, bob and
 * carol, channels (#product with all three, #news, an archived one, #lounge with bob alone),
 * their DMs, and file storage in a temporary directory. A suite calls `forwardWorld()` once; the
 * bindings below are live, filled in by its setup.
 */
export const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
export const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
if (!redisUrl) throw new Error("CHANNEL_TEST_REDIS_URL must point to local Redis");

export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
export const redis = new RedisClient(redisUrl);
export const suffix = crypto.randomUUID().slice(0, 8);
export const publisher = quietCentrifugo();
export let storageRoot: string;
export let storage: LocalFileStorage;
export let forwards: MessageForwards;
export let channels: PublicChannels;

export let workspaceId: string;
export let alice: { id: string };
export let bob: { id: string };
export let carol: { id: string };
export let product: { id: string };
export let news: { id: string };
export let archived: { id: string };
export let lounge: { id: string };
export let dmWithBob: string;
export let dmAliceCarol: string;
export let dmBobCarol: string;

export async function channel(name: string, members: { id: string }[], archivedAt?: Date) {
  return db.conversation.create({
    data: {
      workspaceId,
      channelName: `${name}-${suffix}`,
      archivedAt,
      members: {
        create: members.map((user) => ({
          workspace: { connect: { id: workspaceId } },
          user: { connect: { id: user.id } },
        })),
      },
    },
  });
}

/** A message written straight to the table, as a server notice or a bystander's DM message is. */
export async function rawMessage(
  conversationId: string,
  senderUserId: string | null,
  body: string,
  extra: { threadRootId?: string } = {},
) {
  const { lastSequence } = await db.conversation.update({
    where: { id: conversationId },
    data: { lastSequence: { increment: 1 } },
    select: { lastSequence: true },
  });
  const sender = senderUserId
    ? await db.conversationMember.findFirstOrThrow({
        where: { conversationId, userId: senderUserId },
      })
    : undefined;
  return db.message.create({
    data: {
      workspaceId,
      conversationId,
      senderMemberId: sender?.id,
      body,
      sequence: lastSequence,
      ...extra,
    },
  });
}

export async function upload(conversationId: string, userId: string, name: string, text: string) {
  const id = crypto.randomUUID();
  const objectKey = `workspaces/${workspaceId}/attachments/${id}/original`;
  await storage.put(objectKey, new Blob([text]), "text/plain");
  return db.attachment.create({
    data: {
      id,
      workspaceId,
      conversationId,
      uploaderId: userId,
      objectKey,
      fileName: name,
      contentType: "text/plain",
      sizeBytes: text.length,
    },
  });
}

export const request = () => crypto.randomUUID();

/** Registers the world's setup and teardown in the calling test file: call it once, at its top. */
export function forwardWorld() {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "coforge-forward-"));
    storage = new LocalFileStorage(storageRoot);
    const idempotency = new RedisMessageRequestIdempotency(redis);
    forwards = new MessageForwards({
      db,
      idempotency,
      centrifugo: publisher,
      storage: async () => storage,
    });
    channels = new PublicChannels(db, idempotency, publisher);
    const users = await Promise.all(
      ["alice", "bob", "carol"].map((name) =>
        db.user.create({
          data: {
            username: `fwd-${name}-${suffix}`,
            displayName: name[0]!.toUpperCase() + name.slice(1),
          },
        }),
      ),
    );
    alice = users[0]!;
    bob = users[1]!;
    carol = users[2]!;
    const workspace = await db.workspace.create({
      data: {
        slug: `fwd-${suffix}`,
        name: "Forward",
        members: { create: users.map((user) => ({ userId: user.id })) },
      },
    });
    workspaceId = workspace.id;
    product = await channel("product", [alice, bob, carol]);
    news = await channel("news", [alice, bob]);
    archived = await channel("old", [alice, bob], new Date());
    lounge = await channel("lounge", [bob]);
    dmWithBob = (await openPeopleDirectConversation(db, workspaceId, alice.id, bob.id))
      .conversationId;
    dmAliceCarol = (await openPeopleDirectConversation(db, workspaceId, alice.id, carol.id))
      .conversationId;
    dmBobCarol = (await openPeopleDirectConversation(db, workspaceId, bob.id, carol.id))
      .conversationId;
  });

  afterAll(async () => {
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { username: { endsWith: `-${suffix}` } } });
    await rm(storageRoot, { recursive: true, force: true });
    redis.close();
    await db.$disconnect();
  });
}

/** Carol's message in #product naming bob, with an upload, which the tests forward as alice. */
export async function sourceMessage(body = `ping <@human:${bob.id}> about the plan`) {
  const file = await upload(product.id, carol.id, "plan.txt", "the plan");
  const root = await rawMessage(product.id, carol.id, body);
  await db.messageMention.create({
    data: {
      messageId: root.id,
      memberId: (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: product.id, userId: bob.id },
        })
      ).id,
      conversationId: product.id,
      workspaceId,
      kind: "user",
      actorId: bob.id,
      handle: `fwd-bob-${suffix}`,
    },
  });
  await db.attachment.update({ where: { id: file.id }, data: { messageId: root.id } });
  return { message: root, file };
}
