import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { database, kindOf, seed, cleanup } from "./helpers/activity-inbox-fixture";

/** Activity inbox against PostgreSQL; shared fixtures control exact sequences and cleanup. */
test("Done removes an item until newer activity arrives, and reads it", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    await post(general.conversation.id, general.bobMember.id, "one");
    const second = await post(general.conversation.id, general.bobMember.id, "two");
    const root = await post(general.conversation.id, general.aliceMember.id, "root");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    const reply = await post(general.conversation.id, general.bobMember.id, "reply", {
      threadRootId: root.id,
    });

    const inbox = new ActivityInbox(db, {});
    const channelRef = { kind: "conversation" as const, conversationId: general.conversation.id };
    // A Done that saw an older message leaves the newer one listed.
    await inbox.markDone(workspace.id, alice.id, { ...channelRef, throughSequence: 1 });
    let page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map(kindOf)).toEqual(["thread", "channel"]);

    await inbox.markDone(workspace.id, alice.id, {
      ...channelRef,
      throughSequence: root.sequence,
    });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "thread",
      conversationId: general.conversation.id,
      rootMessageId: root.id,
      throughSequence: reply.sequence,
    });
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items).toEqual([]);
    expect(page.activeItemCount).toBe(0);
    const member = await db.conversationMember.findUniqueOrThrow({
      where: { id: general.aliceMember.id },
    });
    expect(member.readThroughSequence).toBe(root.sequence);
    expect(second.sequence).toBeLessThan(root.sequence);

    const next = await post(general.conversation.id, general.bobMember.id, "three");
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map((item) => [kindOf(item), item.latest.id, item.unreadCount])).toEqual([
      ["channel", next.id, 1],
    ]);

    const late = await post(general.conversation.id, general.bobMember.id, "late reply", {
      threadRootId: root.id,
    });
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map((item) => [kindOf(item), item.latest.id, item.unreadCount])).toEqual([
      ["thread", late.id, 1],
      ["channel", next.id, 1],
    ]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("a pinned conversation is listed under Pinned even when Done, and not again among the items", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post, pin } = await seed(db, suffix);
    const general = await channel("general");
    const quiet = await channel("quiet");
    await post(general.conversation.id, general.bobMember.id, "hello");
    const latest = await post(quiet.conversation.id, quiet.bobMember.id, "newest");
    await pin(quiet.aliceMember, 0);

    const inbox = new ActivityInbox(db, {});
    await inbox.markDone(workspace.id, alice.id, {
      kind: "conversation",
      conversationId: quiet.conversation.id,
      throughSequence: latest.sequence,
    });
    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.pinned.map((item) => [item.key, item.latest.id, item.unreadCount])).toEqual([
      [`conversation:${quiet.conversation.id}`, latest.id, 0],
    ]);
    expect(page.pinned[0]!.place).toMatchObject({
      kind: "channel",
      conversationId: quiet.conversation.id,
    });
    expect(page.items.map((item) => item.place.conversationId)).toEqual([general.conversation.id]);
    // Each item says whether the viewer pinned it.
    expect([...page.pinned, ...page.items].map((item) => item.pinned)).toEqual([true, false]);
    // The header's "N active" counts what the All view lists: the pin, and the item below it.
    expect(page.activeItemCount).toBe(2);
  } finally {
    await cleanup(db, suffix);
  }
});

