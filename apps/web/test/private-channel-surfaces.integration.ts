import { afterAll, beforeAll, expect, test } from "bun:test";
import { actionCardViews } from "#src/server/conversations/action-card-views.server";
import { MessageForwards } from "#src/server/conversations/message-forwards.server";
import { PrismaWorkspaceMemoryCatalog } from "#src/server/db/repositories/workspace-memory-catalog.repositories.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import {
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
} from "#src/server/agents/agent-reminders.server";
import { projectDetailSelect, projectListSelect } from "#src/server/projects/project-detail.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";
import { MemoryMessageRequestIdempotency } from "./helpers/memory-message-request-idempotency";
import {
  connectionString,
  privateChannelFixture,
  type PrivateChannelFixture,
} from "./helpers/private-channel-fixture";

/**
 * Task #302, step 5: the surfaces outside a channel's own pages keep a private channel to its
 * members too: a project's channel list and count, what Workspace memory learns from, a forward's
 * destination, a message notification read by id, and the channel an action card or an Agent's
 * reminder names.
 */
let fixture: PrivateChannelFixture;
let extra: Awaited<ReturnType<typeof setUp>>;

/** A project holding all three channels, an Agent's add-member card naming the private one in
 * the DM of the insider and the owner, and a discussion of the private channel's Task in which the
 * outsider kept a seat (as when the channel turned private after they followed it). */
async function setUp({
  db,
  ws,
  suffix,
  token,
  people,
  open,
  closed,
  vault,
  direct,
}: PrivateChannelFixture) {
  const project = await db.project.create({
    data: { workspaceId: ws, name: "Launch", slug: `launch-${suffix}` },
  });
  await db.conversation.updateMany({
    where: { id: { in: [open.id, closed.id, vault.id] } },
    data: { projectId: project.id },
  });

  const computer = await db.computer.create({
    data: { ownerId: people.insider, machineId: crypto.randomUUID() },
  });
  await db.workspaceComputer.create({ data: { workspaceId: ws, computerId: computer.id } });
  const scout = await db.agent.create({
    data: {
      workspaceId: ws,
      ownerId: people.insider,
      computerId: computer.id,
      name: `scout${suffix}`,
      displayName: "scout",
      runtimeConfig: {},
    },
  });
  const insiderDmSeat = await db.conversationMember.findFirstOrThrow({
    where: { conversationId: direct.id, userId: people.insider },
  });
  const cardMessage = await db.message.create({
    data: {
      workspaceId: ws,
      conversationId: direct.id,
      senderMemberId: insiderDmSeat.id,
      sequence: 2,
      body: "Add them to the channel",
    },
  });
  await db.actionCard.create({
    data: {
      messageId: cardMessage.id,
      conversationId: direct.id,
      workspaceId: ws,
      kind: "channel:add_member",
      payload: { type: "channel:add_member", channelId: closed.id, humanIds: [], agentIds: [] },
      preparedByAgentId: scout.id,
    },
  });

  const discussion = await db.conversation.create({
    data: {
      workspaceId: ws,
      kind: "task_thread",
      members: { create: [{ userId: people.insider }, { userId: people.outsider }] },
    },
    include: { members: true },
  });
  await db.task.update({
    where: { id: closed.message.id },
    data: { discussionConversationId: discussion.id },
  });
  const discussionMessage = await db.message.create({
    data: {
      workspaceId: ws,
      conversationId: discussion.id,
      senderMemberId: discussion.members.find((member) => member.userId === people.insider)!.id,
      sequence: 1,
      body: `${token} discussed in private`,
    },
  });
  for (const userId of Object.values(people)) {
    await db.userPreference.upsert({
      where: { userId },
      create: { userId, browserNotificationsEnabled: true },
      update: { browserNotificationsEnabled: true },
    });
  }
  return { project, computer, scout, cardMessage, discussionMessage };
}

beforeAll(async () => {
  if (!connectionString) return;
  fixture = await privateChannelFixture(connectionString);
  extra = await setUp(fixture);
});
afterAll(async () => {
  if (!fixture) return;
  const { db, ws } = fixture;
  await db.actionCard.deleteMany({ where: { workspaceId: ws } });
  // The computer outlives its Workspace and keeps its owner, so it goes before the people.
  await db.workspace.delete({ where: { id: ws } });
  if (extra) await db.computer.delete({ where: { id: extra.computer.id } });
  await fixture.dispose();
});

