import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { cleanup, database, seed } from "./helpers/activity-inbox-fixture";

/**
 * The Activity inbox's Mark all done (`activity-inbox-bulk-writes.server.ts`) against PostgreSQL:
 * it stops at `before`, and Undo restores only what the write itself set and only the caller's own
 * rows.
 */
function inboxWith(db: ReturnType<typeof database>, announced: unknown[] = []) {
  return new ActivityInbox(db, {
    viewerChanged: async () => {},
    activityChanged: async (input) => void announced.push(input),
  });
}

test("Mark all done stops at `before`: an item that heard something newer stays listed", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const quiet = await channel("quiet");
    const busy = await channel("busy");
    const threaded = await channel("threaded");
    await post(quiet.conversation.id, quiet.bobMember.id, "old");
    await post(busy.conversation.id, busy.bobMember.id, "old");
    const root = await post(threaded.conversation.id, threaded.bobMember.id, "root");
    const reply = await post(threaded.conversation.id, threaded.bobMember.id, "reply", {
      threadRootId: root.id,
    });
    await db.threadFollow.create({
      data: {
        memberId: threaded.aliceMember.id,
        rootMessageId: root.id,
        conversationId: threaded.conversation.id,
        workspaceId: workspace.id,
      },
    });
    const loadedAt = new Date(reply.createdAt.getTime() + 1);
    await post(busy.conversation.id, busy.bobMember.id, "newer than the list");
    const inbox = inboxWith(db);

    const { count, undo } = await inbox.markAllDone(workspace.id, alice.id, { before: loadedAt });
    // The quiet channel, the threaded channel's conversation, and its thread.
    expect(count).toBe(4);
    const listed = (await inbox.list(workspace.id, alice.id, { filter: "all" })).items.map(
      (item) => item.key,
    );
    expect(listed).toEqual([`conversation:${busy.conversation.id}`]);
    const busyMember = await db.conversationMember.findUniqueOrThrow({
      where: { id: busy.aliceMember.id },
    });
    expect(busyMember.doneThroughSequence).toBe(1);
    // The busy channel's new message is still unread; the rest were read by Done.
    const busyItem = (await inbox.list(workspace.id, alice.id, { filter: "unread" })).items[0];
    expect(busyItem?.unreadCount).toBe(1);

    await inbox.undoDone(workspace.id, alice.id, undo!);
    const back = (await inbox.list(workspace.id, alice.id, { filter: "all" })).items.map(
      (item) => item.key,
    );
    expect(back).toEqual(
      expect.arrayContaining([
        `conversation:${quiet.conversation.id}`,
        `conversation:${busy.conversation.id}`,
        `conversation:${threaded.conversation.id}`,
      ]),
    );
    expect(back.some((key) => key.startsWith("thread:"))).toBe(true);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: quiet.aliceMember.id } }))
        .doneThroughSequence,
    ).toBeNull();
  } finally {
    await cleanup(db, suffix);
  }
});

