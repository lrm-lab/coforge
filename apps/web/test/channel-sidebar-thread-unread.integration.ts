import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { ViewerEvent } from "#src/features/conversations/conversation-realtime";
import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { workspaceChannelThreadUnreadsSql } from "#src/server/conversations/channel-thread-unread.server";
import { enrollGeneral } from "./helpers/general-channel-fixture";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

function recordingRealtime() {
  const viewerEvents: { userIds: readonly string[]; event: ViewerEvent }[] = [];
  const activities: { userIds: readonly string[]; event: ConversationActivityEvent }[] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged() {},
    async channelUpdated() {},
    async viewerChanged(input) {
      viewerEvents.push(input);
    },
    async viewerEventsChanged(input) {
      for (const event of input.events) viewerEvents.push({ userIds: input.userIds, event });
    },
    async conversationActivity(input) {
      activities.push(input);
    },
    async conversationReadChanged() {},
    async activityChanged() {},
  };
  return { realtime, viewerEvents, activities };
}

test("channel sidebar thread unreads: counts distinct followed non-task threads, separates channel vs thread @, and clears per Raft rules", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const ada = await db.user.create({
    data: { displayName: `Ada ${suffix}`, username: `ada-${suffix}` },
  });
  const bob = await db.user.create({
    data: { displayName: `Bob ${suffix}`, username: `bob-${suffix}` },
  });
  const carol = await db.user.create({
    data: { displayName: `Carol ${suffix}`, username: `carol-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `thr-${suffix}`,
      name: "Sidebar thread unread",
      members: {
        create: [
          { userId: ada.id, role: "owner" },
          { userId: bob.id, role: "member" },
          { userId: carol.id, role: "member" },
        ],
      },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const { realtime, viewerEvents, activities } = recordingRealtime();
    const idempotency = new RedisMessageRequestIdempotency(redis);
    const channels = new PublicChannels(db, idempotency, quietCentrifugo(), undefined, realtime);
    const directs = new DirectConversations(db, realtime);

    const team = await channels.create(workspace.id, ada.id, `team-${suffix}`);
    await channels.join(workspace.id, bob.id, team.id);
    await channels.join(workspace.id, carol.id, team.id);

    const send = (userId: string, body: string, options?: { threadRootId?: string }) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: team.id,
        body,
        threadRootId: options?.threadRootId,
        idempotencyKey: crypto.randomUUID(),
      });

    const rowFor = async (userId: string) =>
      (await channels.list(workspace.id, userId)).find((row) => row.id === team.id)!;

    const root1 = await send(bob.id, "thread one root");
    const root2 = await send(bob.id, "thread two root");
    await channels.markRead(workspace.id, bob.id, team.id, 10_000);

    await channels.setUserThreadFollowed(workspace.id, carol.id, team.id, root1.id, true);
    await channels.markRead(workspace.id, carol.id, team.id, 10_000);
    await channels.setUserMuted(workspace.id, carol.id, team.id, true);

    activities.length = 0;
    await send(ada.id, `first reply @${bob.username}`, {
      threadRootId: root1.id,
    });
    const r1Second = await send(ada.id, "second reply in same thread", {
      threadRootId: root1.id,
    });
    const r2First = await send(ada.id, "reply in second thread", {
      threadRootId: root2.id,
    });

    const bobRowBeforeOpen = await rowFor(bob.id);
    expect(bobRowBeforeOpen.unreadCount).toBe(0);
    expect(bobRowBeforeOpen.mentioned).toBe(false);
    expect(bobRowBeforeOpen.unreadThreadCount).toBe(2);
    expect(bobRowBeforeOpen.threadMentioned).toBe(true);

    const carolRow = await rowFor(carol.id);
    expect(carolRow.muted).toBe(true);
    expect(carolRow.unreadThreadCount).toBe(1);
    expect(carolRow.threadMentioned ?? false).toBe(false);
    const bobLatestActivity = activities
      .filter((entry) => entry.userIds.includes(bob.id))
      .at(-1)?.event;
    expect(bobLatestActivity?.unreadThreadCount).toBe(2);
    expect(bobLatestActivity?.threadMentioned).toBe(true);

    const topMsg = await send(ada.id, `top level ping @${carol.username}`);
    expect((await rowFor(carol.id)).mentioned).toBe(true);
    expect((await rowFor(bob.id)).unreadCount).toBe(1);

    viewerEvents.length = 0;
    await channels.markRead(workspace.id, bob.id, team.id, topMsg.sequence);
    const bobAfterChannelOpen = await rowFor(bob.id);
    expect(bobAfterChannelOpen.unreadCount).toBe(0);
    expect(bobAfterChannelOpen.mentioned).toBe(false);
    expect(bobAfterChannelOpen.unreadThreadCount).toBe(2);
    expect(bobAfterChannelOpen.threadMentioned).toBe(true);
    expect(viewerEvents.find((e) => e.userIds.includes(bob.id))?.event).toMatchObject({
      type: "channel.marked.v1",
      conversationId: team.id,
      unreadCount: 0,
      unreadThreadCount: 2,
      threadMentioned: true,
    });

    viewerEvents.length = 0;
    await channels.markThreadReadForUser(
      workspace.id,
      bob.id,
      team.id,
      root1.id,
      r1Second.sequence,
    );
    expect(await rowFor(bob.id)).toMatchObject({
      unreadCount: 0,
      unreadThreadCount: 1,
    });
    expect((await rowFor(bob.id)).threadMentioned ?? false).toBe(false);
    const afterRoot1Event = viewerEvents.find((e) => e.userIds.includes(bob.id))?.event;
    expect(afterRoot1Event).toEqual({
      type: "channel.marked.v1",
      workspaceId: workspace.id,
      conversationId: team.id,
      unreadCount: 0,
      readThroughSequence: topMsg.sequence,
      unreadThreadCount: 1,
    });

    viewerEvents.length = 0;
    await channels.markThreadReadForUser(workspace.id, bob.id, team.id, root2.id, r2First.sequence);
    const bobAllThreadsRead = await rowFor(bob.id);
    expect(bobAllThreadsRead.unreadThreadCount ?? 0).toBe(0);
    expect(bobAllThreadsRead.threadMentioned ?? false).toBe(false);
    expect(viewerEvents.find((e) => e.userIds.includes(bob.id))?.event).toEqual({
      type: "channel.marked.v1",
      workspaceId: workspace.id,
      conversationId: team.id,
      unreadCount: 0,
      readThroughSequence: topMsg.sequence,
    });

    await send(ada.id, "new top message");
    await send(ada.id, `another thread reply @${bob.username}`, {
      threadRootId: root1.id,
    });
    await channels.setUserUnread(workspace.id, bob.id, team.id, true);
    expect((await rowFor(bob.id)).markedUnread).toBe(true);
    expect((await rowFor(bob.id)).unreadThreadCount).toBe(1);

    viewerEvents.length = 0;
    await channels.markAllRead(workspace.id, bob.id, team.id);
    const bobAfterMarkAll = await rowFor(bob.id);
    expect(bobAfterMarkAll.unreadCount).toBe(0);
    expect(bobAfterMarkAll.markedUnread ?? false).toBe(false);
    expect(bobAfterMarkAll.mentioned).toBe(false);
    expect(bobAfterMarkAll.unreadThreadCount ?? 0).toBe(0);
    expect(bobAfterMarkAll.threadMentioned ?? false).toBe(false);
    expect(viewerEvents.find((e) => e.userIds.includes(bob.id))?.event).toMatchObject({
      type: "channel.marked.v1",
      conversationId: team.id,
      unreadCount: 0,
    });

    const legacyTaskRoot = await send(bob.id, "legacy task root");
    await channels.markAllRead(workspace.id, bob.id, team.id);
    const bobMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: team.id, userId: bob.id },
    });
    await db.task.create({
      data: {
        workspaceId: workspace.id,
        conversationId: team.id,
        messageId: legacyTaskRoot.id,
        number: 1,
        title: "Legacy task",
        creatorMemberId: bobMember.id,
      },
    });
    await channels.setUserThreadFollowed(workspace.id, bob.id, team.id, legacyTaskRoot.id, true);
    activities.length = 0;
    await send(ada.id, `reply on legacy task @${bob.username}`, {
      threadRootId: legacyTaskRoot.id,
    });

    const taskConv = new TaskConversations({ db, reader: "people", dependencies: {} });
    const modernTask = await db.task.create({
      data: {
        workspaceId: workspace.id,
        conversationId: team.id,
        number: 2,
        title: "Modern task",
        creatorMemberId: bobMember.id,
      },
    });
    await db.taskFollow.create({
      data: {
        taskId: modernTask.id,
        memberId: bobMember.id,
        conversationId: team.id,
        workspaceId: workspace.id,
        reason: "created",
      },
    });
    await taskConv.reply(
      { workspaceId: workspace.id, userId: ada.id },
      { conversationId: team.id, number: modernTask.number },
      { body: "reply inside modern task conversation", idempotencyKey: crypto.randomUUID() },
    );

    const bobAfterTaskReplies = await rowFor(bob.id);
    expect(bobAfterTaskReplies.unreadThreadCount ?? 0).toBe(0);
    expect(bobAfterTaskReplies.threadMentioned ?? false).toBe(false);
    expect(
      activities.find((entry) => entry.userIds.includes(bob.id))?.event.unreadThreadCount,
    ).toBeUndefined();

    const dm = await directs.open(workspace.id, bob.id, { userId: ada.id });
    await directs.send(
      workspace.id,
      ada.id,
      dm.conversationId,
      { idempotencyKey: crypto.randomUUID(), body: "dm hello" },
      { idempotency, centrifugo: quietCentrifugo(), realtime },
    );
    await directs.markAllRead(workspace.id, bob.id, dm.conversationId);
    const dmMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: dm.conversationId, userId: bob.id },
    });
    expect(dmMember.unreadFromSequence).toBeNull();
    expect(dmMember.readThroughSequence).toBeGreaterThan(0);

    for (let i = 0; i < 25; i++) {
      const extraRoot = await send(bob.id, `bulk thread ${i}`);
      await send(ada.id, `bulk reply ${i}`, { threadRootId: extraRoot.id });
    }
    const explainRows = await db.$queryRaw<{ "QUERY PLAN": unknown }[]>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${workspaceChannelThreadUnreadsSql(workspace.id, bob.id)}`,
    );
    const seqScans: string[] = [];
    const walkPlan = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walkPlan(item);
        return;
      }
      const record = node as Record<string, unknown>;
      if (record["Node Type"] === "Seq Scan" && typeof record["Relation Name"] === "string") {
        seqScans.push(record["Relation Name"]);
      }
      for (const value of Object.values(record)) walkPlan(value);
    };
    walkPlan(explainRows);
    expect(seqScans.filter((rel) => rel === "messages" || rel === "message_mentions")).toEqual([]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [ada.id, bob.id, carol.id] } } });
    redis.close();
    await db.$disconnect();
  }
});
