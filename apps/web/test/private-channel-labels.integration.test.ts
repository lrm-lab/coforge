import { expect, test } from "bun:test";
import {
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
} from "#src/server/agents/agent-reminders.server";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { pendingMentionActionsForMessage } from "#src/server/conversations/pending-mention-views.server";
import {
  listUserSavedMessages,
  saveUserMessage,
} from "#src/server/conversations/saved-messages.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { connectionString, privateChannelFixture } from "./helpers/private-channel-fixture";

/**
 * Every place outside the channel's own page that names a channel says whether it is private
 * (task #375): search hits, Saved, Activity, the pending-mention strip, an Agent's reminders and
 * the Tasks page's board label. The browser then shows a private channel's name without `#`.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
test.skipIf(!connectionString)(
  "a private channel's name reaches each list with its visibility, a public one's as public",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, suffix, token, people, board, open, closed } = fixture;
    const machineId = `priv-label-${suffix}`;
    try {
      const insider = people.insider;
      const memberOf = (conversationId: string) =>
        db.conversationMember.findFirstOrThrow({ where: { conversationId, userId: insider } });

      // Search.
      const page = await searchMessages(db, {
        workspaceId: ws,
        userId: insider,
        query: token,
        sort: "recent",
        limit: 20,
        offset: 0,
      });
      const hitIn = (id: string) => page.results.find((hit) => hit.conversation.id === id);
      expect(hitIn(closed.id)?.conversation.visibility).toBe("private");
      expect(hitIn(open.id)?.conversation.visibility).toBe("public");

      // Saved.
      for (const channel of [closed, open])
        await saveUserMessage(db, {
          workspaceId: ws,
          conversationId: channel.id,
          userId: insider,
          messageId: channel.message.id,
        });
      const saved = await listUserSavedMessages(db, { workspaceId: ws, userId: insider });
      const savedIn = (id: string) => saved.find((entry) => entry.conversation.id === id);
      expect(savedIn(closed.id)?.conversation.visibility).toBe("private");
      expect(savedIn(open.id)?.conversation.visibility).toBe("public");

      // Activity: a pinned conversation is listed (apart) whatever its unread state.
      for (const channel of [closed, open])
        await db.conversationPin.create({
          data: {
            conversationId: channel.id,
            workspaceId: ws,
            memberId: (await memberOf(channel.id)).id,
          },
        });
      const inbox = await new ActivityInbox(db, {}).list(ws, insider, { filter: "all" });
      const placeOf = (id: string) =>
        [...inbox.items, ...inbox.pinned].find((item) => item.place.conversationId === id)?.place;
      expect(placeOf(closed.id)).toMatchObject({ kind: "channel", visibility: "private" });
      expect(placeOf(open.id)).toMatchObject({ kind: "channel", visibility: "public" });

      // The pending-mention strip under the sender's message.
      const sender = await memberOf(closed.id);
      await db.pendingMentionAction.create({
        data: {
          messageId: closed.message.id,
          conversationId: closed.id,
          workspaceId: ws,
          senderMemberId: sender.id,
          targetUserId: people.outsider,
          targetHandle: `priv-outsider-${suffix}`,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const strip = await pendingMentionActionsForMessage(
        db,
        {
          id: closed.message.id,
          workspaceId: ws,
          conversationId: closed.id,
          senderMemberId: sender.id,
          body: `@priv-outsider-${suffix}`,
        },
        { archivedAt: null, channelName: closed.name, visibility: "private" },
      );
      expect(strip.map((view) => view.visibility)).toEqual(["private"]);

      // An Agent's reminder anchored in the private channel.
      const computer = await db.computer.create({
        data: { ownerId: insider, machineId, name: "insider-mac" },
      });
      await db.workspaceComputer.create({ data: { workspaceId: ws, computerId: computer.id } });
      const agent = await db.agent.create({
        data: {
          workspaceId: ws,
          ownerId: insider,
          computerId: computer.id,
          name: `priv-label-agent-${suffix}`,
          displayName: "Keeper",
          runtimeConfig: {},
        },
      });
      await db.reminder.create({
        data: {
          workspaceId: ws,
          ownerAgentId: agent.id,
          computerId: computer.id,
          title: "Check the vault",
          target: "self",
          messageId: closed.message.id,
          fireAt: new Date("2026-12-01T09:00:00Z"),
        },
      });
      const reminders = await new AgentRemindersQuery(prismaAgentReminderReadStore(db)).list(
        { userId: insider, workspaceId: ws },
        { agentId: agent.id },
      );
      expect(reminders).toMatchObject({
        status: "ready",
        reminders: [{ anchor: { kind: "channel", channelId: closed.id, visibility: "private" } }],
      });

      // The Tasks page names a Task's board: `#open`, or the bare name of a private one.
      const overview = await board.overview(ws, insider);
      const labelOf = (id: string) => overview.tasks.find((task) => task.id === id)?.source?.label;
      expect(labelOf(closed.message.id)).toBe(closed.name);
      expect(labelOf(open.message.id)).toBe(`#${open.name}`);
    } finally {
      await db.reminder.deleteMany({ where: { workspaceId: ws } });
      await db.agent.deleteMany({ where: { workspaceId: ws } });
      await db.workspaceComputer.deleteMany({ where: { workspaceId: ws } });
      await db.computer.deleteMany({ where: { machineId } });
      await fixture.dispose();
    }
  },
);