test("Undo leaves a newer Done alone and dismissed mentions come back only for the write's own dismissal", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const first = await channel("first");
    const second = await channel("second");
    await post(first.conversation.id, first.bobMember.id, "one");
    await post(second.conversation.id, second.bobMember.id, "one");
    const mentioned = await post(second.conversation.id, second.bobMember.id, "psst");
    const action = await db.pendingMentionAction.create({
      data: {
        messageId: mentioned.id,
        conversationId: second.conversation.id,
        workspaceId: workspace.id,
        senderMemberId: second.bobMember.id,
        targetUserId: alice.id,
        targetHandle: alice.username,
        expiresAt: new Date(Date.now() + 86_400_000),
        notifiedAt: mentioned.createdAt,
      },
    });
    const inbox = inboxWith(db);
    const { undo } = await inbox.markAllDone(workspace.id, alice.id, { before: new Date() });
    expect(undo?.mentions.ids).toEqual([action.id]);
    expect(
      (await db.pendingMentionAction.findUniqueOrThrow({ where: { id: action.id } })).dismissedAt,
    ).not.toBeNull();

    // A newer message arrives and the viewer marks that Done: Undo must not roll it back.
    await post(first.conversation.id, first.bobMember.id, "newer");
    await inbox.markDone(workspace.id, alice.id, {
      kind: "conversation",
      conversationId: first.conversation.id,
      throughSequence: 2,
    });
    // The mention is dismissed again, later, by someone else's write: not this write's dismissal.
    await db.pendingMentionAction.update({
      where: { id: action.id },
      data: { dismissedAt: new Date(Date.now() + 5_000) },
    });
    await inbox.undoDone(workspace.id, alice.id, undo!);
    const firstMember = await db.conversationMember.findUniqueOrThrow({
      where: { id: first.aliceMember.id },
    });
    expect(firstMember.doneThroughSequence).toBe(2);
    const secondMember = await db.conversationMember.findUniqueOrThrow({
      where: { id: second.aliceMember.id },
    });
    expect(secondMember.doneThroughSequence).toBeNull();
    expect(
      (await db.pendingMentionAction.findUniqueOrThrow({ where: { id: action.id } })).dismissedAt,
    ).not.toBeNull();
  } finally {
    await cleanup(db, suffix);
  }
});

test("another member's Undo payload changes nothing", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, bob, workspace, channel, post } = await seed(db, suffix);
    const shared = await channel("shared");
    await post(shared.conversation.id, shared.bobMember.id, "hi");
    const inbox = inboxWith(db);
    const { undo } = await inbox.markAllDone(workspace.id, alice.id, { before: new Date() });
    expect(undo?.members).toHaveLength(1);

    // Bob replays Alice's payload: her Done stays.
    await inbox.undoDone(workspace.id, bob.id, undo!);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: shared.aliceMember.id } }))
        .doneThroughSequence,
    ).toBe(1);
  } finally {
    await cleanup(db, suffix);
  }
});

test("Mark all done announces every moved conversation's badge in one batched call", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const first = await channel("first");
    const second = await channel("second");
    await post(first.conversation.id, first.bobMember.id, "one");
    await post(second.conversation.id, second.bobMember.id, "two");
    const singleCalls: unknown[] = [];
    const batchCalls: { userIds: readonly string[]; events: readonly unknown[] }[] = [];
    const inbox = new ActivityInbox(db, {
      viewerChanged: async (input: unknown) => void singleCalls.push(input),
      viewerEventsChanged: async (input: {
        userIds: readonly string[];
        events: readonly unknown[];
      }) => void batchCalls.push(input),
      activityChanged: async () => {},
    });

    await inbox.markAllDone(workspace.id, alice.id, { before: new Date() });

    expect(singleCalls).toEqual([]);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.userIds).toEqual([alice.id]);
    expect(batchCalls[0]?.events).toHaveLength(2);
    expect(batchCalls[0]?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "channel.marked.v1",
          conversationId: first.conversation.id,
        }),
        expect.objectContaining({
          type: "channel.marked.v1",
          conversationId: second.conversation.id,
        }),
      ]),
    );
  } finally {
    await cleanup(db, suffix);
  }
});

