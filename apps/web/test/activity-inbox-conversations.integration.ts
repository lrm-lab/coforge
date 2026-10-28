import { expect, test } from "bun:test";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { DirectConversationPeer } from "#src/server/conversations/direct-conversation-peer.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { openPeopleDirectConversation } from "#src/server/conversations/user-direct-conversations.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { database, kindOf, seed, cleanup } from "./helpers/activity-inbox-fixture";

/** Activity inbox against PostgreSQL; shared fixtures control exact sequences and cleanup. */
test("a thread counts only the unread replies past its read cursor, on any page", async () => {
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
    const older = await post(general.conversation.id, general.aliceMember.id, "older");
    const newer = await post(general.conversation.id, general.aliceMember.id, "newer");
    await follow(older.id);
    await follow(newer.id);
    await db.conversationMember.update({
      where: { id: general.aliceMember.id },
      data: { readThroughSequence: newer.sequence },
    });
    // Read replies, the viewer's own and a system notice: none is unread.
    await post(general.conversation.id, general.bobMember.id, "read one", {
      threadRootId: older.id,
    });
    const seen = await post(general.conversation.id, general.aliceMember.id, "my own", {
      threadRootId: older.id,
    });
    await post(general.conversation.id, null, "1 new task created: #1", {
      threadRootId: older.id,
    });
    await db.threadRead.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: older.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
        readThroughSequence: seen.sequence + 1,
      },
    });
    const firstUnread = await post(general.conversation.id, general.bobMember.id, "unread one", {
      threadRootId: older.id,
    });
    await post(general.conversation.id, general.aliceMember.id, "my own again", {
      threadRootId: older.id,
    });
    await post(general.conversation.id, general.bobMember.id, "unread two", {
      threadRootId: older.id,
    });
    await post(general.conversation.id, general.bobMember.id, "only reply", {
      threadRootId: newer.id,
    });

    const inbox = new ActivityInbox(db);
    const firstPage = await inbox.list(workspace.id, alice.id, { filter: "all", limit: 1 });
    expect(firstPage.items.map((item) => item.thread?.root.body)).toEqual(["newer"]);
    const secondPage = await inbox.list(workspace.id, alice.id, {
      filter: "all",
      offset: firstPage.nextOffset!,
      limit: 1,
    });
    expect(secondPage.items).toHaveLength(1);
    const [thread] = secondPage.items;
    expect(thread!.thread?.root.body).toBe("older");
    expect(thread!.unreadCount).toBe(2);
    expect(thread!.firstUnreadMessageId).toBe(firstUnread.id);
    // The counts cover the whole list, not the page: both threads have unread replies.
    expect(secondPage.unreadItemCount).toBe(2);
  } finally {
    await cleanup(db, suffix);
  }
});

