import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { AgentEventsResponse } from "@lrm/coforge-sdk/agent";
import { PrismaClient } from "#src/generated/prisma/client";
import { handleAgentEventsRouteGet } from "#src/routes/api/agent/v1/events";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PrismaSystemAgentEventStore } from "#src/server/db/repositories/system-agent-event.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");

test("revoking notice access opens a recovery slot and lets the next visible notice fill the drain page", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: suffix, username: `window${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `window-${suffix}`,
      name: "Recovery window",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "reader",
        displayName: "Reader",
        runtimeConfig: {},
      },
    });
    const createArtifact = (name: string) =>
      db.artifact.create({
        data: {
          workspaceId: workspace.id,
          name,
          homeKey: "workspace",
          access: "workspace",
          entryPath: "index.html",
        },
      });
    const narrowed = await createArtifact("narrowed");
    const visible = await createArtifact("visible");
    const privateHome = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: "private-home",
        visibility: "private",
        members: { create: { userId: user.id } },
      },
    });
    const store = new PrismaSystemAgentEventStore(db);
    const expiresAt = await store.expiryAfter(3600);
    const write = (artifactId: string) =>
      store.write({
        source: "system.artifacts",
        workspaceId: workspace.id,
        agentId: agent.id,
        externalEventId: `${artifactId}:${WEB_DRAFT_REVIEW_MARKER}:${crypto.randomUUID()}`,
        expiresAt,
        body: "review",
      });
    const first = await write(narrowed.id);
    const second = await write(visible.id);
    if (!first || !second) throw new Error("notice write failed");

    const channel = await db.conversation.create({
      data: {
        id: `ffffffff-ffff-7fff-8fff-${crypto.randomUUID().slice(-12)}`,
        workspaceId: workspace.id,
        channelName: "recovery-window",
        members: { create: [{ userId: user.id }, { agentId: agent.id }] },
      },
    });
    const sender = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: user.id },
    });
    const channelMessages = await db.message.createManyAndReturn({
      data: Array.from({ length: 100 }, (_, index) => ({
        workspaceId: workspace.id,
        conversationId: channel.id,
        senderMemberId: sender.id,
        sequence: index + 1,
        body: "channel message",
      })),
      select: { id: true, sequence: true },
    });
    channelMessages.sort((left, right) => left.sequence - right.sequence);
    await db.agentMessageDelivery.createMany({
      data: channelMessages.map(({ id, sequence }) => ({
        workspaceId: workspace.id,
        conversationId: channel.id,
        agentId: agent.id,
        messageId: id,
        sequence,
      })),
    });
    const repository = new PrismaDirectConversationRepository(db);
    const recovery = async () =>
      (await repository.readAgentRecoveryContext(workspace.id, agent.id)).resumeMessages.map(
        ({ messageId }) => messageId,
      );
    expect(await recovery()).toEqual([
      first.messageId,
      second.messageId,
      ...channelMessages.slice(0, 98).map(({ id }) => id),
    ]);
    await db.artifact.update({
      where: { id: narrowed.id },
      data: { access: "conversation", homeKey: `conversation:${privateHome.id}` },
    });
    const seat = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: first.conversationId, agentId: agent.id, leftAt: null },
    });
    expect(seat.agentReadThroughSequence).toBe(0);
    expect(await recovery()).toEqual([
      second.messageId,
      ...channelMessages.slice(0, 99).map(({ id }) => id),
    ]);

    const response = await handleAgentEventsRouteGet(
      new Request("https://coforge.test/api/agent/v1/events?limit=1"),
      { workspaceId: workspace.id, agentId: agent.id },
      db,
      () => repository,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as AgentEventsResponse;
    expect(result.events.map(({ id }) => id)).toEqual([second.messageId]);
    expect(result.hasMore).toBe(true);
    expect(
      (
        await db.agentMessageDelivery.findUniqueOrThrow({
          where: { deliveryId: second.deliveryId },
        })
      ).messageId,
    ).toBe(second.messageId);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: seat.id } }))
        .agentReadThroughSequence,
    ).toBe(second.sequence);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
