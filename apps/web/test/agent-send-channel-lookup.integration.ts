import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  agentMessagesPostDependencies,
  handleAgentMessagesPost,
} from "#src/routes/api/agent/v1/messages";
import { AgentSendRejectedError } from "#src/server/conversations/agent-send-rejected-error.server";

/**
 * An Agent's channel send resolves its channel for the Memory Offer check, for the freshness check
 * and for the send itself. The route's per-request repository resolves it once; the send still
 * re-reads the sender's membership when it writes. Drives the route's own wiring against local
 * PostgreSQL and Redis, with a stub Centrifugo.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL and `REDIS_URL` (read by
 * the route's request records) at a local Redis.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const runnable = Boolean(connectionString && Bun.env.REDIS_URL);

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: connectionString ?? "postgresql://unused" }),
  log: [{ emit: "event", level: "query" }],
});
const queries: string[] = [];
db.$on("query", (event) => queries.push(event.query));
afterAll(() => db.$disconnect());

/** `getAgentChannel`'s read: a channel by name that the Agent is an active member of. */
const isChannelLookup = (query: string) =>
  /FROM "public"\."conversations"/.test(query) && /"channelName" = \$\d+/.test(query);

async function withChannel(
  run: (seed: {
    workspaceId: string;
    agentId: string;
    memberId: string;
    channelName: string;
  }) => Promise<void>,
) {
  const centrifugo = Bun.serve({ port: 0, fetch: () => Response.json({ result: {} }) });
  const env = {
    url: process.env.COFORGE_CENTRIFUGO_API_URL,
    key: process.env.COFORGE_CENTRIFUGO_API_KEY,
  };
  process.env.COFORGE_CENTRIFUGO_API_URL = `http://127.0.0.1:${centrifugo.port}/api`;
  process.env.COFORGE_CENTRIFUGO_API_KEY = "test-key";
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `lookup-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `lookup-${suffix}`,
      name: "Channel lookup",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  try {
    const [sender, listener] = await Promise.all(
      ["sender", "listener"].map((name) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId: owner.id,
            name: `${name}-${suffix}`,
            displayName: name,
            runtimeConfig: {},
          },
        }),
      ),
    );
    const channelName = `lookup-${suffix}`;
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName,
        members: {
          create: [{ userId: owner.id }, { agentId: sender!.id }, { agentId: listener!.id }],
        },
      },
      include: { members: true },
    });
    await run({
      workspaceId: workspace.id,
      agentId: sender!.id,
      memberId: channel.members.find((member) => member.agentId === sender!.id)!.id,
      channelName,
    });
  } finally {
    restoreEnv("COFORGE_CENTRIFUGO_API_URL", env.url);
    restoreEnv("COFORGE_CENTRIFUGO_API_KEY", env.key);
    await centrifugo.stop(true);
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: owner.id } });
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test.skipIf(!runnable)("an Agent's channel send looks its channel up once", async () => {
  await withChannel(async ({ workspaceId, agentId, channelName }) => {
    queries.length = 0;
    const response = await handleAgentMessagesPost(
      new Request("https://server.example/api/agent/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          target: `#${channelName}`,
          content: "hello",
          idempotencyKey: crypto.randomUUID(),
          seenUpToSeq: 0,
        }),
      }),
      { workspaceId, agentId },
      agentMessagesPostDependencies(db),
    );
    expect(await response.json()).toMatchObject({ state: "sent" });
    expect(queries.filter(isChannelLookup)).toHaveLength(1);
  });
});

test.skipIf(!runnable)(
  "an Agent removed after its channel was looked up cannot send in the same request",
  async () => {
    await withChannel(async ({ workspaceId, agentId, memberId, channelName }) => {
      const { repository, sender } = agentMessagesPostDependencies(db);
      await repository.getAgentChannel(workspaceId, agentId, `#${channelName}`);
      await db.conversationMember.update({ where: { id: memberId }, data: { leftAt: new Date() } });

      const sending = sender.executeFromAgent({
        idempotencyKey: crypto.randomUUID(),
        workspaceId,
        agentId,
        target: `#${channelName}`,
        body: "after removal",
      });
      // The kept lookup still names the channel; the send's own membership read refuses it.
      await expect(sending).rejects.toEqual(
        new AgentSendRejectedError(403, "agent is not a conversation member"),
      );
      expect(await db.message.count({ where: { workspaceId } })).toBe(0);
    });
  },
);
