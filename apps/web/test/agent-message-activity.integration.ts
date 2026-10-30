import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentMessagesPostDependencies } from "#src/routes/api/agent/v1/messages";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

/**
 * Task #348: from 10-29 no Agent's message reached anyone's own channel as
 * `conversation.activity.v1`, so no open page moved its sidebar row, unread count or Activity dot
 * for it until it read again. The Agent send path announced through a repository that carried no
 * database, and the announcement stopped without a word after the open conversation's signal.
 * Drives the production repository and `SendDirectMessage` against local PostgreSQL, with a
 * Centrifugo that records what it is asked to broadcast.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL; the route's own wiring
 * also needs `REDIS_URL` (its request records).
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const runnable = Boolean(connectionString);

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: connectionString ?? "postgresql://unused" }),
});
afterAll(() => db.$disconnect());

const idempotency = { execute: async (_scope: unknown, persist: () => unknown) => persist() };

type Broadcast = { channels: string[]; data: Record<string, unknown> };

async function withWorkspace(
  run: (fixture: {
    sender: SendDirectMessage;
    broadcasts: Broadcast[];
    workspaceId: string;
    agentId: string;
    owner: { id: string; username: string };
    member: { id: string };
    channelName: string;
  }) => Promise<void>,
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `owner-${suffix}`, username: `owner-${suffix}` },
  });
  const member = await db.user.create({
    data: { displayName: `member-${suffix}`, username: `member-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `activity-${suffix}`,
      name: "Agent activity",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `writer-${suffix}`,
      displayName: "Writer",
      runtimeConfig: {},
    },
  });
  const channelName = `activity-${suffix}`;
  await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName,
      members: { create: [{ userId: owner.id }, { userId: member.id }, { agentId: agent.id }] },
    },
  });
  const broadcasts: Broadcast[] = [];
  const centrifugo = {
    ...quietCentrifugo(),
    broadcast: async (channels: string[], data: unknown) => {
      broadcasts.push({ channels, data: data as Record<string, unknown> });
    },
  };
  const sender = new SendDirectMessage(
    new PrismaDirectConversationRepository(db, { oneRequest: true }),
    idempotency as never,
    centrifugo,
    new CentrifugoConversationRealtime(centrifugo),
  );
  try {
    await run({
      sender,
      broadcasts,
      workspaceId: workspace.id,
      agentId: agent.id,
      owner,
      member,
      channelName,
    });
  } finally {
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  }
}

const activities = (broadcasts: Broadcast[]) =>
  broadcasts.filter((broadcast) => broadcast.data.type === "conversation.activity.v1");

test.skipIf(!runnable)(
  "an Agent's channel message reaches every member's own channel with its row",
  async () => {
    await withWorkspace(
      async ({ sender, broadcasts, workspaceId, agentId, owner, member, channelName }) => {
        await sender.executeFromAgent({
          idempotencyKey: crypto.randomUUID(),
          workspaceId,
          agentId,
          target: `#${channelName}`,
          body: "the draft is ready",
        });
        const [activity, ...rest] = activities(broadcasts);
        expect(rest).toEqual([]);
        expect([...(activity?.channels ?? [])].sort()).toEqual(
          [userConversationChannel(owner.id), userConversationChannel(member.id)].sort(),
        );
        expect(activity?.data).toMatchObject({
          kind: "channel",
          preview: "the draft is ready",
          sender: { kind: "agent", name: "Writer" },
          senderAgentId: agentId,
        });
      },
    );
  },
);

test.skipIf(!runnable)("an Agent's direct message reaches its person's own channel", async () => {
  await withWorkspace(async ({ sender, broadcasts, workspaceId, agentId, owner }) => {
    await sender.executeFromAgent({
      idempotencyKey: crypto.randomUUID(),
      workspaceId,
      agentId,
      target: `@${owner.username}`,
      body: "done for today",
    });
    const [activity, ...rest] = activities(broadcasts);
    expect(rest).toEqual([]);
    expect(activity?.channels).toEqual([userConversationChannel(owner.id)]);
    expect(activity?.data).toMatchObject({
      kind: "direct",
      preview: "done for today",
      sender: { kind: "agent" },
      senderAgentId: agentId,
    });
  });
});

test.skipIf(!runnable || !Bun.env.REDIS_URL)(
  "the Agent message route's own wiring announces a channel message to its members",
  async () => {
    await withWorkspace(async ({ workspaceId, agentId, owner, member, channelName }) => {
      // The route builds its Centrifugo from the environment; this one records its server API.
      const api = "http://centrifugo.test/api";
      const saved = {
        url: process.env.COFORGE_CENTRIFUGO_API_URL,
        key: process.env.COFORGE_CENTRIFUGO_API_KEY,
        fetch: globalThis.fetch,
      };
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      process.env.COFORGE_CENTRIFUGO_API_URL = api;
      process.env.COFORGE_CENTRIFUGO_API_KEY = "test-key";
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith(api)) return saved.fetch(input, init);
        const body = JSON.parse(String(init?.body));
        if (url.endsWith("/batch"))
          return Response.json({ replies: body.commands.map(() => ({})) });
        calls.push(body);
        return Response.json({ result: {} });
      }) as typeof fetch;
      try {
        await agentMessagesPostDependencies(db).sender.executeFromAgent({
          idempotencyKey: crypto.randomUUID(),
          workspaceId,
          agentId,
          target: `#${channelName}`,
          body: "from the route",
        });
      } finally {
        globalThis.fetch = saved.fetch;
        process.env.COFORGE_CENTRIFUGO_API_URL = saved.url;
        process.env.COFORGE_CENTRIFUGO_API_KEY = saved.key;
      }
      const activity = calls.find(
        (call) =>
          call.method === "broadcast" &&
          (call.params.data as { type?: string }).type === "conversation.activity.v1",
      );
      expect([...((activity?.params.channels as string[]) ?? [])].sort()).toEqual(
        [userConversationChannel(owner.id), userConversationChannel(member.id)].sort(),
      );
      expect(activity?.params.data).toMatchObject({ preview: "from the route" });
    });
  },
);