test("direct messages and their threads are listed with the Agent they belong to", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, pin } = await seed(db, suffix);
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        name: `helper-${suffix.slice(0, 8)}`,
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const opened = await repo.openForUser(workspace.id, alice.id, agent.id);
    const root = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      alice.id,
      "q",
    );
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      alice.id,
      "follow-up in thread",
      undefined,
      root.id,
    );

    const inbox = new ActivityInbox(db);
    let page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(
      page.items.map((item) => [
        kindOf(item),
        item.place.kind === "direct" && item.place.peer.kind === "agent"
          ? item.place.peer.agentId
          : null,
      ]),
    ).toEqual([
      ["thread", agent.id],
      ["direct", agent.id],
    ]);
    const direct = page.items[1]!.place;
    expect(direct.kind === "direct" && direct.peer.displayName).toBe("Helper");

    // Pinned, the DM lists under Pinned with its Agent, and its thread stays among the items.
    await pin({ id: opened.senderMemberId, conversationId: opened.conversationId }, 0);
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.pinned.map((item) => item.place)).toEqual([direct]);
    expect(page.items.map(kindOf)).toEqual(["thread"]);
    await db.conversationPin.deleteMany({ where: { conversationId: opened.conversationId } });

    // A deleted Agent's conversation stays readable in Chat but leaves the inbox.
    await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items).toEqual([]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("direct messages between members, and a member's with themself, are listed with the member on the other side", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, bob, workspace, post } = await seed(db, suffix);
    const carol = await db.user.create({
      data: { username: `inbox-carol-${suffix}`, displayName: "  " },
    });
    await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: carol.id } });
    const memberOf = (conversationId: string, userId: string) =>
      db.conversationMember.findFirstOrThrow({ where: { conversationId, userId } });

    const withBob = await openPeopleDirectConversation(db, workspace.id, alice.id, bob.id);
    const withSelf = await openPeopleDirectConversation(db, workspace.id, alice.id, alice.id);
    const aliceWithBob = await memberOf(withBob.conversationId, alice.id);
    const bobWithAlice = await memberOf(withBob.conversationId, bob.id);
    const aliceWithSelf = await memberOf(withSelf.conversationId, alice.id);
    const root = await post(withBob.conversationId, aliceWithBob.id, "lunch?");
    await post(withBob.conversationId, bobWithAlice.id, "sure", { threadRootId: root.id });
    await post(withSelf.conversationId, aliceWithSelf.id, "a note to self");
    await post(withBob.conversationId, bobWithAlice.id, "see you at noon");

    // Neither a DM between two other members that holds a stray row of hers, nor an Agent's DM
    // she is in but did not create, is one of her direct messages.
    const others = await openPeopleDirectConversation(db, workspace.id, bob.id, carol.id);
    await db.conversationMember.create({
      data: { conversationId: others.conversationId, workspaceId: workspace.id, userId: alice.id },
    });
    const othersBob = await memberOf(others.conversationId, bob.id);
    await post(others.conversationId, othersBob.id, "between bob and carol");
    const bobsAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: bob.id,
        name: `bobs-${suffix.slice(0, 8)}`,
        displayName: "Bob's",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const bobsDm = await repo.openForUser(workspace.id, bob.id, bobsAgent.id);
    await db.conversationMember.create({
      data: { conversationId: bobsDm.conversationId, workspaceId: workspace.id, userId: alice.id },
    });
    await post(bobsDm.conversationId, bobsDm.senderMemberId, "bob to his Agent");

    const inbox = new ActivityInbox(db);
    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    // Neither uploaded an avatar; each still has their stable cartoon default.
    const peopleAt = (
      user: { id: string; username: string },
      displayName: string,
    ): Extract<DirectConversationPeer, { kind: "people" }> => ({
      kind: "people",
      userId: user.id,
      username: user.username,
      displayName,
      avatarUrl: workspaceUserAvatarUrl(workspace.id, user.id, null),
    });
    const bobPeer = peopleAt(bob, "bob");
    expect(
      page.items.map((item) => [
        kindOf(item),
        item.place.conversationId,
        item.place.kind === "direct" ? item.place.peer : null,
        item.unreadCount,
      ]),
    ).toEqual([
      ["direct", withBob.conversationId, bobPeer, 1],
      ["direct", withSelf.conversationId, peopleAt(alice, "alice"), 0],
      ["thread", withBob.conversationId, bobPeer, 1],
    ]);
    expect(await inbox.navAttention(workspace.id, alice.id)).toEqual({ hasUnread: true });

    // Done takes the DM and its thread out, the same as a channel's.
    const latest = await db.message.findFirstOrThrow({
      where: { conversationId: withBob.conversationId, threadRootId: null },
      orderBy: { sequence: "desc" },
    });
    const reply = await db.message.findFirstOrThrow({
      where: { conversationId: withBob.conversationId, threadRootId: root.id },
    });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "conversation",
      conversationId: withBob.conversationId,
      throughSequence: latest.sequence,
    });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "thread",
      conversationId: withBob.conversationId,
      rootMessageId: root.id,
      throughSequence: reply.sequence,
    });
    expect(
      (await inbox.list(workspace.id, alice.id, { filter: "all" })).items.map(
        (item) => item.place.conversationId,
      ),
    ).toEqual([withSelf.conversationId]);
    expect(await inbox.navAttention(workspace.id, alice.id)).toEqual({ hasUnread: false });

    // A member with a blank display name reads as the placeholder, never by their username.
    const withCarol = await openPeopleDirectConversation(db, workspace.id, alice.id, carol.id);
    const carolWithAlice = await memberOf(withCarol.conversationId, carol.id);
    await post(withCarol.conversationId, carolWithAlice.id, "hi alice");
    const [newest] = (await inbox.list(workspace.id, alice.id, { filter: "all" })).items;
    expect(newest!.place.kind === "direct" && newest!.place.peer.displayName).toBe(
      UNNAMED_PERSON_NAME,
    );
  } finally {
    await cleanup(db, suffix);
  }
});