test.each([
  ["done", "relevant"],
  ["read", "relevant"],
  ["done", "muted"],
  ["read", "muted"],
])(
  "Mark all %s reads through the visible mention at level %s",
  async (action, notificationLevel) => {
    const db = database();
    const suffix = crypto.randomUUID();
    try {
      const { alice, workspace, channel, post } = await seed(db, suffix);
      const hidden = await channel("hidden");
      const shown = await channel("shown");
      const inbox = inboxWith(db);
      for (const each of [hidden, shown]) {
        await db.conversationMember.update({
          where: { id: each.aliceMember.id },
          data: { notificationLevel },
        });
        await post(each.conversation.id, each.bobMember.id, "ordinary");
      }
      const mention = await post(shown.conversation.id, shown.bobMember.id, "mention", {
        mentionMemberIds: [shown.aliceMember.id],
      });
      const later = await post(shown.conversation.id, shown.bobMember.id, "ordinary again");

      const before = new Date(later.createdAt.getTime() + 1);
      const newMention = await post(
        shown.conversation.id,
        shown.bobMember.id,
        "mention after cutoff",
        {
          mentionMemberIds: [shown.aliceMember.id],
        },
      );
      if (action === "done") {
        const { count } = await inbox.markAllDone(workspace.id, alice.id, { before });
        expect(count).toBe(1);
      } else {
        await inbox.markAllRead(workspace.id, alice.id, { before });
      }
      const hiddenMember = await db.conversationMember.findUniqueOrThrow({
        where: { id: hidden.aliceMember.id },
      });
      const shownMember = await db.conversationMember.findUniqueOrThrow({
        where: { id: shown.aliceMember.id },
      });
      expect(hiddenMember.readThroughSequence).toBe(0);
      expect(shownMember.readThroughSequence).toBe(mention.sequence);
      const { items } = await inbox.list(workspace.id, alice.id, { filter: "unread" });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "conversation",
        unreadCount: 1,
        latest: { id: newMention.id },
      });
    } finally {
      await cleanup(db, suffix);
    }
  },
);

test.each(["read", "done"])(
  "Mark all %s excludes inactive channels and their mentions",
  async (action) => {
    const db = database();
    const suffix = crypto.randomUUID();
    try {
      const { alice, workspace, channel, post } = await seed(db, suffix);
      const rows = await Promise.all([channel("archived"), channel("hidden"), channel("active")]);
      const inbox = inboxWith(db);
      const noticeIds = [];
      for (const row of rows) {
        const message = await post(row.conversation.id, row.bobMember.id, "mention");
        const notice = await db.pendingMentionAction.create({
          data: {
            workspaceId: workspace.id,
            conversationId: row.conversation.id,
            messageId: message.id,
            senderMemberId: row.bobMember.id,
            targetUserId: alice.id,
            targetHandle: alice.username,
            expiresAt: new Date(Date.now() + 86_400_000),
            notifiedAt: message.createdAt,
          },
        });
        noticeIds.push(notice.id);
      }
      const [archived, hidden, active] = rows;
      await db.conversation.update({
        where: { id: archived!.conversation.id },
        data: { archivedAt: new Date() },
      });
      await db.conversation.update({
        where: { id: hidden!.conversation.id },
        data: { channelName: "general", hiddenFromWorkspaceAt: new Date() },
      });
      const { items } = await inbox.list(workspace.id, alice.id, { filter: "all" });
      expect(items.map((item) => item.key).sort()).toEqual([
        `conversation:${active!.conversation.id}`,
        `mention:${noticeIds[2]}`,
      ]);

      const before = new Date();
      if (action === "done") await inbox.markAllDone(workspace.id, alice.id, { before });
      else await inbox.markAllRead(workspace.id, alice.id, { before });

      for (const [index, row] of rows.entries()) {
        const member = await db.conversationMember.findUniqueOrThrow({
          where: { id: row.aliceMember.id },
        });
        const notice = await db.pendingMentionAction.findUniqueOrThrow({
          where: { id: noticeIds[index] },
        });
        const visible = row === active;
        expect({
          readThrough: member.readThroughSequence,
          doneThrough: member.doneThroughSequence,
          noticeRead: notice.targetReadAt !== null,
          noticeDone: notice.dismissedAt !== null,
        }).toEqual({
          readThrough: visible ? 1 : 0,
          doneThrough: visible && action === "done" ? 1 : null,
          noticeRead: visible && action === "read",
          noticeDone: visible && action === "done",
        });
      }
    } finally {
      await cleanup(db, suffix);
    }
  },
);
