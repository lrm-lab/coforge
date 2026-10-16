import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

/**
 * The public channel list's preview of each channel, against real PostgreSQL: the newest top-level
 * message with its sender, up to six active members in join order, and whether the viewer has an
 * unread @mention there. Messages are written directly so each test controls sequences, thread
 * roots and join times.
 */

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const channels = new PublicChannels(db);
const suffix = crypto.randomUUID().slice(0, 8);
const usernames: string[] = [];
const slug = `clp-${suffix}`;

let workspaceId: string;
let ada: { id: string; username: string };
let grace: { id: string; username: string };
let lin: { id: string; username: string };
let helper: { id: string };
let retired: { id: string };

/** A fresh user who is a member of the Workspace. */
async function user(name: string) {
  const username = `clp-${name}-${suffix}`;
  usernames.push(username);
  const created = await db.user.create({ data: { displayName: username, username } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: created.id } });
  return { id: created.id, username };
}

/** A channel with the given members, each joined at `joinedAt` (default: the moment of the call). */
async function channel(
  name: string,
  members: {
    userId?: string;
    agentId?: string;
    joinedAt?: Date;
    leftAt?: Date;
  }[],
) {
  return db.conversation.create({
    data: {
      workspaceId,
      channelName: `clp-${name}-${suffix}`,
      members: {
        create: members.map(({ userId, agentId, joinedAt, leftAt }) => ({
          userId: userId ?? null,
          agentId: agentId ?? null,
          ...(joinedAt ? { joinedAt } : {}),
          ...(leftAt ? { leftAt } : {}),
        })),
      },
    },
  });
}

async function memberOf(conversationId: string, userId: string) {
  return db.conversationMember.findUniqueOrThrow({
    where: { conversationId_userId: { conversationId, userId } },
  });
}

/** A top-level message (or a thread reply when `threadRootId` is given) from a member or the system. */
async function post(
  conversationId: string,
  sequence: number,
  body: string,
  {
    senderMemberId = null,
    threadRootId,
    mentionedMemberId,
    mentioned,
  }: {
    senderMemberId?: string | null;
    threadRootId?: string;
    mentionedMemberId?: string;
    mentioned?: { id: string; username: string };
  } = {},
) {
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId,
      senderMemberId,
      sequence,
      body,
      threadRootId: threadRootId ?? null,
    },
  });
  if (mentionedMemberId && mentioned)
    await db.messageMention.create({
      data: {
        messageId: message.id,
        memberId: mentionedMemberId,
        conversationId,
        workspaceId,
        kind: "user",
        actorId: mentioned.id,
        handle: mentioned.username,
      },
    });
  return message;
}

function rowOf(rows: Awaited<ReturnType<PublicChannels["list"]>>, conversationId: string) {
  const row = rows.find((candidate) => candidate.id === conversationId);
  if (!row) throw new Error(`channel ${conversationId} is not in the list`);
  return row;
}

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { slug, name: "Channel list preview" },
  });
  workspaceId = workspace.id;
  ada = await user("ada");
  grace = await user("grace");
  lin = await user("lin");
  helper = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: `helper-${suffix}`,
      displayName: "Helper",
      runtimeConfig: {},
    },
  });
  retired = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: `retired-${suffix}`,
      displayName: "Retired",
      runtimeConfig: {},
      deletedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { slug } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

test("a channel with no message has no last message", async () => {
  const empty = await channel("empty", [{ userId: ada.id }]);

  const row = rowOf(await channels.list(workspaceId, ada.id), empty.id);
  expect(row.lastMessage).toBeNull();
});

test("the last message is the newest top-level message, not a newer thread reply", async () => {
  const conversation = await channel("threads", [{ userId: ada.id }, { userId: grace.id }]);
  const graceMember = await memberOf(conversation.id, grace.id);
  const adaMember = await memberOf(conversation.id, ada.id);
  const root = await post(conversation.id, 1, "the top-level message", {
    senderMemberId: graceMember.id,
  });
  const newest = await post(conversation.id, 2, "the newest top-level message", {
    senderMemberId: adaMember.id,
  });
  await post(conversation.id, 3, "a newer reply in a thread", {
    senderMemberId: graceMember.id,
    threadRootId: root.id,
  });

  const row = rowOf(await channels.list(workspaceId, ada.id), conversation.id);
  expect(row.lastMessage).toEqual({
    createdAt: newest.createdAt.toISOString(),
    preview: "the newest top-level message",
    sender: { kind: "user", name: ada.username, mine: true },
  });
});

test("the sender is a person, an Agent or the system, and mine is true only for the viewer", async () => {
  const withPerson = await channel("sender-person", [{ userId: grace.id }, { userId: ada.id }]);
  const withAgent = await channel("sender-agent", [{ agentId: helper.id }, { userId: ada.id }]);
  const withSystem = await channel("sender-system", [{ userId: ada.id }]);
  const graceMember = await memberOf(withPerson.id, grace.id);
  const helperMember = await db.conversationMember.findUniqueOrThrow({
    where: { conversationId_agentId: { conversationId: withAgent.id, agentId: helper.id } },
  });
  await post(withPerson.id, 1, "from grace", { senderMemberId: graceMember.id });
  await post(withAgent.id, 1, "from the agent", { senderMemberId: helperMember.id });
  await post(withSystem.id, 1, "a system notice");

  const rows = await channels.list(workspaceId, ada.id);
  expect(rowOf(rows, withPerson.id).lastMessage?.sender).toEqual({
    kind: "user",
    name: grace.username,
    mine: false,
  });
  expect(rowOf(rows, withAgent.id).lastMessage?.sender).toEqual({
    kind: "agent",
    name: "Helper",
    mine: false,
  });
  expect(rowOf(rows, withSystem.id).lastMessage?.sender).toEqual({
    kind: "system",
    name: "System",
    mine: false,
  });
});

