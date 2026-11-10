import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("a channel @mention persists as a token and wakes only the mentioned Agent, including Agent-to-Agent", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Mention delivery",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const scout = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "scout",
        displayName: "Scout",
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
    const repo = new PrismaDirectConversationRepository(db);
    const agentSender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );

    const humanMention = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "@helper please triage this.",
    });
    expect(humanMention.body).toBe(`<@agent:${helper.id}> please triage this.`);
    expect(
      (await db.messageMention.findMany({ where: { messageId: humanMention.id } })).map((row) => [
        row.kind,
        row.handle,
        row.actorId,
        row.conversationId,
      ]),
    ).toEqual([["agent", "helper", helper.id, general.id]]);
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: humanMention.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([helper.id]);
    expect<string | undefined>(
      (await repo.readMessages(workspace.id, helper.id, "#general")).find(
        (message) => message.id === humanMention.id,
      )?.body,
    ).toBe("@helper please triage this.");

    const handoff = await agentSender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: "@scout please take the follow-up.",
    });
    expect(handoff.body).toBe(`<@agent:${scout.id}> please take the follow-up.`);
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: handoff.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([scout.id]);
    // Eligibility for Agent attention rests on the delivery row, not on the sender's kind, so an
    // Agent-authored handoff is admitted here and every Agent-facing projection names its author.
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, scout.id)).find(
        (message) => message.messageId === handoff.id,
      ),
    ).toMatchObject({
      latestSenderKind: "agent",
      latestSenderHandle: "helper",
      target: "#general",
    });
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, scout.id)).resumeMessages.find(
        (message) => message.messageId === handoff.id,
      ),
    ).toMatchObject({
      latestSenderKind: "agent",
      latestSenderHandle: "helper",
      target: "#general",
    });
    expect(
      (
        await (await repo.agentTargetFreshness(workspace.id, scout.id, "#general")).readPending(0)
      ).find((message) => message.id === handoff.id),
    ).toMatchObject({ senderKind: "agent", senderHandle: "helper", target: "#general" });
    expect<string | undefined>(
      (await repo.readMessages(workspace.id, scout.id, "#general")).find(
        (message) => message.id === handoff.id,
      )?.body,
    ).toBe("@scout please take the follow-up.");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("an Agent's channel message reaches other Agents without an @mention: unmuted members at the top level, followers in a thread, never the sender", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: {
      displayName: `u${crypto.randomUUID().slice(0, 8)}`,
      username: `u${crypto.randomUUID().slice(0, 8)}`,
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Agent chatter",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const agent = (name: string) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: user.id,
          computerId: computer.id,
          name,
          displayName: name,
          runtimeConfig: {},
        },
      });
    const helper = await agent("helper");
    const scout = await agent("scout");
    const quiet = await agent("quiet");
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    await channels.setAgentMuted(workspace.id, quiet.id, "#general", true);
    await channels.setAgentMuted(workspace.id, helper.id, "#general", false);
    await channels.setAgentMuted(workspace.id, scout.id, "#general", false);
    const repo = new PrismaDirectConversationRepository(db);
    const recipients = (message: { deliveries: { agentId: string }[] }) =>
      message.deliveries.map((delivery) => delivery.agentId).sort();

    // A top-level post belongs to the channel: every unmuted Agent member but the sender.
    const status = await repo.sendAgentMessage(general.id, helper.id, "Build is green.");
    expect(recipients(status)).toEqual([scout.id]);
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, scout.id)).map((row) => [
        row.messageId,
        row.latestSenderKind,
      ]),
    ).toEqual([[status.id, "agent"]]);

    // A thread reply belongs to its thread: only the followers, never the sender.
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "Who takes the release notes?",
    });
    const thread = root.id;
    const first = await repo.sendAgentMessage(general.id, helper.id, "I can.", [], thread);
    expect(recipients(first)).toEqual([]);
    const second = await repo.sendAgentMessage(general.id, scout.id, "Me too.", [], thread);
    expect(recipients(second)).toEqual([helper.id]);
    const third = await repo.sendAgentMessage(general.id, helper.id, "Split it then.", [], thread);
    expect(recipients(third)).toEqual([scout.id]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel send reports the @handles that name nobody the sender can see, and a replay reports the same", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ua${suffix}`, username: `ua${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `ub${suffix}`, username: `ub${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Unresolved mentions",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: bob.id, machineId: crypto.randomUUID() },
    });
    // A public Agent outside the channel is someone the sender can see; a private Agent of
    // another owner is not.
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: bob.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: bob.id,
        computerId: computer.id,
        name: "secret",
        displayName: "Secret",
        visibility: "private",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const triage = await channels.create(workspace.id, alice.id, `triage-${suffix}`);
    const send = {
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: triage.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@ua${suffix} @helper @ub${suffix} @ghost @secret \`@quoted\` @ghost in #triage-${suffix} <@human:00000000-0000-4000-8000-000000000000>`,
    };

    const sent = await channels.send(send);
    // The sender resolves as a member; helper and bob are Workspace members outside the channel;
    // ghost names nobody and secret is invisible to the sender; code is never a mention, and a
    // stored token (the channel reference, a typed mention token) is never read as a handle.
    expect(sent.unresolvedMentionHandles).toEqual(["ghost", "secret"]);
    expect((await channels.send(send)).unresolvedMentionHandles).toEqual(["ghost", "secret"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: bob.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel send names a member by id beside the @handles in its body, and a binding that names no member of the channel names no one", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ua${suffix}`, username: `ua${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `ub${suffix}`, username: `ub${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `uc${suffix}`, username: `uc${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Mention bindings",
      members: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    // An Agent that holds the handle of a person: the text alone can only name the Agent. Created
    // straight in the database, since Agent creation now refuses the name; this is about how a send
    // resolves such a pair, which older Agents and members who joined later can still make.
    const namesake = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: bob.username,
        displayName: "Namesake",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    const send = (
      channelId: string,
      body: string,
      mentions?: { type: "user" | "agent"; id: string; name: string }[],
    ) =>
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId,
        idempotencyKey: crypto.randomUUID(),
        body,
        mentions,
      });
    const mentioned = async (messageId: string) =>
      (await db.messageMention.findMany({ where: { messageId } }))
        .map((row) => `${row.kind}:${row.actorId}`)
        .sort();

    // The handle in the text is the Agent's; the person the sender picked is mentioned as well.
    expect(await mentioned((await send(general.id, `@${bob.username} look`)).id)).toEqual([
      `agent:${namesake.id}`,
    ]);
    const bound = await send(general.id, `@${bob.username} look`, [
      { type: "user", id: bob.id, name: bob.username },
    ]);
    expect(await mentioned(bound.id)).toEqual([`agent:${namesake.id}`, `user:${bob.id}`].sort());

    // A binding is a claim: bob's id under carol's handle, or a person who is no member of this
    // channel, names no one.
    const forged = await send(general.id, "hello", [
      { type: "user", id: bob.id, name: carol.username },
    ]);
    expect(await mentioned(forged.id)).toEqual([]);
    const solo = await channels.create(workspace.id, alice.id, `solo-${suffix}`);
    const outside = await send(solo.id, "hello", [
      { type: "user", id: bob.id, name: bob.username },
    ]);
    expect(await mentioned(outside.id)).toEqual([]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
