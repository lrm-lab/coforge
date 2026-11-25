import { expect, test } from "bun:test";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import {
  decodeViewerEvent,
  type ViewerEvent,
} from "#src/features/conversations/conversation-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { threadUnreadBatchInput } from "#src/features/conversations/thread-unread-inputs";
import {
  markThreadUnread,
  markVersionedThreadRead,
  loadThreadUnreadSnapshot,
} from "#src/server/conversations/thread-unread-marks.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { workspaceChannelThreadUnreads } from "#src/server/conversations/channel-thread-unread.server";
import { navHasUnread } from "#src/server/inbox/activity-attention.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { cleanup, database, isConversation, seed } from "./helpers/activity-inbox-fixture";

test("an unfollowed thread without replies is unread in Activity, its nav dot and the sidebar", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { workspace, alice, bob, channel, post } = await seed(db, suffix);
    const { conversation, aliceMember } = await channel("unread");
    const root = await post(conversation.id, aliceMember.id, "root");
    const scope = { workspaceId: workspace.id, userId: alice.id, conversationId: conversation.id };
    const { version } = await markThreadUnread(db, undefined, scope, root.id);

    const inbox = new ActivityInbox(db, {});
    const page = await inbox.list(workspace.id, alice.id, { filter: "unread" });
    expect(page.items.filter(isConversation)).toMatchObject([
      {
        thread: { root: { id: root.id } },
        latest: { id: root.id },
        unreadCount: 1,
        markedUnreadVersion: version,
        firstUnreadMessageId: null,
      },
    ]);
    expect((await navHasUnread(db, workspace.id, alice.id)).unreadKeys).toEqual([
      `thread:${root.id}`,
    ]);
    expect((await navHasUnread(db, workspace.id, bob.id)).unreadKeys).not.toContain(
      `thread:${root.id}`,
    );
    expect(
      (await workspaceChannelThreadUnreads(db, workspace.id, alice.id)).get(conversation.id),
    ).toEqual({ unreadThreadCount: 1, threadMentioned: false });
  } finally {
    await cleanup(db, suffix);
  }
});

test("Done compares the observed mark and clears the current mark without replies", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { workspace, alice, channel, post } = await seed(db, suffix);
    const { conversation, aliceMember } = await channel("unread");
    const root = await post(conversation.id, aliceMember.id, "root");
    const scope = { workspaceId: workspace.id, userId: alice.id, conversationId: conversation.id };
    const { version: stale } = await markThreadUnread(db, undefined, scope, root.id);
    const { version: current } = await markThreadUnread(db, undefined, scope, root.id);

    const inbox = new ActivityInbox(db, {});
    const done = {
      kind: "thread" as const,
      conversationId: conversation.id,
      rootMessageId: root.id,
      throughSequence: root.sequence,
    };
    await inbox.markDone(workspace.id, alice.id, { ...done, markedUnreadVersion: stale });
    expect((await inbox.navAttention(workspace.id, alice.id)).unreadKeys).toContain(
      `thread:${root.id}`,
    );
    await inbox.markDone(workspace.id, alice.id, { ...done, markedUnreadVersion: current });
    expect((await inbox.navAttention(workspace.id, alice.id)).unreadKeys).not.toContain(
      `thread:${root.id}`,
    );
    const row = await db.threadRead.findUniqueOrThrow({
      where: { memberId_rootMessageId: { memberId: aliceMember.id, rootMessageId: root.id } },
    });
    expect(row).toMatchObject({
      readThroughSequence: 0,
      doneThroughSequence: null,
      markedUnreadVersion: null,
    });
  } finally {
    await cleanup(db, suffix);
  }
});

test("a stale read advances the DM cursor but the viewer's new mark survives until it is confirmed", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { workspace, alice, bob, post } = await seed(db, suffix);
    const conversation = await db.conversation.create({
      data: { workspaceId: workspace.id, directKey: peopleDirectKey(alice.id, bob.id) },
    });
    const aliceMember = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: conversation.id, userId: alice.id },
    });
    const bobMember = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: conversation.id, userId: bob.id },
    });
    const root = await post(conversation.id, aliceMember.id, "root");
    const earlier = await post(conversation.id, bobMember.id, "earlier", { threadRootId: root.id });
    const reply = await post(conversation.id, bobMember.id, "reply", { threadRootId: root.id });
    const scope = { workspaceId: workspace.id, userId: alice.id, conversationId: conversation.id };
    const events: { userIds: readonly string[]; event: ViewerEvent }[] = [];
    const realtime = {
      async viewerChanged(input: (typeof events)[number]) {
        events.push(input);
      },
    };
    const first = await markThreadUnread(db, realtime, scope, root.id);
    const second = await markThreadUnread(db, realtime, scope, root.id);
    expect(first.version).not.toBe(second.version);
    await new DirectConversations(db).markThreadRead(
      workspace.id,
      alice.id,
      conversation.id,
      root.id,
      earlier.sequence,
    );
    await markVersionedThreadRead(db, realtime, scope, first, reply.sequence);
    const where = { memberId_rootMessageId: { memberId: aliceMember.id, rootMessageId: root.id } };
    expect(await db.threadRead.findUniqueOrThrow({ where })).toMatchObject({
      readThroughSequence: reply.sequence,
      markedUnreadVersion: second.version,
    });
    await markVersionedThreadRead(
      db,
      realtime,
      { ...scope, userId: bob.id },
      second,
      reply.sequence,
    );
    expect((await db.threadRead.findUniqueOrThrow({ where })).markedUnreadVersion).toBe(
      second.version,
    );
    await markVersionedThreadRead(db, realtime, scope, second, reply.sequence);
    expect(await db.threadRead.findUniqueOrThrow({ where })).toMatchObject({
      readThroughSequence: reply.sequence,
      doneThroughSequence: null,
      markedUnreadVersion: null,
    });
    expect(events.map(({ userIds, event }) => [userIds, decodeViewerEvent(event)])).toEqual(
      (
        [
          { action: "marked", mark: first },
          { action: "marked", mark: second },
          { action: "cleared", mark: second },
        ] as const
      ).map(({ action, mark }) => [
        [alice.id],
        {
          ...mark,
          workspaceId: workspace.id,
          conversationId: conversation.id,
          type: REALTIME_EVENTS.threadUnreadChanged,
          action,
        },
      ]),
    );
  } finally {
    await cleanup(db, suffix);
  }
});