test("members are at most six, active, in join order then member id, mixing people and Agents", async () => {
  const base = Date.UTC(2026, 0, 1);
  const at = (seconds: number) => new Date(base + seconds * 1000);
  const extras = await Promise.all(["m5", "m6", "m7"].map((name) => user(name)));
  const tiedA = lin;
  const tiedB = grace;
  const conversation = await channel("members", [
    { userId: ada.id, joinedAt: at(0) },
    { agentId: helper.id, joinedAt: at(1) },
    { userId: tiedA.id, joinedAt: at(2) },
    { userId: tiedB.id, joinedAt: at(2) },
    { userId: extras[0]!.id, joinedAt: at(5) },
    { userId: extras[1]!.id, joinedAt: at(6) },
    { userId: extras[2]!.id, joinedAt: at(7) },
    // Left before the cut: not listed at all, however early it joined.
    { userId: (await user("left")).id, joinedAt: at(0), leftAt: at(3) },
    // A deleted Agent is not listed.
    { agentId: retired.id, joinedAt: at(0) },
  ]);
  const tied = [
    await memberOf(conversation.id, tiedA.id),
    await memberOf(conversation.id, tiedB.id),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));

  const row = rowOf(await channels.list(workspaceId, ada.id), conversation.id);
  expect(row.members).toEqual([
    { kind: "user", id: ada.id, name: ada.username, avatarUrl: null },
    { kind: "agent", id: helper.id, name: "Helper", avatarUrl: null },
    ...tied.map((member) => ({
      kind: "user" as const,
      id: member.userId!,
      name: member.userId === tiedA.id ? tiedA.username : tiedB.username,
      avatarUrl: null,
    })),
    { kind: "user", id: extras[0]!.id, name: extras[0]!.username, avatarUrl: null },
    { kind: "user", id: extras[1]!.id, name: extras[1]!.username, avatarUrl: null },
  ]);
  expect(row.members).toHaveLength(6);
});

test("mentioned is true only for an unread top-level mention of the viewer", async () => {
  const conversation = await channel("mentions", [{ userId: ada.id }, { userId: grace.id }]);
  const graceMember = await memberOf(conversation.id, grace.id);
  const adaMember = await memberOf(conversation.id, ada.id);
  await post(conversation.id, 1, "hello ada", {
    senderMemberId: graceMember.id,
    mentionedMemberId: adaMember.id,
    mentioned: ada,
  });
  expect(rowOf(await channels.list(workspaceId, ada.id), conversation.id).mentioned).toBe(true);

  // Reading past the mention clears it.
  await db.conversationMember.update({
    where: { id: adaMember.id },
    data: { readThroughSequence: 1 },
  });
  expect(rowOf(await channels.list(workspaceId, ada.id), conversation.id).mentioned).toBe(false);
});

test("a mention inside a thread does not make the channel mentioned", async () => {
  const conversation = await channel("thread-mention", [{ userId: ada.id }, { userId: grace.id }]);
  const graceMember = await memberOf(conversation.id, grace.id);
  const adaMember = await memberOf(conversation.id, ada.id);
  const root = await post(conversation.id, 1, "a top-level message", {
    senderMemberId: graceMember.id,
  });
  await post(conversation.id, 2, "ada, look here", {
    senderMemberId: graceMember.id,
    threadRootId: root.id,
    mentionedMemberId: adaMember.id,
    mentioned: ada,
  });

  expect(rowOf(await channels.list(workspaceId, ada.id), conversation.id).mentioned).toBe(false);
});

test("a channel the viewer has not joined still shows its preview and members, never mentioned", async () => {
  const conversation = await channel("not-joined", [{ userId: grace.id }, { userId: lin.id }]);
  const graceMember = await memberOf(conversation.id, grace.id);
  await post(conversation.id, 1, "a message nobody told ada about", {
    senderMemberId: graceMember.id,
  });

  const row = rowOf(await channels.list(workspaceId, ada.id), conversation.id);
  expect(row.joined).toBe(false);
  expect(row.mentioned).toBe(false);
  expect(row.lastMessage?.preview).toBe("a message nobody told ada about");
  expect(row.members.map((member) => member.id).sort()).toEqual([grace.id, lin.id].sort());
});

test("each channel shows its own last message and members", async () => {
  const first = await channel("own-first", [{ userId: grace.id }]);
  const second = await channel("own-second", [{ userId: lin.id }, { agentId: helper.id }]);
  await post(first.id, 1, "first channel news", {
    senderMemberId: (await memberOf(first.id, grace.id)).id,
  });
  await post(second.id, 1, "second channel news", {
    senderMemberId: (await memberOf(second.id, lin.id)).id,
  });

  const rows = await channels.list(workspaceId, ada.id);
  expect(rowOf(rows, first.id).lastMessage?.preview).toBe("first channel news");
  expect(rowOf(rows, first.id).members.map((member) => member.name)).toEqual([grace.username]);
  expect(rowOf(rows, second.id).lastMessage?.preview).toBe("second channel news");
  expect(rowOf(rows, second.id).members.map((member) => member.name)).toEqual([
    lin.username,
    "Helper",
  ]);
});
