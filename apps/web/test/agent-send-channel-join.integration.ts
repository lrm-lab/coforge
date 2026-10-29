import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { executeAgentSendMessageWithPolicy } from "#src/server/agents/agent-messages.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * An Agent sending to a channel it is not in joins it in the send's own transaction when the
 * channel is one it could join anyway (a public Agent, a visible unarchived channel); every other
 * target keeps its earlier refusal, and a failed send leaves no membership. Drives the repository
 * and `SendDirectMessage` against local PostgreSQL, like `agent-send-policy.integration.ts`.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const runnable = Boolean(connectionString);

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: connectionString ?? "postgresql://unused" }),
});
afterAll(() => db.$disconnect());

const idempotency = { execute: async (_scope: unknown, persist: () => unknown) => persist() };

type Fixture = {
  workspaceId: string;
  agentId: string;
  channelId: string;
  channelName: string;
  cleanup(): Promise<void>;
};

async function withChannel(
  options: { agentVisibility?: "public" | "private"; archived?: boolean; member?: boolean } & {
    run(fixture: Fixture): Promise<void>;
  },
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `join-owner-${suffix}`, username: `join-owner-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `join-${suffix}`,
      name: "Send join",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `sender-${suffix}`,
      displayName: "Sender",
      runtimeConfig: {},
      ...(options.agentVisibility ? { visibility: options.agentVisibility } : {}),
    },
  });
  const channelName = `join-${suffix}`;
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName,
      ...(options.archived ? { archivedAt: new Date() } : {}),
      members: {
        create: [{ userId: owner.id }, ...(options.member ? [{ agentId: agent.id }] : [])],
      },
    },
  });
  try {
    await options.run({
      workspaceId: workspace.id,
      agentId: agent.id,
      channelId: channel.id,
      channelName,
      cleanup: async () => {},
    });
  } finally {
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: owner.id } });
  }
}

function send(fixture: Fixture, input: { content?: string; attachmentIds?: string[] } = {}) {
  const repo = new PrismaDirectConversationRepository(db);
  const sender = new SendDirectMessage(
    repo,
    idempotency as never,
    { publish: async () => [] } as never,
  );
  return executeAgentSendMessageWithPolicy(
    { repository: repo, sender },
    {
      idempotencyKey: crypto.randomUUID(),
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      target: `#${fixture.channelName}`,
      content: input.content ?? "hello",
      attachmentIds: input.attachmentIds,
    },
  );
}

const memberOf = (fixture: Fixture) =>
  db.conversationMember.findFirst({
    where: { conversationId: fixture.channelId, agentId: fixture.agentId },
  });

test.skipIf(!runnable)(
  "sending to a public channel the Agent is not in joins it in the send's transaction",
  async () => {
    await withChannel({
      run: async (fixture) => {
        const sent = await send(fixture);
        expect(sent).toMatchObject({
          state: "sent",
          joinedChannel: `#${fixture.channelName}`,
        });
        const member = await memberOf(fixture);
        expect(member?.leftAt).toBeNull();
        const message = await db.message.findUniqueOrThrow({
          where: { id: sent.messageId! },
          select: { senderMemberId: true },
        });
        expect(message.senderMemberId).toBe(member!.id);
      },
    });
  },
);

test.skipIf(!runnable)(
  "sending to a channel the Agent already belongs to reports no join",
  async () => {
    await withChannel({
      member: true,
      run: async (fixture) => {
        const sent = await send(fixture);
        expect(sent).toMatchObject({ state: "sent" });
        expect(sent.joinedChannel).toBeUndefined();
      },
    });
  },
);

test.skipIf(!runnable)(
  "a private Agent's send to a channel it is not in is refused, as before",
  async () => {
    await withChannel({
      agentVisibility: "private",
      run: async (fixture) => {
        await expect(send(fixture)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
        expect(await memberOf(fixture)).toBeNull();
        expect(await db.message.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0);
      },
    });
  },
);

test.skipIf(!runnable)(
  "an archived channel is not joined on send and keeps its earlier refusal",
  async () => {
    await withChannel({
      archived: true,
      run: async (fixture) => {
        await expect(send(fixture)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
        expect(await memberOf(fixture)).toBeNull();
      },
    });
  },
);

test.skipIf(!runnable)(
  "a send that fails inside the transaction leaves no membership",
  async () => {
    await withChannel({
      run: async (fixture) => {
        await expect(send(fixture, { attachmentIds: [crypto.randomUUID()] })).rejects.toThrow(
          "attachment is not available",
        );
        expect(await memberOf(fixture)).toBeNull();
        expect(await db.message.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0);
      },
    });
  },
);

test.skipIf(!runnable)("a soft-left member's send rejoins on the same row", async () => {
  await withChannel({
    member: true,
    run: async (fixture) => {
      const before = await memberOf(fixture);
      await db.conversationMember.update({
        where: { id: before!.id },
        data: { leftAt: new Date() },
      });
      const sent = await send(fixture);
      expect(sent).toMatchObject({
        state: "sent",
        joinedChannel: `#${fixture.channelName}`,
      });
      const member = await memberOf(fixture);
      expect(member?.id).toBe(before!.id);
      expect(member?.leftAt).toBeNull();
    },
  });
});

test.skipIf(!runnable)("a channel that does not exist is still refused", async () => {
  await withChannel({
    run: async (fixture) => {
      await expect(
        send({ ...fixture, channelName: `missing-${crypto.randomUUID().slice(0, 8)}` }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    },
  });
});