test("a read-all snapshot covers every mark and retrying its original batch preserves later changes", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { workspace, alice, bob, channel, post } = await seed(db, suffix);
    const { conversation, aliceMember, bobMember } = await channel("unread");
    const scope = { workspaceId: workspace.id, userId: alice.id, conversationId: conversation.id };
    const first = await post(conversation.id, aliceMember.id, "first");
    const second = await post(conversation.id, aliceMember.id, "second");
    const firstMark = await markThreadUnread(db, undefined, scope, first.id);
    const secondMark = await markThreadUnread(db, undefined, scope, second.id);
    const snapshot = await loadThreadUnreadSnapshot(db, scope);
    expect(snapshot.throughSequence).toBe(second.sequence);
    expect(snapshot.marks).toEqual([firstMark, secondMark]);
    expect((await loadThreadUnreadSnapshot(db, { ...scope, userId: bob.id })).marks).toEqual([]);
    const channels = new PublicChannels(db);
    const operationId = crypto.randomUUID();
    const firstBatch = threadUnreadBatchInput.parse({
      ...snapshot,
      operationId,
      marks: [firstMark],
    });
    const fullBatch = Array.from({ length: 200 }, () => ({
      rootMessageId: crypto.randomUUID(),
      version: crypto.randomUUID(),
    }));
    expect(threadUnreadBatchInput.safeParse({ ...firstBatch, marks: fullBatch }).success).toBe(
      true,
    );
    expect(
      threadUnreadBatchInput.safeParse({ ...firstBatch, marks: [...fullBatch, firstMark] }).success,
    ).toBe(false);
    await channels.markAllRead(workspace.id, alice.id, conversation.id, firstBatch);
    const later = await post(conversation.id, bobMember.id, "later");
    const updated = await markThreadUnread(db, undefined, scope, first.id);
    await channels.markAllRead(workspace.id, alice.id, conversation.id, firstBatch);
    await channels.markAllRead(workspace.id, alice.id, conversation.id, {
      ...firstBatch,
      marks: [secondMark],
    });
    expect(await loadThreadUnreadSnapshot(db, scope)).toEqual({
      throughSequence: later.sequence,
      marks: [updated],
    });
    const member = await db.conversationMember.findUniqueOrThrow({ where: { id: aliceMember.id } });
    expect(member.readThroughSequence).toBe(snapshot.throughSequence);
    expect(await db.threadFollow.count({ where: { memberId: aliceMember.id } })).toBe(0);
  } finally {
    await cleanup(db, suffix);
  }
});

test("Activity keeps a real first unread reply and restores a Done thread when it is marked again", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { workspace, alice, channel, post } = await seed(db, suffix);
    const { conversation, aliceMember, bobMember } = await channel("unread");
    const scope = { workspaceId: workspace.id, userId: alice.id, conversationId: conversation.id };
    const root = await post(conversation.id, aliceMember.id, "root");
    const reply = await post(conversation.id, bobMember.id, "reply", {
      threadRootId: root.id,
      mentionMemberIds: [aliceMember.id],
    });
    await db.threadFollow.create({
      data: {
        memberId: aliceMember.id,
        workspaceId: workspace.id,
        conversationId: conversation.id,
        rootMessageId: root.id,
      },
    });
    const { version } = await markThreadUnread(db, undefined, scope, root.id);
    const inbox = new ActivityInbox(db, {});
    const threads = async () =>
      (await inbox.list(workspace.id, alice.id, { filter: "unread" })).items
        .filter(isConversation)
        .filter((item) => item.thread);
    expect(await threads()).toMatchObject([
      { firstUnreadMessageId: reply.id, unreadCount: 1, unreadMention: true },
    ]);
    expect(
      (await workspaceChannelThreadUnreads(db, workspace.id, alice.id)).get(conversation.id),
    ).toEqual({ unreadThreadCount: 1, threadMentioned: true });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "thread",
      conversationId: conversation.id,
      rootMessageId: root.id,
      throughSequence: reply.sequence,
      markedUnreadVersion: version,
    });
    expect(await threads()).toEqual([]);
    const marked = await markThreadUnread(db, undefined, scope, root.id);
    expect(await threads()).toMatchObject([
      {
        firstUnreadMessageId: null,
        latest: { id: reply.id },
        unreadCount: 1,
        unreadMention: false,
        markedUnreadVersion: marked.version,
      },
    ]);
    await db.conversationMember.update({
      where: { id: aliceMember.id },
      data: { leftAt: new Date() },
    });
    await expect(loadThreadUnreadSnapshot(db, scope)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await expect(markThreadUnread(db, undefined, scope, root.id)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(await threads()).toEqual([]);
  } finally {
    await cleanup(db, suffix);
  }
});
