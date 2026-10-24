import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { listAgentFollowedThreads } from "#src/server/agents/agent-thread-follows.server";

/**
 * `thread list` reads every thread an Agent follows, newest follow first, in one query: only the
 * Agent's own active memberships in visible channels count.
 */
test("lists thousands of followed threads newest first, from active memberships in visible channels", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const channelCount = 100;
  const threadsPerChannel = 30;
  try {
    const owner = await db.user.create({
      data: { username: `thr-${suffix}`, displayName: "Owner" },
    });
    const workspace = await db.workspace.create({
      data: { slug: `thr-${suffix}`, name: "Threads" },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: owner.id, role: "owner" },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: `thr-${suffix.slice(0, 8)}`,
        displayName: "Threads",
        runtimeConfig: {},
      },
    });
    const other = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: `thx-${suffix.slice(0, 8)}`,
        displayName: "Other",
        runtimeConfig: {},
      },
    });
    const channels = await db.conversation.createManyAndReturn({
      data: Array.from({ length: channelCount }, (_, index) => ({
        workspaceId: workspace.id,
        channelName: `t${String(index).padStart(3, "0")}`,
        // The last channel is hidden from the Workspace.
        hiddenFromWorkspaceAt: index === channelCount - 1 ? new Date() : null,
      })),
    });
    const members = await db.conversationMember.createManyAndReturn({
      data: channels.flatMap((channel, index) => [
        {
          conversationId: channel.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          // The second channel's membership has ended.
          leftAt: index === 1 ? new Date() : null,
        },
        { conversationId: channel.id, workspaceId: workspace.id, agentId: other.id },
      ]),
    });
    const memberOf = (conversationId: string, agentId: string) =>
      members.find(
        (member) => member.conversationId === conversationId && member.agentId === agentId,
      )!;
    const base = Date.now() - 1_000_000_000;
    const roots = [];
    for (const channel of channels)
      for (let sequence = 1; sequence <= threadsPerChannel; sequence += 1)
        roots.push({
          conversationId: channel.id,
          workspaceId: workspace.id,
          senderMemberId: memberOf(channel.id, other.id).id,
          body: `root ${sequence}`,
          sequence,
          createdAt: new Date(base + sequence * 1000),
        });
    const created = await db.message.createManyAndReturn({ data: roots });
    const ordered = created.map((root, index) => ({
      root,
      followedAt: new Date(base + index * 1000),
    }));
    await db.threadFollow.createMany({
      data: ordered.flatMap(({ root, followedAt }) => [
        {
          memberId: memberOf(root.conversationId, agent.id).id,
          rootMessageId: root.id,
          conversationId: root.conversationId,
          workspaceId: workspace.id,
          createdAt: followedAt,
        },
        {
          memberId: memberOf(root.conversationId, other.id).id,
          rootMessageId: root.id,
          conversationId: root.conversationId,
          workspaceId: workspace.id,
          createdAt: followedAt,
        },
      ]),
    });

    const started = performance.now();
    const threads = await listAgentFollowedThreads(db, workspace.id, agent.id);
    const elapsedMs = performance.now() - started;
    console.log(
      `listAgentFollowedThreads: ${threads.length} threads from ${channelCount * threadsPerChannel} follows in ${elapsedMs.toFixed(1)} ms`,
    );

    // Everything except the left channel's and the hidden channel's threads.
    expect(threads).toHaveLength((channelCount - 2) * threadsPerChannel);
    const times = threads.map((thread) => thread.followedAt);
    expect(times).toEqual([...times].sort().reverse());
    const newest = ordered
      .filter(({ root }) => root.conversationId === channels[channelCount - 2]!.id)
      .at(-1)!;
    expect(threads[0]).toEqual({
      target: `#${channels[channelCount - 2]!.channelName}:${newest.root.id.slice(0, 13)}`,
      parentChannel: `#${channels[channelCount - 2]!.channelName}`,
      rootMessageId: newest.root.id,
      followedAt: newest.followedAt.toISOString(),
    });
    expect(threads.some((thread) => thread.parentChannel === "#t001")).toBe(false);
    expect(threads.some((thread) => thread.parentChannel === `#t${channelCount - 1}`)).toBe(false);
  } finally {
    await db.$disconnect();
  }
});
