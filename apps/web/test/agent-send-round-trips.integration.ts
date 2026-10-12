import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  agentMessagesPostDependencies,
  handleAgentMessagesPost,
} from "#src/routes/api/agent/v1/messages";
import { AgentSendRejectedError } from "#src/server/conversations/agent-send-rejected-error.server";

/**
 * The database round trips of an Agent's channel send. Its channel is resolved for the Memory
 * Offer check, for the freshness check and for the send itself; the route's per-request repository
 * resolves it once, and the send still re-reads the sender's membership when it writes. Under the
 * conversation's sequence lock the send writes its message, mention rows and delivery rows without
 * reading any of them back. Drives the route's own wiring against local PostgreSQL and Redis, with
 * a stub Centrifugo.
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
    /** On a Computer. */
    listener: { id: string; name: string; computerId: string };
    /** On no Computer. */
    offline: { id: string; name: string };
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
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: crypto.randomUUID() },
  });
  try {
    await db.workspaceComputer.create({
      data: { workspaceId: workspace.id, computerId: computer.id },
    });
    const [sender, listener, offline] = await Promise.all(
      ["sender", "listener", "offline"].map((name) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId: owner.id,
            name: `${name}-${suffix}`,
            displayName: name,
            runtimeConfig: {},
            computerId: name === "listener" ? computer.id : null,
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
          create: [
            { userId: owner.id },
            { agentId: sender!.id },
            { agentId: listener!.id },
            { agentId: offline!.id },
          ],
        },
      },
      include: { members: true },
    });
    await run({
      workspaceId: workspace.id,
      agentId: sender!.id,
      memberId: channel.members.find((member) => member.agentId === sender!.id)!.id,
      channelName,
      listener: { id: listener!.id, name: listener!.name, computerId: computer.id },
      offline: { id: offline!.id, name: offline!.name },
    });
  } finally {
    restoreEnv("COFORGE_CENTRIFUGO_API_URL", env.url);
    restoreEnv("COFORGE_CENTRIFUGO_API_KEY", env.key);
    await centrifugo.stop(true);
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
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

test.skipIf(!runnable)(
  "an Agent's channel send writes its message, mentions and deliveries without reading them back",
  async () => {
    await withChannel(async ({ workspaceId, agentId, channelName, listener, offline }) => {
      const { repository } = agentMessagesPostDependencies(db);
      const channel = await repository.getAgentChannel(workspaceId, agentId, `#${channelName}`);
      queries.length = 0;
      const sent = await repository.sendAgentMessage(
        channel.id,
        agentId,
        `@${offline.name} and @${listener.name}, over to you`,
      );

      // Each delivery names its Agent's Computer, in the order the body mentions them.
      const stored = await db.agentMessageDelivery.findMany({
        where: { messageId: sent.id },
        select: { deliveryId: true, agentId: true, sequence: true },
      });
      expect(sent.deliveries).toEqual([
        {
          deliveryId: stored.find((row) => row.agentId === offline.id)!.deliveryId,
          agentId: offline.id,
          computerId: null,
        },
        {
          deliveryId: stored.find((row) => row.agentId === listener.id)!.deliveryId,
          agentId: listener.id,
          computerId: listener.computerId,
        },
      ]);
      expect(stored.map((row) => row.sequence)).toEqual([sent.sequence, sent.sequence]);
      const mentions = await db.messageMention.findMany({
        where: { messageId: sent.id },
        select: { kind: true, actorId: true, handle: true },
      });
      // What the send reports is what it stored.
      const byActor = (left: { actorId: string }, right: { actorId: string }) =>
        left.actorId.localeCompare(right.actorId);
      expect([...sent.mentions].sort(byActor)).toEqual(
        [...mentions].sort(byActor) as typeof sent.mentions,
      );
      expect(sent.mentions).toEqual([
        { kind: "agent", actorId: offline.id, handle: offline.name },
        { kind: "agent", actorId: listener.id, handle: listener.name },
      ]);

      // Between taking the lock and committing, nothing the send wrote is read back.
      const locked = queries.findIndex((query) => /FOR UPDATE/.test(query));
      const committed = queries.findIndex((query, index) => index > locked && query === "COMMIT");
      expect(locked).toBeGreaterThan(-1);
      const underLock = queries.slice(locked, committed);
      expect(
        underLock.filter(
          (query) =>
            /^SELECT/.test(query.trim()) &&
            /FROM "public"\."(messages|message_mentions|agent_message_deliveries)" WHERE/.test(
              query,
            ) &&
            /"(id|messageId)" (=|IN) /.test(query),
        ),
      ).toEqual([]);
    });
  },
);
