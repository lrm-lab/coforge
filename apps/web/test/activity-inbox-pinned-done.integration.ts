import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { cleanup, database, seed, isConversation } from "./helpers/activity-inbox-fixture";

test("Done takes a pinned conversation out of Pinned until something new arrives, like every row", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post, pin } = await seed(db, suffix);
    const support = await channel("support");
    await post(support.conversation.id, support.bobMember.id, "a platform question");
    await pin(support.aliceMember, 0);

    const inbox = new ActivityInbox(db, {});
    const listed = async () => {
      const page = await inbox.list(workspace.id, alice.id, { filter: "all" });
      return {
        pinned: page.pinned.map((entry) => entry.place.conversationId),
        items: page.items.filter(isConversation).map((entry) => entry.place.conversationId),
        unreadItemCount: page.unreadItemCount,
        activeItemCount: page.activeItemCount,
      };
    };

    // An unread pin stays with the unread items and appears once.
    expect(await listed()).toEqual({
      pinned: [],
      items: [support.conversation.id],
      unreadItemCount: 1,
      activeItemCount: 1,
    });

    // Reading it (not Done) keeps the row, as the docs' Mark as Read does.
    await inbox.markAllRead(workspace.id, alice.id, { before: new Date() });
    expect(await listed()).toMatchObject({ pinned: [support.conversation.id] });

    // Done on a pinned row works like on every row: it leaves the list until something new
    // arrives (Raft's Activity, docs.raft.build/features/messaging/activity), while the pin
    // itself stays for the Chat sidebar.
    await inbox.markDone(workspace.id, alice.id, {
      kind: "conversation",
      conversationId: support.conversation.id,
      throughSequence: 1,
    });
    expect(await listed()).toEqual({
      pinned: [],
      items: [],
      unreadItemCount: 0,
      activeItemCount: 0,
    });

    // Something new lists it again, still pinned, counting only the new message.
    await post(support.conversation.id, support.bobMember.id, "a newer question");
    const back = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(back.pinned).toEqual([]);
    expect(back.items.filter(isConversation).map((entry) => entry.place.conversationId)).toEqual([
      support.conversation.id,
    ]);
    expect(back.items[0]).toMatchObject({ pinned: true, unreadCount: 1 });
    expect(back.activeItemCount).toBe(1);
  } finally {
    await cleanup(db, suffix);
  }
});