test("Pinned follows the pin order and leaves a pinned channel's threads and the counts as they were", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post, pin } = await seed(db, suffix);
    const general = await channel("general");
    const quiet = await channel("quiet");
    const calm = await channel("calm");
    const left = await channel("left");
    const silent = await channel("silent");
    const root = await post(general.conversation.id, general.aliceMember.id, "a question");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    await post(general.conversation.id, general.bobMember.id, "@alice an answer", {
      threadRootId: root.id,
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.bobMember.id, "@alice news", {
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(quiet.conversation.id, quiet.bobMember.id, "quiet news");
    await post(calm.conversation.id, calm.bobMember.id, "calm news");
    await db.conversationMember.update({
      where: { id: left.aliceMember.id },
      data: { leftAt: new Date() },
    });
    await post(left.conversation.id, left.bobMember.id, "said after alice left");

    const inbox = new ActivityInbox(db, {});
    const before = await inbox.list(workspace.id, alice.id, { filter: "all" });

    await pin(general.aliceMember, 2);
    await pin(quiet.aliceMember, 1);
    // A pin outlives leaving (the row stays), and a channel can be pinned before anyone has posted
    // in it: neither is a conversation the inbox lists.
    await pin(left.aliceMember, 0);
    await pin(silent.aliceMember, 3);

    const all = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(all.pinned.map((item) => item.place.conversationId)).toEqual([
      quiet.conversation.id,
      general.conversation.id,
    ]);
    expect(all.pinned[1]).toMatchObject({ unreadCount: 1, unreadMention: true });
    // The pinned channel's followed thread is an item of its own and stays in the list.
    expect(all.items.map((item) => item.key)).toEqual([
      `conversation:${calm.conversation.id}`,
      `thread:${root.id}`,
    ]);
    // Pinning moves no count: every item still counts, wherever it is listed.
    expect([all.unreadItemCount, all.unreadMentionItemCount]).toEqual([
      before.unreadItemCount,
      before.unreadMentionItemCount,
    ]);
    expect([all.unreadItemCount, all.unreadMentionItemCount]).toEqual([4, 2]);
    // The All view lists two pins and two items; a pin the inbox does not list counts for nothing.
    expect(before.activeItemCount).toBe(4);
    expect(all.activeItemCount).toBe(4);

    // A later page lists no pins, and none of the pinned conversations either.
    const second = await inbox.list(workspace.id, alice.id, { filter: "all", limit: 1, offset: 1 });
    expect(second.pinned).toEqual([]);
    expect(second.items.map((item) => item.key)).toEqual([`thread:${root.id}`]);
    expect(second.nextOffset).toBe(null);

    // Unread and Mentions have no Pinned section: a pinned conversation lists among their items.
    const unread = await inbox.list(workspace.id, alice.id, { filter: "unread" });
    expect(unread.pinned).toEqual([]);
    expect(unread.items.map((item) => item.place.conversationId)).toContain(quiet.conversation.id);
    // A pinned conversation listed as an ordinary item still says it is pinned; a thread in a
    // pinned channel is not itself pinned.
    expect(Object.fromEntries(unread.items.map((item) => [item.key, item.pinned]))).toMatchObject({
      [`conversation:${quiet.conversation.id}`]: true,
      [`conversation:${calm.conversation.id}`]: false,
      [`thread:${root.id}`]: false,
    });
    const mentions = await inbox.list(workspace.id, alice.id, { filter: "mentions" });
    expect(mentions.pinned).toEqual([]);
    // The All view's count, whichever view is showing and on every page.
    expect([unread.activeItemCount, mentions.activeItemCount, second.activeItemCount]).toEqual([
      4, 4, 4,
    ]);
    expect(mentions.items.map((item) => item.key).sort()).toEqual(
      [`conversation:${general.conversation.id}`, `thread:${root.id}`].sort(),
    );
  } finally {
    await cleanup(db, suffix);
  }
});

test("Mark all read clears unread and keeps every item listed", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const root = await post(general.conversation.id, general.aliceMember.id, "root");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    await post(general.conversation.id, general.bobMember.id, "reply", { threadRootId: root.id });
    await post(general.conversation.id, general.bobMember.id, "main");
    await db.conversationMember.update({
      where: { id: general.aliceMember.id },
      data: { unreadFromSequence: 1 },
    });

    const inbox = new ActivityInbox(db, {});
    expect((await inbox.list(workspace.id, alice.id, { filter: "all" })).unreadItemCount).toBe(2);
    const shown = new Date();
    // Sent after the page the viewer looked at: Mark all read must not read it.
    const late = await post(general.conversation.id, general.bobMember.id, "late", {
      threadRootId: root.id,
    });
    await db.message.update({
      where: { id: late.id },
      data: { createdAt: new Date(shown.getTime() + 1_000) },
    });
    await inbox.markAllRead(workspace.id, alice.id, { before: shown });
    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map((item) => [kindOf(item), item.unreadCount])).toEqual([
      ["thread", 1],
      ["channel", 0],
    ]);
    expect(page.unreadItemCount).toBe(1);
    expect(page.items[0]!.firstUnreadMessageId).toBe(late.id);
    const member = await db.conversationMember.findUniqueOrThrow({
      where: { id: general.aliceMember.id },
    });
    expect(member.unreadFromSequence).toBe(null);
  } finally {
    await cleanup(db, suffix);
  }
});

