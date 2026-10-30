import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

/** What a channel send reads of the channel's members, a person's and an Agent's, in a channel far
 * larger than the members a message names. Moved from `public-channel.integration.ts`. */

function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}

test("a channel send reads only the members its @handles name, however large the channel", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const sender = await db.user.create({
    data: { displayName: `big-sender-${suffix}`, username: `big-sender-${suffix}` },
  });
  const reviewer = await db.user.create({
    data: { displayName: `big-reviewer-${suffix}`, username: `big-reviewer-${suffix}` },
  });
  await db.user.createMany({
    data: Array.from({ length: 200 }, (_, index) => ({
      username: `big-${index}-${suffix}`,
      displayName: `big-${index}-${suffix}`,
    })),
  });
  const crowd = await db.user.findMany({
    where: { username: { endsWith: `-${suffix}`, startsWith: "big-" } },
    select: { id: true },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `big-${suffix}`,
      name: "Large channel",
      members: { create: crowd.map(({ id }) => ({ userId: id })) },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: sender.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: sender.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    let memberRowsRead = 0;
    const counted = db.$extends({
      query: {
        conversationMember: {
          async findMany({ args, query }) {
            const rows = await query(args);
            memberRowsRead += rows.length;
            return rows;
          },
        },
      },
    }) as unknown as PrismaClient;
    const channels = new PublicChannels(
      counted,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, sender.id))[0]!;
    const send = (body: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId: sender.id,
        channelId: general.id,
        idempotencyKey: crypto.randomUUID(),
        body,
      });

    memberRowsRead = 0;
    const plain = await send("An ordinary update with no mentions.");
    expect(plain.body).toBe("An ordinary update with no mentions.");
    // Only the one Agent member the undirected message is delivered to.
    expect(memberRowsRead).toBeLessThanOrEqual(1);

    memberRowsRead = 0;
    const mentioned = await send(
      `@helper and @${reviewer.username} please look; @nobody-${suffix} is not here.`,
    );
    expect(mentioned.body).toBe(
      `<@agent:${helper.id}> and <@human:${reviewer.id}> please look; @nobody-${suffix} is not here.`,
    );
    expect(
      (await db.messageMention.findMany({ where: { messageId: mentioned.id } }))
        .map((row) => [row.kind, row.actorId])
        .sort(),
    ).toEqual([
      ["agent", helper.id],
      ["user", reviewer.id],
    ]);
    expect(memberRowsRead).toBeLessThanOrEqual(2);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: sender.id } });
    await db.user.deleteMany({ where: { username: { endsWith: `-${suffix}` } } });
    await db.$disconnect();
    redis.close();
  }
});

test("an Agent's channel send reads only its own member row and the members it names, however large the channel", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `abig-owner-${suffix}`, username: `abig-owner-${suffix}` },
  });
  const reviewer = await db.user.create({
    data: { displayName: `abig-reviewer-${suffix}`, username: `abig-reviewer-${suffix}` },
  });
  await db.user.createMany({
    data: Array.from({ length: 200 }, (_, index) => ({
      username: `abig-${index}-${suffix}`,
      displayName: `abig-${index}-${suffix}`,
    })),
  });
  const crowd = await db.user.findMany({
    where: { username: { endsWith: `-${suffix}`, startsWith: "abig-" } },
    select: { id: true },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `abig-${suffix}`,
      name: "Large channel",
      members: { create: crowd.map(({ id }) => ({ userId: id })) },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: crypto.randomUUID() },
    });
    const agent = (name: string) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: owner.id,
          computerId: computer.id,
          name,
          displayName: name,
          runtimeConfig: {},
        },
      });
    const helper = await agent("helper");
    const scout = await agent("scout");
    await enrollGeneral(db, workspace.id);
    const general = await db.conversation.findFirstOrThrow({
      where: { workspaceId: workspace.id, channelName: "general" },
    });
    // Every conversation member row the send reads, whether as a top-level query or as the
    // `members` relation of the conversation it loads.
    let memberRowsRead = 0;
    const counted = db.$extends({
      query: {
        conversation: {
          async findUnique({ args, query }) {
            const row = await query(args);
            const members = (row as { members?: unknown[] } | null)?.members;
            if (members) memberRowsRead += members.length;
            return row;
          },
        },
        conversationMember: {
          async findMany({ args, query }) {
            const rows = await query(args);
            memberRowsRead += rows.length;
            return rows;
          },
          async findFirst({ args, query }) {
            const row = await query(args);
            if (row) memberRowsRead += 1;
            return row;
          },
          async findUnique({ args, query }) {
            const row = await query(args);
            if (row) memberRowsRead += 1;
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;
    const repo = new PrismaDirectConversationRepository(counted);

    memberRowsRead = 0;
    const plain = await repo.sendAgentMessage(general.id, helper.id, "A plain status update.");
    expect(plain.body).toBe("A plain status update.");
    // The sending Agent's own member row.
    expect(memberRowsRead).toBeLessThanOrEqual(1);

    memberRowsRead = 0;
    const named = await repo.sendAgentMessage(
      general.id,
      helper.id,
      `@scout and @${reviewer.username} please look; @nobody-${suffix} is not here.`,
    );
    expect(named.body).toBe(
      `<@agent:${scout.id}> and <@human:${reviewer.id}> please look; @nobody-${suffix} is not here.`,
    );
    expect(named.deliveries.map((delivery) => delivery.agentId)).toEqual([scout.id]);
    expect(memberRowsRead).toBeLessThanOrEqual(3);

    // A `--mention` binding resolves even when the body never writes the handle.
    memberRowsRead = 0;
    const bound = await repo.sendAgentMessage(
      general.id,
      helper.id,
      "Handing this over.",
      [],
      undefined,
      [{ type: "agent", id: scout.id, name: "scout" }],
    );
    expect(bound.deliveries.map((delivery) => delivery.agentId)).toEqual([scout.id]);
    expect(
      (await db.messageMention.findMany({ where: { messageId: bound.id } })).map((row) => [
        row.kind,
        row.actorId,
      ]),
    ).toEqual([["agent", scout.id]]);
    expect(memberRowsRead).toBeLessThanOrEqual(3);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { username: { endsWith: `-${suffix}` } } });
    await db.$disconnect();
  }
});
