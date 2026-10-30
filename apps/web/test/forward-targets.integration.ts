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

async function channel(name: string, members: { id: string }[], archivedAt?: Date) {
  return db.conversation.create({
    data: {
      workspaceId,
      channelName: `${name}-${suffix}`,
      archivedAt,
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
  expect(channelTarget(news.id)).toMatchObject({ joined: true, canSend: true });
  expect(channelTarget(archived.id)).toMatchObject({ joined: true, canSend: false });
  expect(channelTarget(solo.id)).toMatchObject({ joined: false, canSend: true });
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