test("a thread counts only mentions in its own replies past its Done boundary", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const follow = (rootMessageId: string) =>
      db.threadFollow.create({
        data: {
          memberId: general.aliceMember.id,
          rootMessageId,
          conversationId: general.conversation.id,
          workspaceId: workspace.id,
        },
      });
    const mentioned = await post(general.conversation.id, general.aliceMember.id, "mentioned");
    const quiet = await post(general.conversation.id, general.aliceMember.id, "quiet");
    await follow(mentioned.id);
    await follow(quiet.id);
    // Mentions of the same member elsewhere in the channel belong to neither thread.
    await post(general.conversation.id, general.bobMember.id, "top-level ping", {
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.bobMember.id, "ping in the thread", {
      threadRootId: mentioned.id,
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.bobMember.id, "plain reply", {
      threadRootId: quiet.id,
    });

    const inbox = new ActivityInbox(db, {});
    const mentionState = async () =>
      Object.fromEntries(
        (await inbox.list(workspace.id, alice.id, { filter: "all" })).items.map((item) => [
          item.thread?.root.body ?? kindOf(item),
          [item.firstMentionMessageId !== null, item.unreadMention],
        ]),
      );
    expect(await mentionState()).toEqual({
      mentioned: [true, true],
      quiet: [false, false],
      channel: [true, true],
    });

    // Done past the mention leaves it behind, though newer replies list the thread again.
    const done = await db.message.findFirstOrThrow({
      where: { threadRootId: mentioned.id },
      orderBy: { sequence: "desc" },
    });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "thread",
      conversationId: general.conversation.id,
      rootMessageId: mentioned.id,
      throughSequence: done.sequence,
    });
    await post(general.conversation.id, general.bobMember.id, "after Done", {
      threadRootId: mentioned.id,
    });
    expect((await mentionState()).mentioned).toEqual([false, false]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("an item opens at its first mention past Done, read or not", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const root = await post(general.conversation.id, general.bobMember.id, "root");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    const ping = await post(general.conversation.id, general.bobMember.id, "ping", {
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.bobMember.id, "second ping", {
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.bobMember.id, "deployed");
    const replyPing = await post(general.conversation.id, general.bobMember.id, "reply ping", {
      threadRootId: root.id,
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.bobMember.id, "plain reply", {
      threadRootId: root.id,
    });

    const inbox = new ActivityInbox(db, {});
    await inbox.markAllRead(workspace.id, alice.id, { before: new Date(Date.UTC(2027, 0, 1)) });
    const firstMentions = async () =>
      Object.fromEntries(
        (await inbox.list(workspace.id, alice.id, { filter: "mentions" })).items.map((item) => [
          kindOf(item),
          item.firstMentionMessageId,
        ]),
      );
    // Everything is read, and the newest message mentions no one: the item still opens at the
    // first message that mentioned the viewer.
    expect(await firstMentions()).toEqual({ thread: replyPing.id, channel: ping.id });

    // Done leaves the mentions behind: newer activity lists both items again, with no mention.
    const newest = (threadRootId: string | null) =>
      db.message.findFirstOrThrow({
        where: { conversationId: general.conversation.id, threadRootId },
        orderBy: { sequence: "desc" },
      });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "conversation",
      conversationId: general.conversation.id,
      throughSequence: (await newest(null)).sequence,
    });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "thread",
      conversationId: general.conversation.id,
      rootMessageId: root.id,
      throughSequence: (await newest(root.id)).sequence,
    });
    await post(general.conversation.id, general.bobMember.id, "after Done");
    await post(general.conversation.id, general.bobMember.id, "reply after Done", {
      threadRootId: root.id,
    });
    const all = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(
      Object.fromEntries(all.items.map((item) => [kindOf(item), item.firstMentionMessageId])),
    ).toEqual({ thread: null, channel: null });
  } finally {
    await cleanup(db, suffix);
  }
});
