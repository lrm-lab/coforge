import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");

test("an around page measures each side against its own rows, not the whole page", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `interleave-${suffix}`, username: `interleave${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `interleave-${suffix}`,
      name: "Interleaved notice history",
      members: { create: [{ userId: user.id }] },
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
      select: { id: true },
    });
    const conversation = await db.conversation.create({
      data: { workspaceId: workspace.id, directKey: `system:system.artifacts|agent:${agent.id}` },
      select: { id: true },
    });
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: conversation.id, agentId: agent.id },
    });
    const readable = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        homeKey: `conversation:${conversation.id}`,
        access: "workspace",
        name: `interleave-${suffix}`,
        entryPath: "index.html",
      },
      select: { id: true },
    });
    const hidden = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        homeKey: `conversation:${crypto.randomUUID()}`,
        access: "conversation",
        name: `interleave-hidden-${suffix}`,
        entryPath: "index.html",
      },
      select: { id: true },
    });

    const notice = async (sequence: number) =>
      db.message.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          body: `notice ${sequence}`,
          sequence,
          createdAt: new Date(Date.parse("2024-01-01T00:00:00Z") + sequence * 1000),
        },
        select: { id: true },
      });
    const reviewed = async (messageId: string, artifactId: string) =>
      db.systemAgentEvent.create({
        data: {
          source: "system.artifacts",
          agentId: agent.id,
          workspaceId: workspace.id,
          conversationId: conversation.id,
          messageId,
          externalEventId: `${artifactId}:${WEB_DRAFT_REVIEW_MARKER}:${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

    for (const sequence of [1, 2, 3, 4, 5]) {
      const blocked = await notice(sequence);
      await reviewed(blocked.id, crypto.randomUUID());
    }
    const inner = await notice(8);
    await reviewed(inner.id, hidden.id);
    const outer = await notice(9);
    await reviewed(outer.id, readable.id);

    let restore = async () => {};
    const restoring = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "message" || typeof value !== "object" || value === null) return value;
        const message = value as { findMany: (...args: unknown[]) => Promise<unknown> };
        return {
          ...message,
          findMany: async (...args: unknown[]) => {
            const rows = (await message.findMany(...args)) as { id: string }[];
            expect(rows.map((row) => row.id)).toEqual([outer.id]);
            const pending = restore;
            restore = async () => {};
            await pending();
            return rows;
          },
        };
      },
    });
    restore = async () => {
      await db.artifact.update({
        where: { id: hidden.id },
        data: { access: "workspace", homeKey: `conversation:${conversation.id}` },
      });
    };

    const page = await readAgentMessagePage(restoring, {
      workspaceId: workspace.id,
      agentId: agent.id,
      conversationId: conversation.id,
      threadRootId: null,
      canonicalTarget: "@app.system.artifacts",
      isChannel: false,
      isUserAgentDirectConversation: false,
      page: { around: "6", limit: 3 } as never,
      resolveAnchor: async (anchor) => {
        const rows = await db.message.findMany({
          where: { conversationId: conversation.id, id: anchor },
          select: { id: true, sequence: true, threadRootId: true },
        });
        if (!rows[0]) throw new Error("message anchor not found in this conversation");
        return rows[0];
      },
    });

    expect(page.messages.map((message) => message.sequence)).toEqual([9]);
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(false);

    const spare = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        homeKey: `conversation:${conversation.id}`,
        access: "workspace",
        name: `interleave-spare-${suffix}`,
        entryPath: "index.html",
      },
      select: { id: true },
    });
    const revoked = await notice(10);
    await reviewed(revoked.id, spare.id);
    const follower = await notice(11);
    await reviewed(follower.id, readable.id);

    let revokeInner = async () => {};
    const revokingUnread = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "message" || typeof value !== "object" || value === null) return value;
        const message = value as { findMany: (...args: unknown[]) => Promise<unknown> };
        return {
          ...message,
          findMany: async (...args: unknown[]) => {
            const rows = await message.findMany(...args);
            const pending = revokeInner;
            revokeInner = async () => {};
            await pending();
            return rows;
          },
        };
      },
    });
    revokeInner = async () => {
      await db.artifact.update({
        where: { id: spare.id },
        data: { access: "conversation", homeKey: `conversation:${crypto.randomUUID()}` },
      });
    };

    const unread = await readAgentMessagePage(revokingUnread, {
      workspaceId: workspace.id,
      agentId: agent.id,
      conversationId: conversation.id,
      threadRootId: null,
      canonicalTarget: "@app.system.artifacts",
      isChannel: false,
      isUserAgentDirectConversation: false,
      page: { unread: true, limit: 1 } as never,
      resolveAnchor: async () => {
        throw new Error("an unread page needs no anchor");
      },
    });
    expect(unread.messages).toEqual([]);
    expect(unread.moreUnread).toBe(true);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
