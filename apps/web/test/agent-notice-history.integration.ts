import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WEB_DRAFT_REVIEW_MARKER } from "#src/server/artifacts/artifact-notice-visibility.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");

test("the notice conversation reads only the notices the Agent can still read", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `notice-${suffix}`, username: `notice${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `notice-${suffix}`,
      name: "Notice history",
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
    const artifact = await db.artifact.create({
      data: {
        workspaceId: workspace.id,
        homeKey: `conversation:${conversation.id}`,
        access: "workspace",
        name: `notice-${suffix}`,
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
        select: { id: true, sequence: true },
      });
    const [first, second, third, fourth, fifth] = await Promise.all([
      notice(1),
      notice(2),
      notice(3),
      notice(4),
      notice(5),
    ]);
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
    await reviewed(second!.id, artifact.id);
    await reviewed(third!.id, crypto.randomUUID());

    const read = (page: Record<string, string | number>) =>
      readAgentMessagePage(db, {
        workspaceId: workspace.id,
        agentId: agent.id,
        conversationId: conversation.id,
        threadRootId: null,
        canonicalTarget: "@app.system.artifacts",
        isChannel: false,
        isUserAgentDirectConversation: false,
        page: page as never,
        resolveAnchor: async (anchor) => {
          const rows = await db.message.findMany({
            where: { conversationId: conversation.id, id: anchor },
            select: { id: true, sequence: true, threadRootId: true },
          });
          if (!rows[0]) throw new Error("message anchor not found in this conversation");
          return rows[0];
        },
      });
    const sequences = async (page: Record<string, string | number>) =>
      (await read(page)).messages.map((message) => message.sequence);

    const latest = await read({ limit: 2 });
    expect(latest.messages.map((message) => message.sequence)).toEqual([4, 5]);
    expect(latest.hasOlder).toBe(true);
    expect(latest.hasNewer).toBe(false);

    const beforePage = await read({ before: fifth!.id, limit: 2 });
    expect(beforePage.messages.map((message) => message.sequence)).toEqual([2, 4]);
    expect(beforePage.hasOlder).toBe(true);
    expect(beforePage.hasNewer).toBe(true);

    const belowAnchor = await read({ before: fourth!.id, limit: 2 });
    expect(belowAnchor.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(belowAnchor.hasOlder).toBe(false);
    expect(belowAnchor.hasNewer).toBe(true);

    const afterPage = await read({ after: first!.id, limit: 2 });
    expect(afterPage.messages.map((message) => message.sequence)).toEqual([2, 4]);
    expect(afterPage.hasNewer).toBe(true);
    expect(afterPage.hasOlder).toBe(true);

    const zeroAround = await read({ around: "0", limit: 2 });
    expect(zeroAround.messages.map((message) => message.sequence)).toEqual([1]);
    expect(zeroAround.hasOlder).toBe(false);
    expect(zeroAround.hasNewer).toBe(true);

    const hollowAround = await read({ around: "11", limit: 1 });
    expect(hollowAround.messages).toEqual([]);
    expect(hollowAround.hasOlder).toBe(true);
    expect(hollowAround.hasNewer).toBe(false);

    const aroundPage = await read({ around: second!.id, limit: 2 });
    expect(aroundPage.messages.map((message) => message.sequence)).toEqual([2, 4]);
    expect(aroundPage.hasOlder).toBe(true);

    const pinned = async (id: string, sequence: number, body: string) =>
      db.$executeRaw`INSERT INTO "messages" ("id", "conversationId", "workspaceId", "body", "sequence", "createdAt")
        VALUES (${id}::uuid, ${conversation.id}::uuid, ${workspace.id}::uuid, ${body}, ${sequence}, ${new Date(Date.parse("2024-01-02T00:00:00Z") + sequence * 1000)})`;
    const readableId = "01a1f6d9-aaaa-7000-8000-000000000001";
    const blockedId = "01a1f6d9-aaaa-7000-8000-000000000002";
    await pinned(readableId, 6, "notice 6");
    await pinned(blockedId, 7, "notice 7");
    await reviewed(blockedId, crypto.randomUUID());

    expect(await sequences({ before: "01a1f6d9-aaaa", limit: 2 })).toEqual([4, 5]);
    expect(await sequences({ after: "01a1f6d9-aaaa", limit: 1 })).toEqual([]);
    await expect(read({ after: blockedId, limit: 1 })).rejects.toThrow(
      "message anchor not found in this conversation",
    );

    await pinned("01a1f6da-bbbb-7000-8000-000000000001", 8, "notice 8");
    await pinned("01a1f6da-bbbb-7000-8000-000000000002", 9, "notice 9");

    const wideAround = await read({ around: "6", limit: 10 });
    expect(wideAround.hasOlder).toBe(false);
    expect(wideAround.hasNewer).toBe(false);

    const fullAround = await read({ around: "6", limit: 4 });
    expect(fullAround.messages.map((message) => message.sequence)).toEqual([5, 6, 8, 9]);
    expect(fullAround.hasNewer).toBe(false);
    expect(fullAround.hasOlder).toBe(true);
    await expect(read({ after: "01a1f6da-bbbb", limit: 1 })).rejects.toThrow(
      "ambiguous message prefix",
    );

    await expect(read({ after: third!.id, limit: 2 })).rejects.toThrow(
      "message anchor not found in this conversation",
    );
    await expect(read({ before: String(third!.sequence), limit: 2 })).rejects.toThrow(
      "message anchor not found in this conversation",
    );

    const emptyPosition = await read({ before: "99", limit: 2 });
    expect(emptyPosition.messages.map((message) => message.sequence)).toEqual([8, 9]);

    const fromZero = await read({ after: "0", limit: 2 });
    expect(fromZero.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(fromZero.hasOlder).toBe(false);
    expect(fromZero.hasNewer).toBe(true);

    let revoke = async () => {};
    const revoking = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "message" || typeof value !== "object" || value === null) return value;
        const message = value as { findMany: (...args: unknown[]) => Promise<unknown> };
        return {
          ...message,
          findMany: async (...args: unknown[]) => {
            const input = args[0] as { where: { id: { in: string[] } } };
            expect(input.where.id.in).toEqual([second!.id, first!.id]);
            const rows = (await message.findMany(...args)) as { id: string }[];
            expect(new Set(rows.map((row) => row.id))).toEqual(new Set([first!.id, second!.id]));
            const pending = revoke;
            revoke = async () => {};
            await pending();
            return rows;
          },
        };
      },
    });
    revoke = async () => {
      await db.artifact.update({
        where: { id: artifact.id },
        data: { access: "conversation", homeKey: `conversation:${crypto.randomUUID()}` },
      });
    };
    const revoked = await readAgentMessagePage(revoking, {
      workspaceId: workspace.id,
      agentId: agent.id,
      conversationId: conversation.id,
      threadRootId: null,
      canonicalTarget: "@app.system.artifacts",
      isChannel: false,
      isUserAgentDirectConversation: false,
      page: { before: "4", limit: 2 } as never,
      resolveAnchor: async () => {
        throw new Error("unused");
      },
    });
    expect(revoked.messages.map((message) => message.sequence)).toEqual([1]);
    expect(revoked.hasOlder).toBe(false);
    expect(revoked.hasNewer).toBe(true);

    await pinned("01a1f6db-cccc-7000-8000-000000000001", 10, "notice 10");
    await reviewed("01a1f6db-cccc-7000-8000-000000000001", crypto.randomUUID());
    const blockedTail = await read({ after: "9", limit: 2 });
    expect(blockedTail.messages).toEqual([]);
    expect(blockedTail.hasNewer).toBe(false);

    await pinned("01a1f6dc-dddd-7000-8000-000000000001", 20, "notice 20");
    const bothSides = await read({ around: "15", limit: 1 });
    expect(bothSides.messages).toEqual([]);
    expect(bothSides.hasOlder).toBe(true);
    expect(bothSides.hasNewer).toBe(true);
    expect(fourth!.id).toContain("-");
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
});
