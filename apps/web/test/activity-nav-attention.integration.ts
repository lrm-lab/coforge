import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { cleanup, database, seed } from "./helpers/activity-inbox-fixture";

test("the nav attention count follows Activity unread items, including a muted mention", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const seeded = await seed(db, suffix);
    const channel = await seeded.channel("muted");
    const { alice, workspace, post } = seeded;
    await db.conversationMember.update({
      where: { id: channel.aliceMember.id },
      data: { notificationLevel: "muted" },
    });
    const inbox = new ActivityInbox(db, {});
    await post(channel.conversation.id, channel.bobMember.id, "ordinary");
    expect(await inbox.navAttention(workspace.id, alice.id)).toEqual({
      hasUnread: false,
      unreadCount: 0,
      unreadKeys: [],
    });
    await post(channel.conversation.id, channel.bobMember.id, "mentioned", {
      mentionMemberIds: [channel.aliceMember.id],
    });
    expect(await inbox.navAttention(workspace.id, alice.id)).toEqual({
      hasUnread: true,
      unreadCount: 1,
      unreadKeys: [`conversation:${channel.conversation.id}`],
    });
  } finally {
    await cleanup(db, suffix);
  }
});

test("a Done item returns to the nav count when a newer message arrives", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const seeded = await seed(db, suffix);
    const channel = await seeded.channel("done");
    const { alice, workspace, post } = seeded;
    const inbox = new ActivityInbox(db, {});
    await post(channel.conversation.id, channel.bobMember.id, "first");
    expect((await inbox.navAttention(workspace.id, alice.id)).unreadCount).toBe(1);
    await inbox.markDone(workspace.id, alice.id, {
      kind: "conversation",
      conversationId: channel.conversation.id,
      throughSequence: 1,
    });
    expect(await inbox.navAttention(workspace.id, alice.id)).toEqual({
      hasUnread: false,
      unreadCount: 0,
      unreadKeys: [],
    });
    await post(channel.conversation.id, channel.bobMember.id, "newer");
    expect(await inbox.navAttention(workspace.id, alice.id)).toEqual({
      hasUnread: true,
      unreadCount: 1,
      unreadKeys: [`conversation:${channel.conversation.id}`],
    });
  } finally {
    await cleanup(db, suffix);
  }
});

test("the nav attention count and keys are capped at 100 items", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const seeded = await seed(db, suffix);
    const channels = await Promise.all(
      Array.from({ length: 101 }, (_, index) => seeded.channel(`extra-${index}`)),
    );
    for (const item of channels)
      await seeded.post(item.conversation.id, item.bobMember.id, "unread");
    const attention = await new ActivityInbox(db, {}).navAttention(
      seeded.workspace.id,
      seeded.alice.id,
    );
    expect(attention.hasUnread).toBe(true);
    expect(attention.unreadCount).toBe(100);
    expect(attention.unreadKeys).toHaveLength(100);
  } finally {
    await cleanup(db, suffix);
  }
});