test("a person notified of a mention outside their channels finds it in Activity, reads it like any item, and it leaves on Done", async () => {
  const db = database();
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `ma-${suffix}`, displayName: "Alice" } });
  const bob = await db.user.create({ data: { username: `mb-${suffix}`, displayName: "Bob" } });
  const workspace = await db.workspace.create({
    data: {
      slug: `mention-inbox-${suffix}`,
      name: "Mention inbox",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const announced: { workspaceId: string; userId: string }[] = [];
    const channels = new PublicChannels(
      db,
      undefined,
      { publish: async () => {}, publishJson: async () => {}, broadcast: async () => {} },
      undefined,
      {
        messageAvailable: async () => {},
        memberChanged: async () => {},
        activityChanged: async (input) => {
          announced.push(input);
        },
      },
    );
    const triage = await channels.create(workspace.id, alice.id, `triage-${suffix}`);
    const sent = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: triage.id,
      idempotencyKey: crypto.randomUUID(),
      body: `@mb-${suffix} can you look at this`,
    });
    const inbox = new ActivityInbox(db);
    const mentionsOf = async () =>
      (await inbox.list(workspace.id, bob.id, { filter: "mentions" })).items;
    const countsOf = async () => {
      const { unreadItemCount, unreadMentionItemCount } = await inbox.list(workspace.id, bob.id, {
        filter: "all",
      });
      return { unreadItemCount, unreadMentionItemCount };
    };
    // Not notified yet: nothing reached Bob.
    expect(await mentionsOf()).toEqual([]);

    const resolutionId = sent.pendingMentionActions[0]!.resolutionId;
    await channels.executeMentionActions(workspace.id, alice.id, "notify", [resolutionId]);
    // Bob's open Activity page and nav dot are told to re-read.
    expect(announced).toEqual([{ workspaceId: workspace.id, userId: bob.id }]);
    const [item] = await mentionsOf();
    expect(item).toMatchObject({
      key: `mention:${resolutionId}`,
      place: { kind: "channel", conversationId: triage.id, channelName: `triage-${suffix}` },
      mentionAction: { resolutionId },
      thread: null,
      unreadCount: 1,
      firstMentionMessageId: sent.id,
    });
    expect(item!.latest.id).toBe(sent.id);
    expect((await inbox.navAttention(workspace.id, bob.id)).hasUnread).toBe(true);
    // Unread, it counts under both Unread and Mentions.
    expect(await countsOf()).toEqual({ unreadItemCount: 1, unreadMentionItemCount: 1 });
    // Alice's own inbox never lists what she sent.
    expect(
      (await inbox.list(workspace.id, alice.id, { filter: "all" })).items.some(
        (entry) => entry.mentionAction,
      ),
    ).toBe(false);

    // Read and unread like any item: it stays listed either way.
    await inbox.setMentionRead(workspace.id, bob.id, resolutionId, true);
    expect((await mentionsOf()).map((entry) => entry.unreadCount)).toEqual([0]);
    expect((await inbox.navAttention(workspace.id, bob.id)).hasUnread).toBe(false);
    expect(await countsOf()).toEqual({ unreadItemCount: 0, unreadMentionItemCount: 0 });
    await inbox.setMentionRead(workspace.id, bob.id, resolutionId, false);
    expect((await mentionsOf()).map((entry) => entry.unreadCount)).toEqual([1]);
    // Mark all read reads it too.
    await inbox.markAllRead(workspace.id, bob.id, { before: new Date() });
    expect((await inbox.navAttention(workspace.id, bob.id)).hasUnread).toBe(false);

    await inbox.markDone(workspace.id, bob.id, { kind: "mention_action", resolutionId });
    expect(await mentionsOf()).toEqual([]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
