import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { database, seed, cleanup } from "./helpers/activity-inbox-fixture";

/** How the Activity inbox pages: each page after the last item of the one before, in list order. */
test("a later page picks up after the last item the viewer was shown, whatever moved since", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const [oldest, older, tiedLow, tiedHigh, newest] = await Promise.all(
      ["oldest", "older", "tied-a", "tied-b", "newest"].map((name) => channel(name)),
    );
    for (const item of [oldest!, older!, tiedLow!, tiedHigh!, newest!])
      await post(item.conversation.id, item.bobMember.id, "hello");
    // Two items whose newest messages share an instant and a sequence: the page boundary falls
    // between them, and each is still listed exactly once.
    const tiedAt = new Date(Date.UTC(2026, 0, 1, 7, 0, 0));
    await db.message.updateMany({
      where: { conversationId: { in: [tiedLow!.conversation.id, tiedHigh!.conversation.id] } },
      data: { createdAt: tiedAt },
    });
    const keyOf = (item: { conversation: { id: string } }) =>
      `conversation:${item.conversation.id}`;
    const [tiedFirst, tiedSecond] = [keyOf(tiedLow!), keyOf(tiedHigh!)].sort().reverse();

    const inbox = new ActivityInbox(db, {});
    const first = await inbox.list(workspace.id, alice.id, { filter: "all", limit: 2 });
    expect(first.items.map((item) => item.key)).toEqual([keyOf(newest!), keyOf(older!)]);
    expect(first.nextCursor).not.toBe(null);

    // New activity moves an item already shown to the top: the next page neither repeats it nor
    // skips the item that followed the page.
    await post(older!.conversation.id, older!.bobMember.id, "again");
    const second = await inbox.list(workspace.id, alice.id, {
      filter: "all",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.key)).toEqual([keyOf(oldest!), tiedFirst]);
    // Only the first page lists the pins; every page carries the counts.
    expect(second.pinned).toEqual([]);
    expect(second.unreadItemCount).toBe(5);

    const third = await inbox.list(workspace.id, alice.id, {
      filter: "all",
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect(third.items.map((item) => item.key)).toEqual([tiedSecond]);
    expect(third.nextCursor).toBe(null);
  } finally {
    await cleanup(db, suffix);
  }
});

test("an Unread page lists a pinned conversation in time order, not ahead of newer items", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post, pin } = await seed(db, suffix);
    const [pinnedOld, pinnedOlder, newest] = await Promise.all(
      ["pinned-old", "pinned-older", "newest"].map((name) => channel(name)),
    );
    for (const item of [pinnedOlder!, pinnedOld!, newest!])
      await post(item.conversation.id, item.bobMember.id, "hello");
    await pin(pinnedOld!.aliceMember, 0);
    await pin(pinnedOlder!.aliceMember, 1);
    const keyOf = (item: { conversation: { id: string } }) =>
      `conversation:${item.conversation.id}`;

    const inbox = new ActivityInbox(db, {});
    const first = await inbox.list(workspace.id, alice.id, { filter: "unread", limit: 2 });
    expect(first.items.map((item) => item.key)).toEqual([keyOf(newest!), keyOf(pinnedOld!)]);
    const second = await inbox.list(workspace.id, alice.id, {
      filter: "unread",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.key)).toEqual([keyOf(pinnedOlder!)]);
    expect(second.nextCursor).toBe(null);
  } finally {
    await cleanup(db, suffix);
  }
});
