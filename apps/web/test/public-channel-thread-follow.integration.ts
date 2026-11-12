import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

test("a thread's root author starts following that thread, so later replies reach them", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({
    data: { displayName: `ra${suffix.slice(0, 8)}`, username: `ra${suffix.slice(0, 8)}` },
  });
  const bob = await db.user.create({
    data: { displayName: `rb${suffix.slice(0, 8)}`, username: `rb${suffix.slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `root-follow-${suffix}`,
      name: "Root author follow",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const channel = await channels.create(workspace.id, alice.id, "rootfollow");
    await channels.join(workspace.id, bob.id, channel.id);

    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by alice",
    });
    const followed = async (userId: string) => {
      const member = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: channel.id, userId } },
        select: { id: true },
      });
      return db.threadFollow.findUnique({
        where: { memberId_rootMessageId: { memberId: member.id, rootMessageId: root.id } },
      });
    };
    // A top-level root message on its own enrolls nobody: replies are what make a thread.
    expect(await followed(alice.id)).toBeNull();

    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: "reply by bob",
      threadRootId: root.id,
    });

    // The replier follows the thread, and so does the author of the message being replied to:
    // without that second enrollment a reply under someone's own message would never reach them,
    // because a thread reply is not a parent-channel post and notifies followers only.
    expect(await followed(bob.id)).not.toBeNull();
    expect(await followed(alice.id)).not.toBeNull();

    // An explicit unfollow is a decision: a later reply must not silently re-enroll the root
    // author back into the thread.
    await channels.setUserThreadFollowed(workspace.id, alice.id, channel.id, root.id, false);
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: channel.id,
      idempotencyKey: crypto.randomUUID(),
      body: "second reply by bob",
      threadRootId: root.id,
    });
    expect((await followed(alice.id))?.unfollowedAt).toBeInstanceOf(Date);

    // Explicitly following again clears the marker and makes the root author eligible immediately.
    await channels.setUserThreadFollowed(workspace.id, alice.id, channel.id, root.id, true);
    expect((await followed(alice.id))?.unfollowedAt).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("an Agent's explicit thread unfollow survives a later reply from another member", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `owner${suffix}`, username: `owner${suffix}` },
  });
  const replier = await db.user.create({
    data: { displayName: `reply${suffix}`, username: `reply${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `agent-unfollow-${suffix}`,
      name: "Agent unfollow",
      members: { create: [{ userId: owner.id }, { userId: replier.id }] },
    },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: `helper-${suffix}`,
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const repo = new PrismaDirectConversationRepository(db);
    const general = (await channels.list(workspace.id, owner.id))[0]!;

    const root = await repo.sendAgentMessage(general.id, agent.id, "agent root");
    const target = `#general:${root.id}`;
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, true);
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, false);
    await channels.send({
      workspaceId: workspace.id,
      userId: replier.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "ordinary human reply",
      threadRootId: root.id,
    });

    const agentMember = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_agentId: { conversationId: general.id, agentId: agent.id } },
      select: { id: true },
    });
    const unfollowed = await db.threadFollow.findUnique({
      where: { memberId_rootMessageId: { memberId: agentMember.id, rootMessageId: root.id } },
    });
    expect(unfollowed).not.toBeNull();
    expect(unfollowed?.unfollowedAt).not.toBeNull();

    // Explicitly following again also clears the marker and makes the Agent eligible immediately.
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, false);
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, true);
    expect(
      (
        await db.threadFollow.findUnique({
          where: { memberId_rootMessageId: { memberId: agentMember.id, rootMessageId: root.id } },
        })
      )?.unfollowedAt,
    ).toBeNull();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, replier.id] } } });
    redis.close();
    await db.$disconnect();
  }
});

