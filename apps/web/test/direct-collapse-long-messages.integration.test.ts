import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";

/**
 * A DM's "collapse long messages" preference: each participant's own, default on, for a DM with an
 * Agent, one between members and a member's own. Drives the real `DirectConversations` against
 * local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;
const suffix = crypto.randomUUID().slice(0, 8);
const slug = `dcl-${suffix}`;
const usernames = ["ada", "grace", "eve"].map((name) => `dcl-${name}-${suffix}`);
let ada: { id: string };
let grace: { id: string };
let eve: { id: string };
let helper: { id: string };
let workspaceId: string;

beforeAll(async () => {
  if (!db) return;
  [ada, grace, eve] = await Promise.all(
    usernames.map((username) => db.user.create({ data: { displayName: username, username } })),
  );
  const workspace = await db.workspace.create({
    data: {
      slug,
      name: "DM collapse",
      members: { create: [{ userId: ada.id }, { userId: grace.id }, { userId: eve.id }] },
    },
  });
  workspaceId = workspace.id;
  helper = await db.agent.create({
    data: {
      workspaceId,
      ownerId: ada.id,
      name: `helper-${suffix}`,
      displayName: "Helper",
      visibility: "public",
      runtimeConfig: {},
    },
  });
});

afterAll(async () => {
  if (!db) return;
  await db.workspace.deleteMany({ where: { slug } });
  await db.user.deleteMany({ where: { username: { in: usernames } } });
  await db.$disconnect();
});

async function appErrorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

test.skipIf(!db)(
  "a DM shows long messages in full by default; each participant turns folding on for themself only",
  async () => {
    const conversations = new DirectConversations(db!);
    const { conversationId } = await conversations.open(workspaceId, ada.id, { userId: grace.id });
    expect(
      (await conversations.page(workspaceId, ada.id, conversationId)).collapseLongMessages,
    ).toBe(false);

    expect(
      await conversations.setCollapseLongMessages(workspaceId, ada.id, conversationId, true),
    ).toEqual({ collapseLongMessages: true });
    expect(
      (await conversations.page(workspaceId, ada.id, conversationId)).collapseLongMessages,
    ).toBe(true);
    // The other participant's view of the same DM, and ada's other DMs, are untouched.
    expect(
      (await conversations.page(workspaceId, grace.id, conversationId)).collapseLongMessages,
    ).toBe(false);
    const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
    expect(
      (await conversations.page(workspaceId, ada.id, withAgent.conversationId))
        .collapseLongMessages,
    ).toBe(false);

    await conversations.setCollapseLongMessages(workspaceId, ada.id, conversationId, false);
    expect(
      (await conversations.page(workspaceId, ada.id, conversationId)).collapseLongMessages,
    ).toBe(false);
  },
);

test.skipIf(!db)(
  "a DM with an Agent and a member's DM with themself keep their own setting",
  async () => {
    const conversations = new DirectConversations(db!);
    const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
    await conversations.setCollapseLongMessages(
      workspaceId,
      ada.id,
      withAgent.conversationId,
      false,
    );
    expect(
      (await conversations.page(workspaceId, ada.id, withAgent.conversationId))
        .collapseLongMessages,
    ).toBe(false);

    const own = await conversations.open(workspaceId, eve.id, { userId: eve.id });
    await conversations.setCollapseLongMessages(workspaceId, eve.id, own.conversationId, false);
    expect(
      (await conversations.page(workspaceId, eve.id, own.conversationId)).collapseLongMessages,
    ).toBe(false);
  },
);

test.skipIf(!db)("only a DM's own participant changes its setting", async () => {
  const conversations = new DirectConversations(db!);
  const { conversationId } = await conversations.open(workspaceId, ada.id, { userId: grace.id });
  expect(
    await appErrorCode(
      conversations.setCollapseLongMessages(workspaceId, eve.id, conversationId, false),
    ),
  ).toBe("NOT_FOUND");
  // Another member's DM with an Agent is not the viewer's either.
  const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  expect(
    await appErrorCode(
      conversations.setCollapseLongMessages(workspaceId, grace.id, withAgent.conversationId, false),
    ),
  ).toBe("NOT_FOUND");
  expect((await conversations.page(workspaceId, ada.id, conversationId)).collapseLongMessages).toBe(
    true,
  );
});
