import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("a thread unfollow leaves one record, out of the window and out of the Agent's unread", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `u${suffix}`, username: `u${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Unfollow notice", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: `helper-${suffix}`,
        displayName: "Helper",
        visibility: "public",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    await db.conversationMember.upsert({
      where: { conversationId_agentId: { conversationId: general.id, agentId: agent.id } },
      create: { workspaceId: workspace.id, conversationId: general.id, agentId: agent.id },
      update: {},
    });
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "thread root",
    });
    const repo = new PrismaDirectConversationRepository(db);
    const target = `#general:${root.id}`;
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, true);
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, false);
    // The follow already ended: a second unfollow records nothing.
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, false);
    const notices = await db.message.findMany({
      where: { conversationId: general.id, body: { startsWith: "@Helper unfollowed this thread" } },
      select: { id: true },
    });
    expect(notices).toHaveLength(1);
    // The record is in the window, but it is not something the Agent "has not read" — it wrote it
    // by leaving.
    expect(
      (await channels.open(workspace.id, user.id, general.id)).messages.map((m) => m.id),
    ).toEqual([root.id, notices[0]!.id]);
    const unread = await repo.readMessages(workspace.id, agent.id, "#general", {
      unread: true,
    });
    expect(unread.map((message) => message.id)).not.toContain(notices[0]!.id);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    redis.close();
    await db.$disconnect();
  }
});