test.skipIf(!connectionString)(
  "a project lists a private channel only to its members",
  async () => {
    const { db, ws, people, open, closed, vault } = fixture;
    const listed = async (userId: string) =>
      (
        await db.project.findUniqueOrThrow({
          where: { id: extra.project.id },
          select: projectDetailSelect(ws, userId),
        })
      ).conversations.map((conversation) => conversation.id);
    for (const userId of fixture.outsiders) expect(await listed(userId)).toEqual([open.id]);
    expect(await listed(people.insider)).toEqual([open.id, closed.id, vault.id]);
    // The projects index counts the same channels.
    const counted = async (userId: string) =>
      (
        await db.project.findUniqueOrThrow({
          where: { id: extra.project.id },
          select: projectListSelect(ws, userId),
        })
      ).conversations.length;
    for (const userId of fixture.outsiders) expect(await counted(userId)).toBe(1);
    expect(await counted(people.insider)).toBe(3);
  },
);

test.skipIf(!connectionString)(
  "Workspace memory learns from public channels only, on a retry too",
  async () => {
    const { db, ws, open, closed, vault } = fixture;
    const catalog = new PrismaWorkspaceMemoryCatalog(db);
    const window = await catalog.loadAdmissionWindow(ws, null);
    expect(window.conversations.map((conversation) => conversation.id)).toEqual([open.id]);
    expect(window.messages.every((message) => message.conversationId === open.id)).toBe(true);
    expect(window.messages.length).toBeGreaterThan(0);
    const retried = await catalog.loadMessagesByIds(ws, [
      open.message.id,
      closed.message.id,
      vault.message.id,
    ]);
    expect(retried.map((message) => message.id)).toEqual([open.message.id]);
  },
);

test.skipIf(!connectionString)(
  "forwarding to a private channel outside it answers as a channel that is not there",
  async () => {
    const { db, ws, people, open, closed, vault } = fixture;
    const forwards = new MessageForwards({
      db,
      idempotency: new MemoryMessageRequestIdempotency(),
      centrifugo: quietCentrifugo(),
      storage: () => Promise.reject(new Error("a refused forward copies nothing")),
    });
    const refusals = async (userId: string, destinations: string[]) =>
      (
        await forwards.forward({
          workspaceId: ws,
          userId,
          requestId: crypto.randomUUID(),
          sourceMessageId: open.message.id,
          destinations,
        })
      ).results.map((result) => (result.status === "failed" ? result.error.code : "sent"));
    for (const userId of fixture.outsiders) {
      expect(await refusals(userId, [closed.id, vault.id, crypto.randomUUID()])).toEqual([
        "no_access",
        "no_access",
        "no_access",
      ]);
    }
    // A member is told why: the archived channel takes no message.
    expect(await refusals(people.insider, [vault.id])).toEqual(["archived"]);
  },
);

test.skipIf(!connectionString)(
  "a task discussion's message is never read as a notification by id",
  async () => {
    const { db, people, open } = fixture;
    const store = new PrismaWebPushSubscriptionStore(db);
    // The outsider's seat outlived their reading the private channel's Task.
    expect(
      await store.notificationForRecipient(extra.discussionMessage.id, people.outsider),
    ).toBeNull();
    expect(
      await store.notificationForRecipient(extra.discussionMessage.id, people.insider),
    ).toBeNull();
    // A channel's message still reads for a member it notifies.
    expect(await store.notificationForRecipient(open.message.id, people.owner)).toMatchObject({
      title: `#${open.name}`,
    });
  },
);

test.skipIf(!connectionString)(
  "an action card names a private channel only to its members",
  async () => {
    const { db, ws, people, closed } = fixture;
    const named = async (userId: string) => {
      const view = (await actionCardViews(db, ws, userId, [extra.cardMessage.id])).get(
        extra.cardMessage.id,
      );
      return view?.kind === "channel:add_member" ? view.channel.displayName : undefined;
    };
    expect(await named(people.owner)).toBe("unknown");
    expect(await named(people.insider)).toBe(closed.name);
  },
);

test.skipIf(!connectionString)(
  "an Agent's reminder names a private channel only to its members",
  async () => {
    const { db, ws, people, open, closed } = fixture;
    for (const message of [open.message, closed.message]) {
      await db.reminder.create({
        data: {
          workspaceId: ws,
          ownerAgentId: extra.scout.id,
          computerId: extra.computer.id,
          title: "Follow up",
          target: "self",
          messageId: message.id,
          fireAt: new Date("2026-12-01T09:00:00Z"),
        },
      });
    }
    const query = new AgentRemindersQuery(prismaAgentReminderReadStore(db));
    const anchored = async (userId: string) => {
      const listed = await query.list({ userId, workspaceId: ws }, { agentId: extra.scout.id });
      if (listed.status !== "ready") throw new Error(listed.status);
      return listed.reminders
        .map((reminder) => (reminder.anchor?.kind === "channel" ? reminder.anchor.channelId : null))
        .sort();
    };
    // The Workspace owner manages the insider's Agent but is not in the private channel.
    expect(await anchored(people.owner)).toEqual([open.id, null].sort());
    expect(await anchored(people.insider)).toEqual([open.id, closed.id].sort());
  },
);
