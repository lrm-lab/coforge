import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentPeerDirectKey } from "#src/features/conversations/direct-key";
import { APP_BOT_KIND } from "#src/features/agents/agent-system-kind";
import { listAgentChannels } from "#src/server/agents/agent-channel-memberships.server";
import { listAgentPeerCards } from "#src/server/agents/agent-peer-conversations.server";
import {
  AGENT_DM_LIMIT_NOTICE,
  AGENT_DM_LIMITS,
  agentDmIsLimited,
} from "#src/server/conversations/agent-dm-limits.server";

// What a member sees of an Agent's Chat tab: the last message of each conversation between Agents
// (cut short), the channels it is in, nothing about a private peer they may not see, and only to
// the Agent's managers (anyone who can see an app's bot).
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
const slug = `apc-${suffix}`;

let workspaceId: string;
let viewerId: string;
let strangerId: string;
const agents: Record<string, { id: string; name: string }> = {};

const converse = async (
  a: string,
  b: string,
  messages: { from: string; body: string; at?: Date; system?: boolean }[],
) => {
  const conversation = await db.conversation.create({
    data: { workspaceId, directKey: agentPeerDirectKey(agents[a]!.id, agents[b]!.id) },
  });
  const members: Record<string, string> = {};
  for (const name of [a, b])
    members[name] = (
      await db.conversationMember.create({
        data: { conversationId: conversation.id, workspaceId, agentId: agents[name]!.id },
      })
    ).id;
  for (const [index, message] of messages.entries())
    await db.message.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        sequence: index + 1,
        body: message.body,
        senderMemberId: message.system ? null : members[message.from],
        ...(message.at ? { createdAt: message.at } : {}),
      },
    });
};

const cards = (agent: string, userId = viewerId, now?: Date) =>
  listAgentPeerCards(db, { workspaceId, agentId: agents[agent]!.id, userId, now });

const make = (name: string, ownerId: string, visibility: string, systemKind?: string) =>
  db.agent
    .create({
      data: {
        workspaceId,
        ownerId,
        name: `${name}-${suffix}`,
        displayName: name,
        visibility,
        systemKind,
        runtimeConfig: {},
      },
      select: { id: true, name: true },
    })
    .then((agent) => (agents[name] = agent));
const channels = (agent: string, userId = viewerId) =>
  listAgentChannels(db, { workspaceId, agentId: agents[agent]!.id, userId });

beforeAll(async () => {
  const users = await Promise.all(
    ["viewer", "stranger", "keeper"].map((name) =>
      db.user.create({ data: { displayName: name, username: `${name}-${suffix}` } }),
    ),
  );
  [viewerId, strangerId] = [users[0]!.id, users[1]!.id];
  workspaceId = (
    await db.workspace.create({
      data: {
        slug,
        name: "Cards",
        members: { create: users.map((user) => ({ userId: user.id })) },
      },
    })
  ).id;
  await make("ada", viewerId, "public");
  await make("bob", viewerId, "public");
  await make("cleo", users[2]!.id, "private");
  await make("bot", viewerId, "public", APP_BOT_KIND);
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug } });
  await db.user.deleteMany({ where: { username: { endsWith: `-${suffix}` } } });
  await db.$disconnect();
});

test("a card carries the last spoken message's body and says when it was written", async () => {
  const long = "x".repeat(200);
  await converse("ada", "bob", [
    { from: "ada", body: "hello" },
    { from: "bob", body: long },
  ]);
  const [card, ...rest] = await cards("ada");
  expect(rest).toEqual([]);
  expect(card).toMatchObject({ limited: false, message: { body: long, mentions: [] } });
  expect(card!.peer).toMatchObject({ agentId: agents.bob!.id, name: agents.bob!.name });
  expect(card!.at).toBeInstanceOf(Date);
});

test("a conversation with a private peer the member cannot see is left out", async () => {
  await converse("ada", "cleo", [{ from: "cleo", body: "private business" }]);
  expect((await cards("ada")).map((card) => card.peer.agentId)).toEqual([agents.bob!.id]);
  // Its creator sees it; a private Agent's own card is refused to anyone else.
  const keeper = await db.user.findFirstOrThrow({ where: { username: `keeper-${suffix}` } });
  await db.workspaceMembership.updateMany({
    where: { workspaceId, userId: keeper.id },
    data: { role: "admin" },
  });
  expect(await cards("ada", keeper.id)).toHaveLength(2);
  await expect(cards("cleo", strangerId)).rejects.toMatchObject({ code: "AGENT_NOT_VISIBLE" });
});

