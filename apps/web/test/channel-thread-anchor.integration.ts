import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { RedisClient } from "bun";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { readAgentMessages } from "#src/server/agents/agent-messages.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("a channel thread read resolves a short root anchor its replies share", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `sa${suffix.slice(0, 8)}`, username: `sa${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `anchor-${suffix}`,
      name: "Anchor collision",
      members: { create: { userId: alice.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "reader",
        displayName: "Reader",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = await channels.create(workspace.id, alice.id, "anchors");
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: general.id, agentId: agent.id },
    });
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "thread root",
    });
    const reply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "quiet before follow",
      threadRootId: root.id,
    });
    // UUIDv7 ids minted in the same ~65-second window share their first eight hex
    // characters; the anchor must still name the root alone.
    expect(reply.id.slice(0, 8)).toBe(root.id.slice(0, 8));
    const repo = new PrismaDirectConversationRepository(db);
    const scope = { workspaceId: workspace.id, agentId: agent.id };
    const thread = await readAgentMessages(repo, scope, `#anchors:${root.id.slice(0, 8)}`, {});
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages.map((message) => message.body)).toContain("quiet before follow");
    const anchor = root.id.slice(0, 8);
    const parentPage = await readAgentMessages(repo, scope, "#anchors", { around: anchor });
    expect(parentPage.messages.map((message) => message.id)).toContain(root.id);
    const threadPage = await readAgentMessages(repo, scope, `#anchors:${root.id}`, {
      around: anchor,
    });
    expect(threadPage.messages).toHaveLength(1);
    expect(threadPage.messages.map((message) => message.body)).toContain("quiet before follow");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.delete({ where: { id: alice.id } });
    await db.$disconnect();
    redis.close();
  }
});
