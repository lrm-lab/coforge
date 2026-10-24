import { expect, test } from "bun:test";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ActivityInbox, type ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import type { ChannelListMember } from "#src/server/conversations/channel-list-preview.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { database, kindOf, seed, cleanup } from "./helpers/activity-inbox-fixture";

/** Activity inbox against PostgreSQL; shared fixtures control exact sequences and cleanup. */
test("lists joined conversations and followed threads with activity, newest first", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const quiet = await channel("quiet");
    const archived = await channel("archived", { archived: true });
    const left = await channel("left");
    await db.conversationMember.update({
      where: { id: left.aliceMember.id },
      data: { leftAt: new Date() },
    });

    await post(archived.conversation.id, archived.bobMember.id, "old news");
    await post(left.conversation.id, left.bobMember.id, "after alice left");
    const root = await post(general.conversation.id, general.aliceMember.id, "a question");
    await post(general.conversation.id, general.bobMember.id, "hello");
    await post(general.conversation.id, null, "1 new task created: #1");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    const reply = await post(general.conversation.id, general.bobMember.id, "an answer", {
      threadRootId: root.id,
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.aliceMember.id, "thanks", {
      threadRootId: root.id,
    });
    // An unfollowed thread elsewhere stays out.
    const otherRoot = await post(quiet.conversation.id, quiet.bobMember.id, "unfollowed root");
    await post(quiet.conversation.id, quiet.bobMember.id, "unfollowed reply", {
      threadRootId: otherRoot.id,
    });

    const inbox = new ActivityInbox(db);
    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });

    expect(
      page.items.map((item) => [
        kindOf(item),
        item.place.conversationId,
        item.thread?.root.id ?? null,
      ]),
    ).toEqual([
      ["channel", quiet.conversation.id, null],
      ["thread", general.conversation.id, root.id],
      ["channel", general.conversation.id, null],
    ]);
    const [, thread, channelItem] = page.items;
    // Unread counts people's messages only, never the viewer's own or a system notice.
    expect(channelItem!.unreadCount).toBe(1);
    expect(channelItem!.latest.body).toBe("1 new task created: #1");
    expect(channelItem!.latest.senderKind).toBe("system");
    expect(thread!.unreadCount).toBe(1);
    expect(thread!.firstUnreadMessageId).toBe(reply.id);
    expect(thread!.thread?.root.body).toBe("a question");
    expect(thread!.latest.body).toBe("thanks");
    expect(thread!.firstMentionMessageId).toBe(reply.id);
    expect(thread!.unreadMention).toBe(true);
    expect(page.unreadItemCount).toBe(3);
    expect(page.unreadMentionItemCount).toBe(1);
    expect(page.nextOffset).toBe(null);

    const unread = await inbox.list(workspace.id, alice.id, { filter: "unread" });
    expect(unread.items.map((item) => item.key)).toEqual(page.items.map((item) => item.key));
    const mentions = await inbox.list(workspace.id, alice.id, { filter: "mentions" });
    expect(mentions.items.map((item) => item.key)).toEqual([thread!.key]);

    const firstPage = await inbox.list(workspace.id, alice.id, { filter: "all", limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextOffset).toBe(2);
    const secondPage = await inbox.list(workspace.id, alice.id, {
      filter: "all",
      limit: 2,
      offset: 2,
    });
    expect(secondPage.items.map((item) => item.key)).toEqual([channelItem!.key]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("the Unread and Mentions counts are items with unread and unread mentions, the same under every filter", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const quiet = await channel("quiet");
    const calm = await channel("calm");
    // Three unread messages in one channel are one item with unread.
    for (const body of ["one", "two", "three"])
      await post(general.conversation.id, general.bobMember.id, body);
    // A followed thread whose unread reply mentions the viewer: unread, and an unread mention.
    const root = await post(general.conversation.id, general.aliceMember.id, "a question");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    await post(general.conversation.id, general.bobMember.id, "@alice look", {
      threadRootId: root.id,
      mentionMemberIds: [general.aliceMember.id],
    });
    // A mention the viewer already read stays under Mentions but counts nowhere.
    const seen = await post(quiet.conversation.id, quiet.bobMember.id, "@alice seen", {
      mentionMemberIds: [quiet.aliceMember.id],
    });
    await db.conversationMember.update({
      where: { id: quiet.aliceMember.id },
      data: { readThroughSequence: seen.sequence },
    });
    // An item with nothing unread counts nowhere either.
    const own = await post(calm.conversation.id, calm.aliceMember.id, "my own note");
    await db.conversationMember.update({
      where: { id: calm.aliceMember.id },
      data: { readThroughSequence: own.sequence },
    });

    const inbox = new ActivityInbox(db);
    const [all, unread, mentions] = await Promise.all(
      (["all", "unread", "mentions"] as const).map((filter) =>
        inbox.list(workspace.id, alice.id, { filter }),
      ),
    );
    expect(all!.items).toHaveLength(4);
    expect(unread!.items).toHaveLength(2);
    expect(mentions!.items).toHaveLength(2);
    for (const page of [all!, unread!, mentions!]) {
      expect(page.unreadItemCount).toBe(2);
      expect(page.unreadMentionItemCount).toBe(1);
    }
  } finally {
    await cleanup(db, suffix);
  }
});

