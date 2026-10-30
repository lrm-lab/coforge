import { expect, test } from "bun:test";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { browserActivityInbox } from "#src/server/inbox/browser-activity-inbox.server";
import { cleanup, database, kindOf, seed } from "./helpers/activity-inbox-fixture";

/**
 * The Activity inbox's clearing writes (`activity-inbox-writes.server.ts`) against PostgreSQL:
 * Done and read-all tell the person's other pages that the inbox changed, which is what clears the
 * nav rail's Activity dot there. Reading never announces that.
 */
test("Done and read-all tell the person's other pages, so a second tab's dot clears", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    await post(general.conversation.id, general.bobMember.id, "hello");
    const announced: { workspaceId: string; userId: string }[] = [];
    const inbox = new ActivityInbox(db, {
      viewerChanged: async () => {},
      activityChanged: async (input) => {
        announced.push(input);
      },
    });

    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    // Reading the list is not a change: nothing is announced.
    expect(announced).toEqual([]);

    const item = page.items.find((entry) => kindOf(entry) === "channel")!;
    await inbox.markDone(workspace.id, alice.id, {
      kind: "conversation",
      conversationId: item.place.conversationId,
      throughSequence: item.latestSequence,
    });
    expect(announced).toEqual([{ workspaceId: workspace.id, userId: alice.id }]);

    announced.length = 0;
    await inbox.markAllRead(workspace.id, alice.id, { before: new Date() });
    expect(announced).toEqual([{ workspaceId: workspace.id, userId: alice.id }]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("the inbox a person's pages write through publishes to their channel", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    await post(general.conversation.id, general.bobMember.id, "hello");
    const published: { channel: string; data: unknown }[] = [];
    const inbox = browserActivityInbox(db, {
      publishJson: async (channel: string, data: unknown) => {
        published.push({ channel, data });
      },
      broadcast: async () => {},
    } as never);

    await inbox.markAllRead(workspace.id, alice.id, { before: new Date() });
    expect(published).toContainEqual({
      channel: userConversationChannel(alice.id),
      data: { type: "activity.changed.v1", workspaceId: workspace.id },
    });
  } finally {
    await cleanup(db, suffix);
  }
});
