import { expect, test } from "bun:test";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import {
  connectionString,
  errorOf,
  expectMissingForOutsiders,
  privateChannelFixture,
  type PersonRead,
} from "./helpers/private-channel-fixture";

/**
 * A private channel (task #302) is read, by a person, only by its active members: the Workspace
 * owner who is not in it and a member who never joined meet the same `NOT_FOUND` a missing channel
 * gives. This file covers the channel itself: lists, page, updates, thread, history, roster, join
 * and management, and what being added and removed does. The public channel behaves as it always
 * did. Drives the real services against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
test.skipIf(!connectionString)(
  "a private channel is gone for a person outside it, owner included: lists, page, roster, management",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, people, outsiders, channels, history, open, closed, vault } = fixture;
    try {
      // Lists: the private channels (archived too) are the insider's alone.
      for (const [who, sees] of [
        ["insider", true],
        ["owner", false],
        ["outsider", false],
      ] as const) {
        const userId = people[who];
        const listed = (await channels.list(ws, userId)).map((row) => row.id);
        const named = (await channels.names(ws, userId)).map((row) => row.id);
        for (const id of [closed.id, vault.id]) {
          expect({ who, listed: listed.includes(id), named: named.includes(id) }).toEqual({
            who,
            listed: sees,
            named: sees,
          });
        }
        expect(listed).toContain(open.id);
        expect(named).toContain(open.id);
      }
      expect((await channels.archived(ws, people.owner)).map((row) => row.id)).not.toContain(
        vault.id,
      );

      // Every channel read a person makes: the insider reads it, the others meet a missing one.
      const reads: PersonRead[] = [
        ["open", (userId) => channels.open(ws, userId, closed.id)],
        ["updates", (userId) => channels.updates(ws, userId, closed.id, 0)],
        ["mentionDirectory", (userId) => channels.mentionDirectory(ws, userId, closed.id)],
        ["mentionOutsiders", (userId) => channels.mentionOutsiders(ws, userId, closed.id)],
        ["members", (userId) => channels.members(ws, { userId }, closed.id)],
        ["thread", (userId) => history.loadThread(ws, userId, closed.id, closed.message.id)],
        ["around", (userId) => history.loadAround(ws, userId, closed.id, closed.message.id)],
        ["own messages", (userId) => history.listOwnMessages(ws, userId, closed.id)],
        ["mute", (userId) => channels.setUserMuted(ws, userId, closed.id, true)],
        ["pin", (userId) => channels.setUserPinned(ws, userId, closed.id, true)],
        [
          "send",
          (userId) =>
            channels.send({
              workspaceId: ws,
              userId,
              channelId: closed.id,
              idempotencyKey: crypto.randomUUID(),
              body: "hello",
            }),
        ],
      ];
      await expectMissingForOutsiders(fixture, reads);
      // The public channel answers the outsider as before.
      expect(
        (await channels.open(ws, people.outsider, open.id)).messages.map((m) => m.id),
      ).toContain(open.message.id);
      expect(
        (await history.loadThread(ws, people.outsider, open.id, open.message.id)).replies,
      ).toHaveLength(1);
      expect(
        await errorOf(
          readAuthorizedAttachment(db, {
            attachmentId: open.attachment.id,
            workspaceId: ws,
            userId: people.outsider,
          }),
        ),
      ).toBeUndefined();

      // Join and management: reading comes first, so a Workspace owner is no exception.
      const management: PersonRead[] = [
        ["join", (userId) => channels.join(ws, userId, closed.id)],
        ["leave", (userId) => channels.leave(ws, userId, closed.id)],
        [
          "update",
          (userId) => channels.updateInfo(ws, { userId }, closed.id, { description: "x" }),
        ],
        ["archive", (userId) => channels.setArchived(ws, { userId }, closed.id, true)],
        ["unarchive", (userId) => channels.setArchived(ws, { userId }, vault.id, false)],
        ["delete", (userId) => channels.deleteChannel(ws, userId, closed.id)],
        [
          "remove",
          (userId) => channels.removeMember(ws, userId, closed.id, { userId: people.insider }),
        ],
        [
          "add",
          (userId) =>
            channels.addMembers(ws, { userId }, closed.id, { userIds: [userId], agentIds: [] }),
        ],
        [
          "role",
          (userId) =>
            channels.setChannelRole(ws, userId, closed.id, { userId: people.insider }, "member"),
        ],
      ];
      for (const [name, act] of management) {
        for (const userId of outsiders) {
          expect({ name, error: await errorOf(act(userId)) }).toEqual({ name, error: "NOT_FOUND" });
        }
      }

      // Being added is what lets a person in; being removed shuts them out again.
      await channels.addMembers(ws, { userId: people.insider }, closed.id, {
        userIds: [people.outsider],
        agentIds: [],
      });
      expect(
        (await channels.open(ws, people.outsider, closed.id)).messages.map((message) => message.id),
      ).toContain(closed.message.id);
      expect((await channels.list(ws, people.outsider)).map((row) => row.id)).toContain(closed.id);
      await channels.removeMember(ws, people.insider, closed.id, { userId: people.outsider });
      expect(await errorOf(channels.open(ws, people.outsider, closed.id))).toBe("NOT_FOUND");

      // The member administers it; an archived private channel stays theirs.
      expect(
        await errorOf(
          channels.updateInfo(ws, { userId: people.insider }, closed.id, { description: "x" }),
        ),
      ).toBeUndefined();
      expect(
        await errorOf(channels.setArchived(ws, { userId: people.insider }, vault.id, false)),
      ).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  },
);
