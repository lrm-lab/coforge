import { expect, test } from "bun:test";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { listConversationFiles } from "#src/server/conversations/conversation-files.server";
import { readMessageReactions } from "#src/server/conversations/message-reaction-reads.server";
import { readMessageSeenBy } from "#src/server/conversations/message-seen-by.server";
import { toggleUserMessageReaction } from "#src/server/conversations/user-message-reactions.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { findMessageSearchIds } from "#src/server/db/repositories/message-search.repositories.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import {
  connectionString,
  expectMissingForOutsiders,
  privateChannelFixture,
  type PersonRead,
} from "./helpers/private-channel-fixture";

/**
 * A private channel (task #302) is read, by a person, only by its active members. This file covers
 * what is in the channel: reactions, files and their comments, who has seen a message, search and
 * the Activity inbox. The outsider and the Workspace owner outside it meet the `NOT_FOUND` a
 * missing channel gives; the public channel behaves as it always did. Drives the real services
 * against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
test.skipIf(!connectionString)(
  "a private channel's messages, files, search hits and mentions are its members' alone",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, suffix, token, people, outsiders, channels, open, closed, vault } = fixture;
    try {
      const reads: PersonRead[] = [
        [
          "react",
          (userId) =>
            channels.toggleUserReaction(ws, userId, closed.id, closed.message.id, "👍", true),
        ],
        [
          "react (service)",
          (userId) =>
            toggleUserMessageReaction(db, undefined, {
              workspaceId: ws,
              conversationId: closed.id,
              userId,
              messageId: closed.message.id,
              emoji: "👍",
              active: true,
            }),
        ],
        [
          "attachment",
          (userId) =>
            readAuthorizedAttachment(db, {
              attachmentId: closed.attachment.id,
              workspaceId: ws,
              userId,
            }),
        ],
        [
          "files",
          (userId) =>
            listConversationFiles(db, { workspaceId: ws, userId, conversationId: closed.id }),
        ],
        [
          "seen by",
          (userId) =>
            readMessageSeenBy(db, {
              workspaceId: ws,
              userId,
              conversationId: closed.id,
              messageId: closed.message.id,
            }),
        ],
        [
          "reactions",
          (userId) =>
            readMessageReactions(db, {
              workspaceId: ws,
              userId,
              conversationId: closed.id,
              messageIds: [closed.message.id],
            }),
        ],
      ];
      await expectMissingForOutsiders(fixture, reads);

      // Search finds the private channel's messages for its member only.
      const search = (userId: string) =>
        findMessageSearchIds(db, {
          workspaceId: ws,
          viewerUserId: userId,
          terms: [token],
          query: token,
          sort: "recent",
          limit: 20,
          offset: 0,
        });
      const everything = [closed, vault, open].flatMap((c) => [c.message.id, c.reply.id]);
      expect((await search(people.insider)).sort()).toEqual([...everything].sort());
      for (const userId of outsiders)
        expect((await search(userId)).sort()).toEqual([open.message.id, open.reply.id].sort());

      // Comments on a file: readable where the file is.
      const comments = new PrismaAttachmentCommentStore(db);
      const canComment = async (userId: string, attachmentId: string) =>
        (await comments.access({ workspaceId: ws, userId }, attachmentId))?.canRead;
      expect(await canComment(people.insider, closed.attachment.id)).toBe(true);
      for (const userId of outsiders) {
        expect(await canComment(userId, closed.attachment.id)).toBe(false);
        expect(await canComment(userId, open.attachment.id)).toBe(true);
      }

      // Activity: a mention notified to someone outside the channel does not list its message.
      const insiderRow = await db.conversationMember.findFirstOrThrow({
        where: { conversationId: closed.id, userId: people.insider },
      });
      const notify = (conversationId: string, messageId: string) =>
        db.pendingMentionAction.create({
          data: {
            workspaceId: ws,
            conversationId,
            messageId,
            senderMemberId: insiderRow.id,
            targetUserId: people.outsider,
            targetHandle: `priv-outsider-${suffix}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            notifiedAt: new Date(),
          },
        });
      await notify(closed.id, closed.message.id);
      const inbox = new ActivityInbox(db);
      const mentions = async () =>
        (await inbox.list(ws, people.outsider, { filter: "mentions" })).items.length;
      const attention = async () => (await inbox.navAttention(ws, people.outsider)).hasUnread;
      expect({ mentions: await mentions(), attention: await attention() }).toEqual({
        mentions: 0,
        attention: false,
      });
      const publicInsiderRow = await db.conversationMember.findFirstOrThrow({
        where: { conversationId: open.id, userId: people.insider },
      });
      await db.pendingMentionAction.create({
        data: {
          workspaceId: ws,
          conversationId: open.id,
          messageId: open.message.id,
          senderMemberId: publicInsiderRow.id,
          targetUserId: people.outsider,
          targetHandle: `priv-outsider-${suffix}`,
          expiresAt: new Date(Date.now() + 3_600_000),
          notifiedAt: new Date(),
        },
      });
      expect({ mentions: await mentions(), attention: await attention() }).toEqual({
        mentions: 1,
        attention: true,
      });

      // Being added is what lets a person in to search it.
      await channels.addMembers(ws, { userId: people.insider }, closed.id, {
        userIds: [people.outsider],
        agentIds: [],
      });
      expect(await search(people.outsider)).toContain(closed.message.id);
    } finally {
      await fixture.dispose();
    }
  },
);
