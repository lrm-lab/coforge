import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { searchForwardTargets } from "#src/server/conversations/forward-targets.server";
import { openPeopleDirectConversation } from "#src/server/conversations/user-direct-conversations.server";

/** The picker behind a forward: what it finds, and what it says about each place. */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = crypto.randomUUID().slice(0, 8);
let workspaceId: string;
let alice: { id: string };
let bob: { id: string };
let carol: { id: string };
let dmWithBob: string;

async function channel(
  name: string,
  members: { id: string }[],
  archivedAt?: Date,
  visibility: "public" | "private" = "public",
) {
  return db.conversation.create({
    data: {
      workspaceId,
      channelName: `${name}-${suffix}`,
      archivedAt,
      visibility,
      members: {
        create: members.map((user) => ({
          workspace: { connect: { id: workspaceId } },
          user: { connect: { id: user.id } },
        })),
      },
    },
  });
}

beforeAll(async () => {
  const users = await Promise.all(
    ["alice", "bob", "carol"].map((name) =>
      db.user.create({
        data: {
          username: `pick-${name}-${suffix}`,
          displayName: name[0]!.toUpperCase() + name.slice(1),
        },
      }),
    ),
  );
  alice = users[0]!;
  bob = users[1]!;
  carol = users[2]!;
  const workspace = await db.workspace.create({
    data: {
      slug: `pick-${suffix}`,
      name: "Picker",
      members: { create: users.map((user) => ({ userId: user.id })) },
    },
  });
  workspaceId = workspace.id;
  dmWithBob = (await openPeopleDirectConversation(db, workspaceId, alice.id, bob.id))
    .conversationId;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { username: { endsWith: `-${suffix}` } } });
  await db.$disconnect();
});

test("finds channels, members and Agents with whether each is joined and can take a forward", async () => {
  const news = await channel("news", [alice, bob]);
  const archived = await channel("old", [alice, bob], new Date());
  const solo = await channel("solo", [bob]);
  const vault = await channel("vault", [alice, bob], undefined, "private");
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `pick-finder-${suffix}`,
      displayName: "Finder",
      ownerId: alice.id,
      runtimeConfig: {},
    },
  });
  const all = await searchForwardTargets(db, { workspaceId, userId: alice.id, q: "", limit: 50 });
  const channelTarget = (conversationId: string) =>
    all.find((target) => target.kind === "channel" && target.conversationId === conversationId);
  expect(channelTarget(news.id)).toMatchObject({
    joined: true,
    canSend: true,
    visibility: "public",
  });
  // A private channel goes with its visibility, so the picker shows its lock, not `#`.
  expect(channelTarget(vault.id)).toMatchObject({ joined: true, visibility: "private" });
  expect(channelTarget(archived.id)).toMatchObject({ joined: true, canSend: false });
  expect(channelTarget(solo.id)).toMatchObject({ joined: false, canSend: true });
  // Each channel brings its group avatar's members, as the sidebar draws it, joined or not.
  const avatarIds = (conversationId: string) => {
    const target = channelTarget(conversationId);
    return target?.kind === "channel" ? target.members.map((member) => member.id).sort() : [];
  };
  expect(avatarIds(news.id)).toEqual([alice.id, bob.id].sort());
  expect(avatarIds(solo.id)).toEqual([bob.id]);
  // Members come with the DM they already have; one without a DM has none to name.
  expect(all.find((target) => target.kind === "person" && target.userId === bob.id)).toMatchObject({
    name: "Bob",
    conversationId: dmWithBob,
  });
  expect(
    all.find((target) => target.kind === "person" && target.userId === carol.id),
  ).not.toHaveProperty("conversationId");
  expect(
    all.find((target) => target.kind === "agent" && target.agentId === agent.id),
  ).toMatchObject({
    name: "Finder",
    handle: agent.name,
    joined: true,
    canSend: true,
  });
});

test("finds a person by the name they are shown by, never by username, and keeps its limit", async () => {
  const byName = await searchForwardTargets(db, {
    workspaceId,
    userId: alice.id,
    q: "carol",
    limit: 20,
  });
  expect(byName.map((target) => target.kind === "person" && target.userId)).toContain(carol.id);
  const byUsername = await searchForwardTargets(db, {
    workspaceId,
    userId: alice.id,
    q: `pick-carol-${suffix}`,
    limit: 20,
  });
  expect(byUsername.some((target) => target.kind === "person")).toBe(false);
  expect(
    await searchForwardTargets(db, { workspaceId, userId: alice.id, q: "", limit: 2 }),
  ).toHaveLength(2);
});

let sequence = 1_000;
/** `times` forwards by `user` into a conversation, at `at` (later ones a second apart). */
async function forwardInto(user: { id: string }, conversationId: string, times: number, at: Date) {
  const member = await db.conversationMember.findFirstOrThrow({
    where: { conversationId, userId: user.id },
  });
  for (let index = 0; index < times; index += 1)
    await db.message.create({
      data: {
        workspaceId,
        conversationId,
        senderMemberId: member.id,
        sequence: (sequence += 1),
        body: "",
        createdAt: new Date(at.getTime() + index * 1_000),
        forwards: {
          create: {
            position: 0,
            sourceConversationId: conversationId,
            sourceSenderName: "Source",
            sourceSenderHandle: "source",
            sourceCreatedAt: at,
            sourceBody: "forwarded",
          },
        },
      },
    });
}

test("puts where the viewer forwards most first, and never a place they can no longer reach", async () => {
  const busy = await channel("busy", [alice, bob]);
  const quiet = await channel("quiet", [alice, bob]);
  const secret = await channel("secret", [alice, bob], undefined, "private");
  const earlier = new Date("2026-01-01T00:00:00Z");
  const later = new Date("2026-02-01T00:00:00Z");
  // Busy and the DM with Bob tie on three; the DM's are later. Quiet has one of Alice's, and many
  // of Bob's, which are his, not hers.
  await forwardInto(alice, busy.id, 3, earlier);
  await forwardInto(alice, dmWithBob, 3, later);
  await forwardInto(alice, quiet.id, 1, earlier);
  await forwardInto(bob, quiet.id, 10, later);
  // The most of all went to a private channel Alice has since left.
  await forwardInto(alice, secret.id, 5, later);
  await db.conversationMember.updateMany({
    where: { conversationId: secret.id, userId: alice.id },
    data: { leftAt: new Date() },
  });

  const all = await searchForwardTargets(db, { workspaceId, userId: alice.id, q: "", limit: 50 });
  const key = (target: (typeof all)[number]) =>
    target.kind === "channel"
      ? target.conversationId
      : target.kind === "person"
        ? target.userId
        : target.agentId;
  expect(all.slice(0, 3).map(key)).toEqual([bob.id, busy.id, quiet.id]);
  // Forwarded to, but no longer theirs to reach: not listed at all.
  expect(
    all.some((target) => target.kind === "channel" && target.conversationId === secret.id),
  ).toBe(false);
  // A search keeps the order among what it matches.
  const found = await searchForwardTargets(db, {
    workspaceId,
    userId: alice.id,
    q: "u",
    limit: 50,
  });
  expect(found.slice(0, 2).map(key)).toEqual([busy.id, quiet.id]);
});
