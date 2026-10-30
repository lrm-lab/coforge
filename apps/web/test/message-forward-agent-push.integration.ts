import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentMessageDelivery, formatUtcTimestamp } from "@lrm/coforge-sdk/internal";
import { RedisClient } from "bun";

import { PrismaClient } from "#src/generated/prisma/client";
import { MessageForwards } from "#src/server/conversations/message-forwards.server";
import { publishNonMemberDeliveries } from "#src/server/conversations/non-member-deliveries.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";

/**
 * A forward pushed to an Agent the note notifies from outside the channel (a confirmed Notify)
 * carries the original after the note, as a member's delivery does.
 */

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
if (!redisUrl) throw new Error("CHANNEL_TEST_REDIS_URL must point to local Redis");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const redis = new RedisClient(redisUrl);
const suffix = crypto.randomUUID().slice(0, 8);
const pushed: Uint8Array[] = [];
const publisher = {
  publish: async (_channel: string, data: Uint8Array) => void pushed.push(data),
  publishJson: async () => {},
  broadcast: async () => {},
};

let workspaceId: string;
let alice: { id: string };
let carol: { id: string };
let product: { id: string; channelName: string | null };
let news: { id: string };

async function channel(name: string, members: { id: string }[]) {
  return db.conversation.create({
    data: {
      workspaceId,
      channelName: `${name}-${suffix}`,
      members: {
        create: members.map((user) => ({
          workspace: { connect: { id: workspaceId } },
          user: { connect: { id: user.id } },
        })),
      },
    },
  });
}

beforeAll(async () => {
  [alice, carol] = await Promise.all(
    ["alice", "carol"].map((name) =>
      db.user.create({ data: { username: `fwdp-${name}-${suffix}`, displayName: name } }),
    ),
  );
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `fwdp-${suffix}`,
        name: "Forward push",
        members: { create: [alice, carol].map((user) => ({ userId: user!.id })) },
      },
    })
  ).id;
  product = await channel("product", [alice!, carol!]);
  news = await channel("news", [alice!]);
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.computer.deleteMany({ where: { machineId: `fwdp-${suffix}` } });
  await db.user.deleteMany({ where: { username: { endsWith: `-${suffix}` } } });
  redis.close();
  await db.$disconnect();
});

test("an Agent notified outside the channel is pushed the forward's original after the note", async () => {
  const sender = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: product.id, userId: carol.id },
  });
  const { lastSequence } = await db.conversation.update({
    where: { id: product.id },
    data: { lastSequence: { increment: 1 } },
    select: { lastSequence: true },
  });
  const source = await db.message.create({
    data: {
      workspaceId,
      conversationId: product.id,
      senderMemberId: sender.id,
      body: "the original",
      sequence: lastSequence,
    },
  });
  const forwards = new MessageForwards({
    db,
    idempotency: new RedisMessageRequestIdempotency(redis),
    centrifugo: publisher,
    storage: async () => {
      throw new Error("nothing to copy");
    },
  });
  const result = await forwards.forward({
    workspaceId,
    userId: alice.id,
    requestId: crypto.randomUUID(),
    sourceMessageId: source.id,
    destinations: [news.id],
    note: "look",
  });
  const sent = result.results[0]!.status === "success" ? result.results[0].message : undefined;
  const computer = await db.computer.create({
    data: { ownerId: alice.id, machineId: `fwdp-${suffix}` },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: alice.id,
      computerId: computer.id,
      name: `fwdp-outsider-${suffix}`,
      displayName: "Outsider",
      runtimeConfig: {},
    },
  });
  const delivery = await db.agentMessageDelivery.create({
    data: {
      workspaceId,
      conversationId: news.id,
      agentId: agent.id,
      messageId: sent!.id,
      sequence: sent!.sequence,
    },
  });
  pushed.length = 0;
  await publishNonMemberDeliveries(db, publisher as never, workspaceId, [
    { deliveryId: delivery.deliveryId, agentId: agent.id, messageId: sent!.id },
  ]);
  expect(pushed).toHaveLength(1);
  expect(decodeAgentMessageDelivery(pushed[0]!).body).toBe(
    `look\n[forwarded from #${product.channelName} by @fwdp-carol-${suffix} at ${formatUtcTimestamp(source.createdAt.toISOString())}]\n> the original`,
  );
});
