import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentPeerDirectKey } from "#src/features/conversations/direct-key";
import { listAgentPeerCards } from "#src/server/agents/agent-peer-conversations.server";
import {
  AGENT_DM_LIMIT_NOTICE,
  AGENT_DM_LIMITS,
  agentDmIsLimited,
} from "#src/server/conversations/agent-dm-limits.server";

// What a member sees of the conversations between Agents: previews, never bodies, and nothing
// about a private peer they may not see.
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
  const make = (name: string, ownerId: string, visibility: string) =>
    db.agent
      .create({
        data: {
          workspaceId,
          ownerId,
          name: `${name}-${suffix}`,
          displayName: name,
          visibility,
          runtimeConfig: {},
        },
        select: { id: true, name: true },
      })
      .then((agent) => (agents[name] = agent));
  await make("ada", viewerId, "public");
  await make("bob", viewerId, "public");
  await make("cleo", users[2]!.id, "private");
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug } });
  await db.user.deleteMany({ where: { username: { endsWith: `-${suffix}` } } });
  await db.$disconnect();
});

test("a card previews the last spoken message, says who spoke, and cuts the body short", async () => {
  const long = "x".repeat(200);
  await converse("ada", "bob", [
    { from: "ada", body: "hello" },
    { from: "bob", body: long },
  ]);
  const [card, ...rest] = await cards("ada");
  expect(rest).toEqual([]);
  expect(card).toMatchObject({ lastFromPeer: true, limited: false });
  expect(card!.peer).toMatchObject({ agentId: agents.bob!.id, name: agents.bob!.name });
  expect(Array.from(card!.preview)).toHaveLength(120);
  expect(Object.keys(card!)).not.toContain("body");
  // The same conversation from the other seat: the last word is not the peer's.
  expect((await cards("bob"))[0]).toMatchObject({ lastFromPeer: false });
});

test("a conversation with a private peer the member cannot see is left out", async () => {
  await converse("ada", "cleo", [{ from: "cleo", body: "private business" }]);
  expect((await cards("ada")).map((card) => card.peer.agentId)).toEqual([agents.bob!.id]);
  // Its creator sees it; a private Agent's own card is refused to anyone else.
  const keeper = await db.user.findFirstOrThrow({ where: { username: `keeper-${suffix}` } });
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