test("a followed task thread whose owner Agent was deleted marks the owner deleted", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `inbox-kiro-${suffix.slice(0, 8)}`,
        displayName: "Kiro",
        ownerId: alice.id,
        runtimeConfig: {},
      },
    });
    const agentMember = await db.conversationMember.create({
      data: {
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
      },
    });
    const root = await post(general.conversation.id, general.aliceMember.id, "Ship the login page");
    await db.task.create({
      data: {
        messageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
        number: 1,
        title: "Ship the login page",
        status: "in_progress",
        ownerMemberId: agentMember.id,
        creatorMemberId: general.aliceMember.id,
      },
    });
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    await post(general.conversation.id, general.bobMember.id, "any update?", {
      threadRootId: root.id,
    });
    const inbox = new ActivityInbox(db);
    const taskOf = async () =>
      (await inbox.list(workspace.id, alice.id, { filter: "all" })).items.find(
        (item) => item.thread?.root.id === root.id,
      )!.thread!.task;

    expect(await taskOf()).toMatchObject({ ownerName: "Kiro", ownerDeleted: false });
    await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    expect(await taskOf()).toMatchObject({ ownerName: "Kiro", ownerDeleted: true });
  } finally {
    await cleanup(db, suffix);
  }
});

test("a channel's items carry the members its group avatar shows, as the Chat sidebar's row does", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, bob, workspace, channel, post, pin } = await seed(db, suffix);
    const general = await channel("general");
    const pinned = await channel("pinned");
    await db.user.update({
      where: { id: alice.id },
      data: { avatarObjectKey: `avatars/${suffix}/alice.png`, avatarContentType: "image/png" },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `inbox-kiro-${suffix.slice(0, 8)}`,
        displayName: "Kiro",
        ownerId: alice.id,
        runtimeConfig: {},
        avatarMascot: "pink",
      },
    });
    const joined = Date.UTC(2025, 0, 1);
    for (const { aliceMember, bobMember } of [general, pinned])
      for (const [index, member] of [aliceMember, bobMember].entries())
        await db.conversationMember.update({
          where: { id: member.id },
          data: { joinedAt: new Date(joined + index * 60_000) },
        });
    await db.conversationMember.create({
      data: {
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        joinedAt: new Date(joined + 2 * 60_000),
      },
    });
    // A member who left is not on the avatar, as in the sidebar.
    const carol = await db.user.create({
      data: { username: `inbox-carol-${suffix}`, displayName: "carol" },
    });
    await db.conversationMember.create({
      data: {
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
        userId: carol.id,
        joinedAt: new Date(joined + 3 * 60_000),
        leftAt: new Date(),
      },
    });
    const root = await post(general.conversation.id, general.aliceMember.id, "a question");
    await post(general.conversation.id, general.bobMember.id, "hello");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    await post(general.conversation.id, general.bobMember.id, "an answer", {
      threadRootId: root.id,
    });
    await post(pinned.conversation.id, pinned.bobMember.id, "pinned news");
    await pin(pinned.aliceMember, 0);

    const page = await new ActivityInbox(db).list(workspace.id, alice.id, { filter: "all" });
    const membersOf = (item: ActivityInboxItem | undefined) =>
      item?.place.kind === "channel" ? item.place.members : undefined;
    const generalMembers: ChannelListMember[] = [
      {
        kind: "user",
        id: alice.id,
        name: "alice",
        avatarUrl: workspaceUserAvatarUrl(workspace.id, alice.id, `avatars/${suffix}/alice.png`),
      },
      {
        kind: "user",
        id: bob.id,
        name: "bob",
        avatarUrl: workspaceUserAvatarUrl(workspace.id, bob.id, null),
      },
      {
        kind: "agent",
        id: agent.id,
        name: "Kiro",
        avatarUrl: agentAvatarUrl(agent.id, "pink"),
      },
    ];
    const channelItem = page.items.find(
      (item) => item.place.conversationId === general.conversation.id && !item.thread,
    );
    const threadItem = page.items.find((item) => item.thread?.root.id === root.id);
    expect(membersOf(channelItem)).toEqual(generalMembers);
    // A channel thread's row shows its channel's avatar under the thread badge.
    expect(membersOf(threadItem)).toEqual(generalMembers);
    // A pinned channel shows its own members.
    expect(page.pinned.map(membersOf)).toEqual([
      [alice.id, bob.id].map((id) => expect.objectContaining({ kind: "user", id })),
    ]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("the nav dot counts exactly the unread replies and messages the inbox lists", async () => {
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
    const readThread = (rootMessageId: string, readThroughSequence: number) =>
      db.threadRead.create({
        data: {
          memberId: general.aliceMember.id,
          rootMessageId,
          conversationId: general.conversation.id,
          workspaceId: workspace.id,
          readThroughSequence,
        },
      });
    // Two unread top-level messages.
    await post(general.conversation.id, general.bobMember.id, "one");
    await post(general.conversation.id, general.bobMember.id, "two");
    // A thread read through its first reply: the two later replies are unread, the viewer's own
    // reply is not.
    const partly = await post(general.conversation.id, general.aliceMember.id, "partly read");
    await follow(partly.id);
    const seen = await post(general.conversation.id, general.bobMember.id, "seen", {
      threadRootId: partly.id,
    });
    await readThread(partly.id, seen.sequence);
    for (const body of ["new 1", "new 2"])
      await post(general.conversation.id, general.bobMember.id, body, { threadRootId: partly.id });
    await post(general.conversation.id, general.aliceMember.id, "mine", {
      threadRootId: partly.id,
    });
    // A thread read to its end stays listed with nothing unread.
    const read = await post(general.conversation.id, general.aliceMember.id, "read");
    await follow(read.id);
    const last = await post(general.conversation.id, general.bobMember.id, "all seen", {
      threadRootId: read.id,
    });
    await readThread(read.id, last.sequence);
    // A thread marked Done leaves the list and the dot.
    const done = await post(general.conversation.id, general.aliceMember.id, "done");
    await follow(done.id);
    const doneReply = await post(general.conversation.id, general.bobMember.id, "handled", {
      threadRootId: done.id,
    });
    // A direct message with an Agent: one unread message and a thread with two unread replies.
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        name: `nav-${suffix.slice(0, 8)}`,
        displayName: "Nav",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const direct = await repo.openForUser(workspace.id, alice.id, agent.id);
    const agentMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: direct.conversationId, agentId: agent.id },
    });
    const question = await post(direct.conversationId, direct.senderMemberId, "q");
    await db.conversationMember.update({
      where: { id: direct.senderMemberId },
      data: { readThroughSequence: question.sequence },
    });
    await post(direct.conversationId, agentMember.id, "a");
    for (const body of ["step 1", "step 2"])
      await post(direct.conversationId, agentMember.id, body, { threadRootId: question.id });

    const inbox = new ActivityInbox(db);
    await inbox.markDone(workspace.id, alice.id, {
      kind: "thread",
      conversationId: general.conversation.id,
      rootMessageId: done.id,
      throughSequence: doneReply.sequence,
    });
    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.reduce((sum, item) => sum + item.unreadCount, 0)).toBe(7);
    expect(await inbox.navAttention(workspace.id, alice.id)).toEqual({ unread: 7 });
  } finally {
    await cleanup(db, suffix);
  }
});

test("a person can only read and change their own inbox in their own Workspace", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, bob, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const message = await post(general.conversation.id, general.bobMember.id, "hello");
    const outsider = await db.user.create({
      data: { username: `inbox-outsider-${suffix}`, displayName: "outsider" },
    });
    const inbox = new ActivityInbox(db);
    await expect(inbox.list(workspace.id, outsider.id, { filter: "all" })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });

    // Bob is a Workspace member but not in this channel any more.
    await db.conversationMember.update({
      where: { id: general.bobMember.id },
      data: { leftAt: new Date() },
    });
    const done = {
      kind: "conversation" as const,
      conversationId: general.conversation.id,
      throughSequence: message.sequence,
    };
    await expect(inbox.markDone(workspace.id, bob.id, done)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    // The conversation belongs to another Workspace than the one named.
    const other = await db.workspace.create({
      data: { slug: `inbox-other-${suffix}`, name: "Other" },
    });
    await db.workspaceMembership.create({ data: { workspaceId: other.id, userId: alice.id } });
    await expect(inbox.markDone(other.id, alice.id, done)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await db.workspace.delete({ where: { id: other.id } });
  } finally {
    await cleanup(db, suffix);
  }
});
