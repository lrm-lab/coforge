import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { unreadCountCases, VIEWER, type UnreadCountCase } from "./fixtures/activity-unread-cases";
import { database, seed } from "./helpers/activity-inbox-fixture";

type Seeded = Awaited<ReturnType<typeof seed>>;
type Channel = Awaited<ReturnType<Seeded["channel"]>>;
type Database = ReturnType<typeof database>;

/** The server applies the same table as the page, with viewing-only and legacy-server cases removed. */
const serverCases = unreadCountCases.filter(
  (item) => item.viewingKey === undefined && item.before.unreadCount !== undefined,
);

function sortedKeys(keys: string[] | undefined) {
  return [...(keys ?? [])].sort();
}

function comparableState(
  state: { hasUnread: boolean; unreadCount?: number; unreadKeys?: string[] },
  mapKey: (key: string) => string = (key) => key,
) {
  return {
    hasUnread: state.hasUnread,
    unreadCount: state.unreadCount,
    ...(state.unreadCount !== 100 ? { unreadKeys: sortedKeys(state.unreadKeys?.map(mapKey)) } : {}),
  };
}

async function setupCase(db: Database, seeded: Seeded, item: UnreadCountCase) {
  const channels = new Map<string, Channel>();
  const threadRoots = new Map<string, { channel: Channel; rootId: string }>();
  const seededKeys = new Map<string, string>();
  let agentMember: { channelId: string; memberId: string } | undefined;

  const ensureChannel = async (conversationId: string) => {
    const held = channels.get(conversationId);
    if (held) return held;
    const created = await seeded.channel(`case-${conversationId}`);
    channels.set(conversationId, created);
    seededKeys.set(`conversation:${conversationId}`, `conversation:${created.conversation.id}`);
    return created;
  };

  const ensureThread = async (rootName: string, preferred?: Channel, withUnread = false) => {
    const held = threadRoots.get(rootName);
    if (held) return held;
    const channel = preferred ?? (await seeded.channel(`thread-${rootName}`));
    const root = await seeded.post(
      channel.conversation.id,
      channel.aliceMember.id,
      `root ${rootName}`,
    );
    await db.threadFollow.create({
      data: {
        memberId: channel.aliceMember.id,
        rootMessageId: root.id,
        conversationId: channel.conversation.id,
        workspaceId: seeded.workspace.id,
      },
    });
    const result = { channel, rootId: root.id };
    threadRoots.set(rootName, result);
    seededKeys.set(`thread:${rootName}`, `thread:${root.id}`);
    if (withUnread)
      await seeded.post(channel.conversation.id, channel.bobMember.id, `reply ${rootName}`, {
        threadRootId: root.id,
      });
    return result;
  };

  for (const key of item.before.unreadKeys ?? []) {
    if (key.startsWith("conversation:")) {
      const conversationId = key.slice("conversation:".length);
      const channel = await ensureChannel(conversationId);
      await seeded.post(channel.conversation.id, channel.bobMember.id, `before ${conversationId}`);
    } else if (key.startsWith("thread:")) {
      await ensureThread(key.slice("thread:".length), undefined, true);
    }
  }

  const messageChannel = await ensureChannel(item.message.conversationId);
  if (item.message.muted) {
    await db.conversationMember.update({
      where: { id: messageChannel.aliceMember.id },
      data: { notificationLevel: "muted" },
    });
  }

  let senderMemberId: string | null;
  if (item.message.sender.kind === "system") senderMemberId = null;
  else if (item.message.sender.kind === "agent") {
    if (!agentMember || agentMember.channelId !== messageChannel.conversation.id) {
      const agent = await db.agent.create({
        data: {
          workspaceId: seeded.workspace.id,
          name: `case-agent-${crypto.randomUUID()}`,
          displayName: "Case Agent",
          ownerId: seeded.alice.id,
          runtimeConfig: {},
        },
      });
      const member = await db.conversationMember.create({
        data: {
          conversationId: messageChannel.conversation.id,
          workspaceId: seeded.workspace.id,
          agentId: agent.id,
        },
      });
      agentMember = { channelId: messageChannel.conversation.id, memberId: member.id };
    }
    senderMemberId = agentMember.memberId;
  } else if (item.message.senderUserId === VIEWER) senderMemberId = messageChannel.aliceMember.id;
  else senderMemberId = messageChannel.bobMember.id;

  const thread = item.message.threadRootId
    ? await ensureThread(item.message.threadRootId, messageChannel)
    : undefined;
  return {
    keyFor: (key: string) => {
      const seededKey = seededKeys.get(key);
      if (!seededKey) throw new Error(`Fixture key was not seeded: ${key}`);
      return seededKey;
    },
    postMessage: () =>
      seeded.post(
        messageChannel.conversation.id,
        senderMemberId,
        "case message",
        thread ? { threadRootId: thread.rootId } : {},
      ),
  };
}

test("the server nav count follows the shared Activity unread case table", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    for (const [index, item] of serverCases.entries()) {
      const caseSuffix = `${suffix}-${index}`;
      const seeded = await seed(db, caseSuffix);
      try {
        const { postMessage, keyFor } = await setupCase(db, seeded, item);
        const inbox = new ActivityInbox(db, {});
        const before = await inbox.navAttention(seeded.workspace.id, seeded.alice.id);
        expect(comparableState(before), `${item.name} before`).toEqual(
          comparableState(item.before, keyFor),
        );
        await postMessage();
        const actual = await inbox.navAttention(seeded.workspace.id, seeded.alice.id);
        expect(comparableState(actual), item.name).toEqual(comparableState(item.after, keyFor));
      } finally {
        await db.workspace.delete({ where: { id: seeded.workspace.id } });
        await db.user.deleteMany({
          where: { id: { in: [seeded.alice.id, seeded.bob.id] } },
        });
      }
    }
  } finally {
    await db.$disconnect();
  }
});