test("limited follows the latest system notice within the quiet window", async () => {
  const now = new Date();
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  await converse("bob", "cleo", [{ from: "bob", body: "ping", at: at(30) }]);
  const keeper = await db.user.findFirstOrThrow({ where: { username: `keeper-${suffix}` } });
  const conversation = await db.conversation.findFirstOrThrow({
    where: { workspaceId, directKey: agentPeerDirectKey(agents.bob!.id, agents.cleo!.id) },
  });
  const notice = (minutesAgo: number) =>
    db.message.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        sequence: 2,
        body: AGENT_DM_LIMIT_NOTICE.AGENT_DM_CHAIN_LIMIT,
        createdAt: at(minutesAgo),
      },
    });
  const limitedFor = async () =>
    (await cards("bob", keeper.id, now)).find((card) => card.peer.agentId === agents.cleo!.id)!
      .limited;

  const written = await notice(AGENT_DM_LIMITS.quietMs / 60_000 + 1);
  expect(await limitedFor()).toBe(false);
  await db.message.update({ where: { id: written.id }, data: { createdAt: at(2) } });
  expect(await limitedFor()).toBe(true);
});

test("an Agent that does not exist answers as one that cannot be seen", async () => {
  await expect(
    listAgentPeerCards(db, { workspaceId, agentId: crypto.randomUUID(), userId: viewerId }),
  ).rejects.toMatchObject({ code: "AGENT_NOT_VISIBLE" });
});

test("a rate notice keeps limited true for the hour, a chain notice for ten minutes", async () => {
  const now = new Date();
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  const latest = (body: string, minutesAgo: number) => ({ body, createdAt: at(minutesAgo) });
  expect(agentDmIsLimited(latest(AGENT_DM_LIMIT_NOTICE.AGENT_DM_RATE_LIMIT, 30), now)).toBe(true);
  expect(agentDmIsLimited(latest(AGENT_DM_LIMIT_NOTICE.AGENT_DM_RATE_LIMIT, 61), now)).toBe(false);
  expect(agentDmIsLimited(latest(AGENT_DM_LIMIT_NOTICE.AGENT_DM_CHAIN_LIMIT, 30), now)).toBe(false);
  expect(agentDmIsLimited(latest("something else", 1), now)).toBe(false);
  expect(agentDmIsLimited(undefined, now)).toBe(false);
});

test("a mention in the previewed message reads as the Agent's handle, not as a token", async () => {
  const conversation = await db.conversation.findFirstOrThrow({
    where: { workspaceId, directKey: agentPeerDirectKey(agents.ada!.id, agents.bob!.id) },
    include: { members: true },
  });
  const sender = conversation.members.find((member) => member.agentId === agents.bob!.id)!;
  const target = conversation.members.find((member) => member.agentId === agents.ada!.id)!;
  const last = await db.message.findFirstOrThrow({
    where: { conversationId: conversation.id },
    orderBy: { sequence: "desc" },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      sequence: last.sequence + 1,
      senderMemberId: sender.id,
      body: `thanks <@agent:${agents.ada!.id}>`,
    },
  });
  await db.messageMention.create({
    data: {
      messageId: message.id,
      memberId: target.id,
      conversationId: conversation.id,
      workspaceId,
      kind: "agent",
      actorId: agents.ada!.id,
      handle: agents.ada!.name,
    },
  });
  const card = (await cards("ada")).find((c) => c.peer.agentId === agents.bob!.id)!;
  expect(card.message).toMatchObject({
    body: `thanks <@agent:${agents.ada!.id}>`,
    mentions: [{ kind: "agent", actorId: agents.ada!.id, handle: agents.ada!.name }],
  });
});

