import { expect, test } from "bun:test";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import type {
  ConversationRealtime,
  TaskChangedSignal,
} from "#src/server/conversations/conversation-realtime.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";
import { connectionString, privateChannelFixture } from "./helpers/private-channel-fixture";

/**
 * A private channel's own changes (task #302) are announced to its active people only, each on
 * their own channel, never on the Workspace channel every member holds; whoever leaves it has
 * their subscriptions to it ended at once. A public channel's are announced as before. Drives the
 * real services against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
test.skipIf(!connectionString)(
  "a private channel's changes reach its people only, read before a delete, and a leaver is cut off",
  async () => {
    const fixture = await privateChannelFixture(connectionString!);
    const { db, ws, people, open, closed } = fixture;
    const updated: { conversationId: string; memberUserIds?: readonly string[] }[] = [];
    const tasks: TaskChangedSignal[] = [];
    const revoked: { conversationIds: readonly string[]; userIds: readonly string[] }[] = [];
    const realtime: ConversationRealtime = {
      async messageAvailable() {},
      async memberChanged() {},
      async viewerChanged() {},
      async channelUpdated({ conversationId, memberUserIds }) {
        updated.push({ conversationId, memberUserIds });
      },
      async taskChanged(signal) {
        tasks.push(signal);
      },
      async revokeConversations(input) {
        revoked.push(input);
      },
    };
    const channels = new PublicChannels(db, undefined, quietCentrifugo(), undefined, realtime, {
      purge: async () => {},
    });
    const sorted = (ids: readonly string[] | undefined) => (ids ? [...ids].sort() : ids);
    try {
      await channels.updateInfo(ws, { userId: people.insider }, closed.id, { description: "x" });
      await channels.updateInfo(ws, { userId: people.insider }, open.id, { description: "x" });
      expect(updated.splice(0)).toEqual([
        { conversationId: closed.id, memberUserIds: [people.insider] },
        // The public channel's goes to the Workspace, naming nobody.
        { conversationId: open.id, memberUserIds: undefined },
      ]);

      await channels.addMembers(ws, { userId: people.insider }, closed.id, {
        userIds: [people.outsider],
        agentIds: [],
      });
      await channels.setArchived(ws, { userId: people.insider }, closed.id, true);
      await channels.setArchived(ws, { userId: people.insider }, closed.id, false);
      expect(updated.splice(0).map((signal) => sorted(signal.memberUserIds))).toEqual([
        sorted([people.insider, people.outsider]),
        sorted([people.insider, people.outsider]),
      ]);

      // Leaving the private channel ends the leaver's subscriptions; leaving the public one does
      // not, as they still read it.
      await channels.leave(ws, people.outsider, closed.id);
      await channels.leave(ws, people.owner, open.id);
      expect(revoked).toEqual([{ conversationIds: [closed.id], userIds: [people.outsider] }]);

      // Its people are read before the delete takes them: its Tasks' removal goes to them too.
      await db.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: ws, userId: people.insider } },
        data: { role: "admin" },
      });
      await channels.deleteChannel(ws, people.insider, closed.id, async () => ({
        async removeMany() {},
        async removePrefix() {},
      }));
      expect(updated).toEqual([{ conversationId: closed.id, memberUserIds: [people.insider] }]);
      expect(
        tasks.map(({ conversationId, memberUserIds }) => ({ conversationId, memberUserIds })),
      ).toEqual([{ conversationId: closed.id, memberUserIds: [people.insider] }]);
    } finally {
      await fixture.dispose();
    }
  },
);
