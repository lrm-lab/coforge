import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  listAgentWorkspaceChannels,
  listWorkspaceComputers,
} from "#src/server/agents/agent-workspace-roster.server";

/**
 * `workspace info --channels` reads every channel with the calling Agent's membership and each
 * channel's newest message in two queries, however many channels the Workspace has.
 */
test("lists hundreds of channels with membership, mute, archive and last post in two reads", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const channelCount = 400;
  try {
    const user = await db.user.create({
      data: { username: `roster-${suffix}`, displayName: "Roster" },
    });
    const workspace = await db.workspace.create({
      data: { slug: `roster-${suffix}`, name: "Roster" },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "owner" },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: `roster-${suffix.slice(0, 8)}`,
        displayName: "Roster",
        runtimeConfig: {},
      },
    });
    const conversations = await db.conversation.createManyAndReturn({
      data: Array.from({ length: channelCount }, (_, index) => ({
        workspaceId: workspace.id,
        channelName: `c${String(index).padStart(3, "0")}`,
        description: index === 0 ? "First." : "",
        archivedAt: index === 1 ? new Date() : null,
      })),
    });
    const byName = new Map(
      conversations.map((conversation) => [conversation.channelName, conversation]),
    );
    const human = await db.conversationMember.createManyAndReturn({
      data: conversations.map((conversation) => ({
        conversationId: conversation.id,
        workspaceId: workspace.id,
        userId: user.id,
      })),
    });
    const humanIn = new Map(human.map((member) => [member.conversationId, member.id]));
    // The Agent joined every second channel; c000 muted, c002 as channel admin.
    await db.conversationMember.createMany({
      data: conversations
        .filter((_, index) => index % 2 === 0)
        .map((conversation) => ({
          conversationId: conversation.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          channelMuted: conversation.channelName === "c000",
          channelRole: conversation.channelName === "c002" ? "admin" : "member",
        })),
    });
    // Messages in every channel but c003; the newest of c000 is the one to report.
    const newest = new Date("2026-09-07T10:00:00.000Z");
    let batch: {
      conversationId: string;
      workspaceId: string;
      senderMemberId: string;
      body: string;
      sequence: number;
      createdAt: Date;
    }[] = [];
    for (const conversation of conversations) {
      if (conversation.channelName === "c003") continue;
      for (const sequence of [1, 2, 3])
        batch.push({
          conversationId: conversation.id,
          workspaceId: workspace.id,
          senderMemberId: humanIn.get(conversation.id)!,
          body: `m${sequence}`,
          sequence,
          createdAt: new Date(newest.getTime() - (3 - sequence) * 60_000),
        });
    }
    await db.message.createMany({ data: batch });
    batch = [];

    const started = performance.now();
    const channels = await listAgentWorkspaceChannels(db, workspace.id, agent.id, "member");
    const elapsedMs = performance.now() - started;
    console.log(
      `listAgentWorkspaceChannels: ${channelCount} channels in ${elapsedMs.toFixed(1)} ms`,
    );

    expect(channels).toHaveLength(channelCount);
    expect(channels.map((channel) => channel.name)).toEqual(
      [...byName.keys()].sort().map((name) => `#${name}`),
    );
    const named = (name: string) => channels.find((channel) => channel.name === name)!;
    expect(named("#c000")).toMatchObject({
      description: "First.",
      joined: true,
      muted: true,
      archived: false,
      channelRole: "member",
      lastPostAt: newest.toISOString(),
    });
    expect(named("#c001")).toMatchObject({ joined: false, archived: true });
    expect(named("#c002")).toMatchObject({
      joined: true,
      channelRole: "admin",
      channelAdminBasis: "channel_role",
    });
    expect(named("#c003")).toMatchObject({ joined: false, lastPostAt: null });
    expect(named("#c004").channelAdminBasis).toBeUndefined();
    expect(channels.filter((channel) => channel.joined)).toHaveLength(channelCount / 2);
    // An owner administers every channel by server role, whether or not it has joined.
    const asOwner = await listAgentWorkspaceChannels(db, workspace.id, agent.id, "owner");
    expect(asOwner.every((channel) => channel.channelAdminBasis !== undefined)).toBe(true);
    expect(asOwner.find((channel) => channel.name === "#c002")?.channelAdminBasis).toBe(
      "server_role",
    );
    expect(elapsedMs).toBeLessThan(2000);

    expect(await listWorkspaceComputers(db, workspace.id)).toEqual([]);
  } finally {
    await db.$disconnect();
  }
}, 60_000);