test("the body is cut to a bounded length without leaving half a mention token", async () => {
  const conversation = await db.conversation.findFirstOrThrow({
    where: { workspaceId, directKey: agentPeerDirectKey(agents.ada!.id, agents.bob!.id) },
    include: { members: true },
  });
  const sender = conversation.members.find((member) => member.agentId === agents.bob!.id)!;
  const say = async (body: string) => {
    const last = await db.message.findFirstOrThrow({
      where: { conversationId: conversation.id },
      orderBy: { sequence: "desc" },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        sequence: last.sequence + 1,
        senderMemberId: sender.id,
        body,
      },
    });
  };
  const lastBody = async () =>
    (await cards("ada")).find((c) => c.peer.agentId === agents.bob!.id)!.message!.body;
  await say("z".repeat(700));
  expect(await lastBody()).toBe("z".repeat(600));
  await say(`${"y".repeat(590)}<@agent:${agents.ada!.id}>`);
  expect(await lastBody()).toBe("y".repeat(590));
});

test("a conversation with no message yet is listed after those with one, by creation time", async () => {
  const quiet = await db.user.create({
    data: { displayName: "quiet", username: `quiet-${suffix}` },
  });
  await db.workspaceMembership.create({
    data: { workspaceId, userId: quiet.id, role: "admin" },
  });
  await make("dora", quiet.id, "public");
  await make("eli", quiet.id, "public");
  await converse("dora", "ada", []);
  await converse("eli", "ada", []);
  const list = await cards("ada", quiet.id);
  const withMessage = list.filter((card) => card.message);
  expect(list.slice(0, withMessage.length)).toEqual(withMessage);
  const empty = list.filter((card) => !card.message);
  expect(empty.map((card) => card.peer.name)).toEqual([`eli-${suffix}`, `dora-${suffix}`]);
  expect(empty.every((card) => card.at instanceof Date)).toBe(true);
});

test("only the Agent's creator, a Workspace owner/admin or, for an app's bot, anyone may read", async () => {
  // A plain member who does not own the Agent is refused, even for a public Agent.
  await expect(cards("ada", strangerId)).rejects.toMatchObject({ code: "AGENT_NOT_VISIBLE" });
  await expect(channels("ada", strangerId)).rejects.toMatchObject({ code: "AGENT_NOT_VISIBLE" });
  await expect(channels("ada", viewerId)).resolves.toEqual([]);
  // An app's bot answers any member who can see it.
  await expect(cards("bot", strangerId)).resolves.toEqual([]);
  await expect(channels("bot", strangerId)).resolves.toEqual([]);
  const missing = { workspaceId, agentId: crypto.randomUUID(), userId: viewerId };
  await expect(listAgentChannels(db, missing)).rejects.toMatchObject({
    code: "AGENT_NOT_VISIBLE",
  });
});

test("channels lists the open channels the Agent is an active member of, by name, with its mute", async () => {
  const channel = (name: string, extra: { archivedAt?: Date; description?: string } = {}) =>
    db.conversation.create({ data: { workspaceId, channelName: `${name}-${suffix}`, ...extra } });
  const [beta, alpha, gone, left, hidden, outside] = await Promise.all([
    channel("beta", { description: "Second." }),
    channel("alpha"),
    channel("gone", { archivedAt: new Date() }),
    channel("left"),
    db.conversation.create({
      data: { workspaceId, channelName: `hidden-${suffix}`, hiddenFromWorkspaceAt: new Date() },
    }),
    channel("outside"),
  ]);
  const join = (conversationId: string, extra: { channelMuted?: boolean; leftAt?: Date } = {}) =>
    db.conversationMember.create({
      data: { conversationId, workspaceId, agentId: agents.ada!.id, ...extra },
    });
  await join(beta!.id);
  await join(alpha!.id, { channelMuted: true });
  await join(gone!.id);
  await join(left!.id, { leftAt: new Date() });
  await join(hidden!.id);
  // Bob's membership says nothing about Ada's.
  await db.conversationMember.create({
    data: { conversationId: outside!.id, workspaceId, agentId: agents.bob!.id },
  });
  expect(await channels("ada")).toEqual([
    { id: alpha!.id, name: `alpha-${suffix}`, description: "", muted: true },
    { id: beta!.id, name: `beta-${suffix}`, description: "Second.", muted: false },
  ]);
});
