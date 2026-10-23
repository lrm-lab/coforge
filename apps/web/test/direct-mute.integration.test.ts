import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";

/**
 * A DM's mute: each participant's own `channelMuted`, off by default, for a DM with an Agent, one
 * between members and a member's own. The sidebar's DM list reads it back per DM, and a muted DM
 * sends the viewer no Web Push unless they are @mentioned in it (the channel rule). Drives the real
 * `DirectConversations` and Web Push store against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;
const suffix = crypto.randomUUID().slice(0, 8);
const slug = `dmu-${suffix}`;
const usernames = ["ada", "grace", "eve"].map((name) => `dmu-${name}-${suffix}`);
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
      name: "DM mute",
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
  await db.userPreference.createMany({
    data: [ada.id, grace.id].map((userId) => ({ userId, browserNotificationsEnabled: true })),
  });
  await db.webPushSubscription.createMany({
    data: [ada.id, grace.id].map((userId) => ({
      userId,
      endpoint: `https://fcm.googleapis.com/wp/${userId}`,
      p256dh: "p",
      auth: "a",
    })),
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

async function listedMuted(conversations: DirectConversations, userId: string) {
  const { conversations: listed } = await conversations.list(workspaceId, userId);
  return Object.fromEntries(listed.map((row) => [row.conversationId, row.muted]));
}

test.skipIf(!db)(
  "a DM is audible by default; each participant mutes it for themself only",
  async () => {
    const conversations = new DirectConversations(db!);
    const { conversationId } = await conversations.open(workspaceId, ada.id, { userId: grace.id });
    const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
    expect((await listedMuted(conversations, ada.id))[conversationId]).toBe(false);

    expect(await conversations.setMuted(workspaceId, ada.id, conversationId, true)).toEqual({
      muted: true,
    });
    const adas = await listedMuted(conversations, ada.id);
    expect(adas[conversationId]).toBe(true);
    // ada's other DM, and the other participant's view of the same DM, are untouched.
    expect(adas[withAgent.conversationId]).toBe(false);
    expect((await listedMuted(conversations, grace.id))[conversationId]).toBe(false);

    await conversations.setMuted(workspaceId, ada.id, conversationId, false);
    expect((await listedMuted(conversations, ada.id))[conversationId]).toBe(false);
  },
);

test.skipIf(!db)("a DM with an Agent and a member's DM with themself can be muted", async () => {
  const conversations = new DirectConversations(db!);
  const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  await conversations.setMuted(workspaceId, ada.id, withAgent.conversationId, true);
  expect((await listedMuted(conversations, ada.id))[withAgent.conversationId]).toBe(true);

  const own = await conversations.open(workspaceId, eve.id, { userId: eve.id });
  await conversations.setMuted(workspaceId, eve.id, own.conversationId, true);
  expect((await listedMuted(conversations, eve.id))[own.conversationId]).toBe(true);
});

test.skipIf(!db)("only a DM's own participant mutes it", async () => {
  const conversations = new DirectConversations(db!);
  const { conversationId } = await conversations.open(workspaceId, ada.id, { userId: grace.id });
  expect(
    await appErrorCode(conversations.setMuted(workspaceId, eve.id, conversationId, true)),
  ).toBe("NOT_FOUND");
  // Another member's DM with an Agent is not the viewer's either.
  const withAgent = await conversations.open(workspaceId, ada.id, { agentId: helper.id });
  expect(
    await appErrorCode(
      conversations.setMuted(workspaceId, grace.id, withAgent.conversationId, true),
    ),
  ).toBe("NOT_FOUND");
  expect((await listedMuted(conversations, ada.id))[conversationId]).toBe(false);
});

test.skipIf(!db)("a muted DM sends no Web Push unless the viewer is @mentioned in it", async () => {
  const conversations = new DirectConversations(db!);
  const push = new PrismaWebPushSubscriptionStore(db!);
  const { conversationId } = await conversations.open(workspaceId, grace.id, { userId: ada.id });
  const graceMember = await db!.conversationMember.findFirstOrThrow({
    where: { conversationId, userId: grace.id },
  });
  const adaMember = await db!.conversationMember.findFirstOrThrow({
    where: { conversationId, userId: ada.id },
  });
  let sequence = 0;
  const messageFromGrace = async (mention: boolean) => {
    const message = await db!.message.create({
      data: {
        conversationId,
        workspaceId,
        senderMemberId: graceMember.id,
        body: "ping",
        sequence: (sequence += 1),
      },
    });
    if (mention)
      await db!.messageMention.create({
        data: {
          messageId: message.id,
          memberId: adaMember.id,
          conversationId,
          workspaceId,
          kind: "user",
          actorId: ada.id,
          handle: usernames[0]!,
        },
      });
    return message.id;
  };
  const recipients = async (messageId: string) =>
    (await push.notificationForMessage(messageId))?.recipients.map((row) => row.userId) ?? [];

  expect(await recipients(await messageFromGrace(false))).toEqual([ada.id]);

  await conversations.setMuted(workspaceId, ada.id, conversationId, true);
  const ordinary = await messageFromGrace(false);
  expect(await recipients(ordinary)).toEqual([]);
  expect(await push.notificationForRecipient(ordinary, ada.id)).toBeNull();

  const mentioned = await messageFromGrace(true);
  expect(await recipients(mentioned)).toEqual([ada.id]);
  expect(await push.notificationForRecipient(mentioned, ada.id)).not.toBeNull();
});