test("an Agent's thread reply enrolls exactly the members its stored mention rows name; an @handle in code or a link label enrolls nobody", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `ea${suffix}`, username: `ea${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `eb${suffix}`, username: `eb${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `ec${suffix}`, username: `ec${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `agent-enroll-${suffix}`,
      name: "Agent reply enrollment",
      members: {
        create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }, { userId: carol.id }],
      },
    },
  });
  try {
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const repo = new PrismaDirectConversationRepository(db);
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by alice",
    });
    const reply = await repo.sendAgentMessage(
      general.id,
      helper.id,
      `@${bob.username} please look; not \`@${carol.username}\` or [ask @${carol.username}](https://example.com)`,
      undefined,
      root.id,
    );
    const followers = await db.threadFollow.findMany({
      where: { rootMessageId: root.id },
      select: { member: { select: { userId: true, agentId: true } } },
    });
    // The reply's mention rows name bob alone, and enrollment follows them: the replying Agent,
    // the root author (first reply) and bob. Carol, written only in code and in a link label,
    // is no mention and no follower.
    expect(
      (await db.messageMention.findMany({ where: { messageId: reply.id } })).map(
        (mention) => mention.actorId,
      ),
    ).toEqual([bob.id]);
    expect(followers.map(({ member }) => member.userId ?? member.agentId).sort()).toEqual(
      [alice.id, bob.id, helper.id].sort(),
    );
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a thread reply from a person or an Agent enrolls its sender, the members it mentions or binds, and the root author on the first reply", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `fa${suffix}`, username: `fa${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `fb${suffix}`, username: `fb${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `fc${suffix}`, username: `fc${suffix}` },
  });
  const dave = await db.user.create({
    data: { displayName: `fd${suffix}`, username: `fd${suffix}` },
  });
  const erin = await db.user.create({
    data: { displayName: `fe${suffix}`, username: `fe${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `reply-enroll-${suffix}`,
      name: "Thread reply enrollment",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id },
          { userId: carol.id },
          { userId: dave.id },
          { userId: erin.id },
        ],
      },
    },
  });
  try {
    const agent = (name: string) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: alice.id,
          name,
          displayName: name,
          runtimeConfig: {},
        },
      });
    const helper = await agent("helper");
    const scout = await agent("scout");
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      quietCentrifugo(),
    );
    const repo = new PrismaDirectConversationRepository(db);
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    const followers = async (rootMessageId: string) =>
      (
        await db.threadFollow.findMany({
          where: { rootMessageId },
          select: { member: { select: { userId: true, agentId: true } } },
        })
      )
        .map(({ member }) => member.userId ?? member.agentId)
        .sort();

    // A person's reply: the replier, the member it @mentions, and the root author (first reply).
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by alice",
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@${carol.username} can you look?`,
      threadRootId: root.id,
    });
    expect(await followers(root.id)).toEqual([alice.id, bob.id, carol.id].sort());

    // An Agent's later reply adds itself, the member its body @mentions and the one its
    // `--mention` binding names without the body writing the handle.
    await repo.sendAgentMessage(
      general.id,
      helper.id,
      `@${dave.username} and scout, please take this.`,
      [],
      root.id,
      [{ type: "agent", id: scout.id, name: "scout" }],
    );
    expect(await followers(root.id)).toEqual(
      [alice.id, bob.id, carol.id, dave.id, helper.id, scout.id].sort(),
    );

    // An Agent's first reply under a person's message enrolls that person too, and a person's
    // reply that mentions themself enrolls them once.
    const erinRoot = await channels.send({
      workspaceId: workspace.id,
      userId: erin.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "root by erin",
    });
    await repo.sendAgentMessage(general.id, scout.id, "On it.", [], erinRoot.id);
    await channels.send({
      workspaceId: workspace.id,
      userId: dave.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@${dave.username} noting this for myself`,
      threadRootId: erinRoot.id,
    });
    expect(await followers(erinRoot.id)).toEqual([dave.id, erin.id, scout.id].sort());
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [alice.id, bob.id, carol.id, dave.id, erin.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel member can list and unfollow Agents following a thread; a private Agent is never a channel follower", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `fa${suffix}`, username: `fa${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `fb${suffix}`, username: `fb${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `follow-agents-${suffix}`,
      name: "Following agents",
      members: {
        create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }],
      },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    // A private Agent is never an active channel member — not even in #general. It
    // cannot be @mentioned there (mentions resolve against active members), is never delivered a
    // channel reply, and so never becomes a thread follower. Only the public `helper` can appear
    // in any follower list below; `scout` is here to prove it stays absent even for its creator.
    const scout = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "scout",
        displayName: "Scout",
        visibility: "private",
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
    // The membership rule, pinned directly, so the absences below have one named cause:
    // #general enrolls every public Agent and no private one.
    expect(
      (
        await db.conversationMember.findMany({
          where: { conversationId: general.id, agentId: { in: [helper.id, scout.id] } },
          select: { agentId: true },
        })
      ).map((member) => member.agentId),
    ).toEqual([helper.id]);
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "please both take this",
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      idempotencyKey: crypto.randomUUID(),
      body: "@helper @scout please follow",
      threadRootId: root.id,
    });

    const aliceView = await channels.threadFollowingAgents(
      workspace.id,
      alice.id,
      general.id,
      root.id,
    );
    expect(aliceView.canUnfollow).toBe(true);
    expect(aliceView.agents.map((agent) => agent.id)).toEqual([helper.id]);

    const bobView = await channels.threadFollowingAgents(workspace.id, bob.id, general.id, root.id);
    expect(bobView.canUnfollow).toBe(true);
    expect(bobView.agents.map((agent) => agent.id)).toEqual([helper.id]);

    await expect(
      channels.unfollowAgentFromThread(workspace.id, bob.id, general.id, root.id, scout.id),
    ).rejects.toThrow("NOT_FOUND");

    await db.conversationMember.update({
      where: { conversationId_userId: { conversationId: general.id, userId: bob.id } },
      data: { leftAt: new Date() },
    });
    const leftView = await channels.threadFollowingAgents(
      workspace.id,
      bob.id,
      general.id,
      root.id,
    );
    expect(leftView.canUnfollow).toBe(false);
    expect(leftView.agents.map((agent) => agent.id)).toEqual([helper.id]);
    await expect(
      channels.unfollowAgentFromThread(workspace.id, bob.id, general.id, root.id, helper.id),
    ).rejects.toThrow("ACCESS_DENIED");

    expect(
      await channels.unfollowAgentFromThread(
        workspace.id,
        alice.id,
        general.id,
        root.id,
        helper.id,
      ),
    ).toEqual({ followed: false });
    // `helper` was the only follower alice could see (see the membership-rule note above), so
    // unfollowing it leaves the list empty — the private `scout` is not a hidden fallback.
    expect(
      (
        await channels.threadFollowingAgents(workspace.id, alice.id, general.id, root.id)
      ).agents.map((agent) => agent.id),
    ).toEqual([]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
