import { expect, test } from "bun:test";
import { ChatSections } from "#src/server/conversations/chat-sections.server";
import { arrangeConversationPins } from "#src/server/conversations/conversation-pins.server";
import {
  listUserSavedMessages,
  saveUserMessage,
  unsaveUserMessage,
} from "#src/server/conversations/saved-messages.server";
import { toggleUserMessageReaction } from "#src/server/conversations/user-message-reactions.server";
import {
  connectionString,
  errorOf,
  expectMissingForOutsiders,
  pinRef,
  privateChannelFixture,
  type PersonRead,
} from "./helpers/private-channel-fixture";

/**
 * A private channel (task #302) is read, by a person, only by its active members. This file covers
 * a person's own working set: the Tasks board, Saved messages, pins and Chat groups, and that a
 * DM is not widened by the rule. The outsider and the Workspace owner outside the channel meet the
 * `NOT_FOUND` a missing channel gives. Drives the real services against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
test.skipIf(!connectionString)(
  "a private channel's Tasks, bookmarks, pins and groups are its members' alone",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, token, people, outsiders, channels, board, open, closed, direct } = fixture;
    try {
      const reads: PersonRead[] = [
        [
          "save",
          (userId) =>
            saveUserMessage(db, {
              workspaceId: ws,
              conversationId: closed.id,
              userId,
              messageId: closed.message.id,
            }),
        ],
        [
          "tasks",
          (userId) =>
            board.execute(
              { workspaceId: ws, userId },
              { operation: "list", conversationId: closed.id, idempotencyKey: crypto.randomUUID() },
            ),
        ],
        [
          "unsave",
          (userId) =>
            unsaveUserMessage(db, {
              workspaceId: ws,
              conversationId: closed.id,
              userId,
              messageId: closed.message.id,
            }),
        ],
      ];
      await expectMissingForOutsiders(fixture, reads);

      // Pin and section writes name a channel only the insider is in; a missing one reads alike.
      for (const userId of outsiders) {
        expect(await errorOf(arrangeConversationPins(db, ws, userId, pinRef(closed.id)))).toBe(
          await errorOf(arrangeConversationPins(db, ws, userId, pinRef(crypto.randomUUID()))),
        );
        expect(await errorOf(new ChatSections(db, ws, userId).move(closed.id, null))).toBe(
          await errorOf(new ChatSections(db, ws, userId).move(crypto.randomUUID(), null)),
        );
      }
      expect(
        await errorOf(arrangeConversationPins(db, ws, people.insider, pinRef(closed.id))),
      ).toBeUndefined();
      expect(
        await errorOf(new ChatSections(db, ws, people.insider).move(closed.id, null)),
      ).toBeUndefined();

      // The Tasks page lists a private channel's Tasks for its member only.
      const overview = async (userId: string) =>
        (await board.overview(ws, userId)).tasks.map((task) => task.title);
      expect(await overview(people.insider)).toHaveLength(3);
      for (const userId of outsiders)
        expect(await overview(userId)).toEqual([`${token} task public`]);

      // The board's other reads: one Task, and the finished Tasks listed and counted.
      const finishedTitles = async (userId: string) =>
        (
          await board.finishedPage({ workspaceId: ws, userId }, { status: "done", window: "all" })
        ).tasks.map((task) => task.title);
      const finishedCount = async (userId: string) =>
        (await board.finishedSummary({ workspaceId: ws, userId }, { window: "all" })).groups.reduce(
          (total, group) => total + group.count,
          0,
        );
      const oneTask = async (userId: string, conversationId: string) =>
        board.overviewTask({ workspaceId: ws, userId }, { conversationId, number: 1 });
      expect(await finishedTitles(people.insider)).toHaveLength(3);
      expect(await finishedCount(people.insider)).toBe(3);
      expect(await oneTask(people.insider, closed.id)).not.toBeNull();
      for (const userId of outsiders) {
        expect(await finishedTitles(userId)).toEqual([`${token} finished public`]);
        expect(await finishedCount(userId)).toBe(1);
        expect(await oneTask(userId, closed.id)).toBeNull();
        expect(await oneTask(userId, open.id)).not.toBeNull();
      }

      // A DM is not widened by the rule: a Workspace member outside it still cannot act on it.
      const onDirect = {
        workspaceId: ws,
        conversationId: direct.id,
        messageId: direct.message.id,
      };
      expect(await errorOf(saveUserMessage(db, { ...onDirect, userId: people.outsider }))).toBe(
        "ACCESS_DENIED",
      );
      expect(
        await errorOf(
          toggleUserMessageReaction(db, undefined, {
            ...onDirect,
            userId: people.outsider,
            emoji: "👍",
            active: true,
          }),
        ),
      ).toBe("ACCESS_DENIED");
      expect(
        await errorOf(saveUserMessage(db, { ...onDirect, userId: people.owner })),
      ).toBeUndefined();

      // Saved: the insider's bookmark leaves their list once they can no longer read the channel.
      await saveUserMessage(db, {
        workspaceId: ws,
        conversationId: closed.id,
        userId: people.insider,
        messageId: closed.message.id,
      });
      const saved = async () =>
        (await listUserSavedMessages(db, { workspaceId: ws, userId: people.insider })).map(
          (row) => row.message.id,
        );
      expect(await saved()).toEqual([closed.message.id]);
      await channels.leave(ws, people.insider, closed.id);
      expect(await saved()).toEqual([]);
      // Having left, they may still clear their own bookmark, but not pin or group the channel;
      // that answers as a channel that does not exist. A person with no member row at all is told
      // the message is missing, as for a made-up one.
      expect(
        await errorOf(
          unsaveUserMessage(db, {
            workspaceId: ws,
            conversationId: closed.id,
            userId: people.insider,
            messageId: closed.message.id,
          }),
        ),
      ).toBeUndefined();
      const missing = crypto.randomUUID();
      expect(
        await errorOf(arrangeConversationPins(db, ws, people.insider, pinRef(closed.id))),
      ).toBe(await errorOf(arrangeConversationPins(db, ws, people.insider, pinRef(missing))));
      expect(await errorOf(new ChatSections(db, ws, people.insider).move(closed.id, null))).toBe(
        await errorOf(new ChatSections(db, ws, people.insider).move(missing, null)),
      );
      expect(await errorOf(channels.setUserPinned(ws, people.insider, closed.id, true))).toBe(
        "NOT_FOUND",
      );
      for (const userId of outsiders)
        expect(
          await errorOf(
            unsaveUserMessage(db, {
              workspaceId: ws,
              conversationId: closed.id,
              userId,
              messageId: missing,
            }),
          ),
        ).toBe("NOT_FOUND");
      expect(await errorOf(channels.open(ws, people.insider, closed.id))).toBe("NOT_FOUND");
      expect(await errorOf(channels.join(ws, people.insider, closed.id))).toBe("NOT_FOUND");
      await db.conversationMember.updateMany({
        where: { conversationId: closed.id, userId: people.insider },
        data: { leftAt: null },
      });
      // Back in, the bookmark they cleared is theirs to make again.
      await saveUserMessage(db, {
        workspaceId: ws,
        conversationId: closed.id,
        userId: people.insider,
        messageId: closed.message.id,
      });
      expect(await saved()).toEqual([closed.message.id]);
    } finally {
      await fixture.dispose();
    }
  },
);
