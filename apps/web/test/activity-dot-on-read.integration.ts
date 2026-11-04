import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { database, seed, cleanup } from "./helpers/activity-inbox-fixture";

/**
 * The nav rail's Activity dot is refreshed from the server when a read moves the cursor (task
 * #496): a thread reply read clears it, a read that moved nothing says nothing, and the push
 * carries where Activity stands now. Against PostgreSQL; the fixture controls sequences.
 */

/** A realtime port that records every `activityChanged` push and swallows the rest. */
function recordingRealtime() {
  const pushes: { userId: string; hasUnread: boolean }[] = [];
  const realtime: ConversationRealtime = {
    async activityChanged(event) {
      pushes.push({ userId: event.userId, hasUnread: event.attention?.hasUnread ?? false });
    },
    async viewerChanged() {},
    async conversationReadChanged() {},
    async messageAvailable() {},
    async memberChanged() {},
  };
  return { pushes, realtime };
}

test("reading a thread reply pushes the Activity attention and clears the dot", async () => {
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
    const reply = await post(general.conversation.id, general.bobMember.id, "reply", {
      threadRootId: root.id,
    });

    const { pushes, realtime } = recordingRealtime();
    const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);

    // Alice has an unread reply in a thread she follows. Reading it clears her Activity dot and
    // pushes the new state (the top-level root is her own message, so nothing else is unread).
    await channels.markThreadReadForUser(
      workspace.id,
      alice.id,
      general.conversation.id,
      root.id,
      reply.sequence,
    );
    expect(pushes).toEqual([{ userId: alice.id, hasUnread: false }]);

    // Reading the same thread again moves nothing: no push, no query.
    await channels.markThreadReadForUser(
      workspace.id,
      alice.id,
      general.conversation.id,
      root.id,
      reply.sequence,
    );
    expect(pushes).toHaveLength(1);
  } finally {
    await cleanup(db, suffix);
  }
});

test("marking all activity read pushes the attention once, not once per conversation", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    // Several channels, each with an unread message for alice.
    for (let i = 0; i < 4; i += 1) {
      const c = await channel(`c${i}`);
      await post(c.conversation.id, c.bobMember.id, "unread");
    }
    const { pushes, realtime } = recordingRealtime();
    const inbox = new ActivityInbox(db, realtime as never);
    await inbox.markAllRead(workspace.id, alice.id, { before: new Date() });
    // The batch coalesces into a single Activity-attention push, whatever the conversation count.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual({ userId: alice.id, hasUnread: false });
  } finally {
    await cleanup(db, suffix);
  }
});
