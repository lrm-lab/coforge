import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { cleanup, database, seed, isConversation } from "./helpers/activity-inbox-fixture";

async function fixture(db: ReturnType<typeof database>, suffix: string, notificationLevel: string) {
  const seeded = await seed(db, suffix);
  const general = await seeded.channel("general");
  await db.conversationMember.update({
    where: { id: general.aliceMember.id },
    data: { notificationLevel },
  });
  const inbox = new ActivityInbox(db, {});
  const list = () => inbox.list(seeded.workspace.id, seeded.alice.id, { filter: "all" });
  const attention = () => inbox.navAttention(seeded.workspace.id, seeded.alice.id);
  return { ...seeded, general, list, attention };
}

test.each(["muted", "relevant"])(
  "ordinary messages at level %s stay out of Activity",
  async (level) => {
    const db = database();
    const suffix = crypto.randomUUID();
    try {
      const { general, post, list, attention } = await fixture(db, suffix, level);
      await post(general.conversation.id, general.bobMember.id, "ordinary");
      expect((await list()).items.filter(isConversation)).toEqual([]);
      expect(await attention()).toEqual({ hasUnread: false, unreadCount: 0, unreadKeys: [] });
    } finally {
      await cleanup(db, suffix);
    }
  },
);

test.each(["muted", "relevant"])(
  "Activity at level %s counts and opens the mention",
  async (level) => {
    const db = database();
    const suffix = crypto.randomUUID();
    try {
      const { general, post, list, attention } = await fixture(db, suffix, level);
      const id = general.conversation.id;
      await post(id, general.bobMember.id, "before");
      const mention = await post(id, general.bobMember.id, "hey", {
        mentionMemberIds: [general.aliceMember.id],
      });
      await post(id, general.bobMember.id, "after");

      const [item] = (await list()).items.filter(isConversation);
      expect(item?.unreadCount).toBe(1);
      expect(item?.firstUnreadMessageId).toBe(mention.id);
      expect(item?.latest.id).toBe(mention.id);
      expect(await attention()).toEqual({
        hasUnread: true,
        unreadCount: 1,
        unreadKeys: [`conversation:${id}`],
      });
    } finally {
      await cleanup(db, suffix);
    }
  },
);

test.each(["muted", "relevant"])(
  "a followed thread at level %s stays in Activity",
  async (level) => {
    const db = database();
    const suffix = crypto.randomUUID();
    try {
      const { general, post, list, workspace, attention } = await fixture(db, suffix, level);
      const id = general.conversation.id;
      const root = await post(id, general.aliceMember.id, "root");
      await db.threadFollow.create({
        data: {
          memberId: general.aliceMember.id,
          rootMessageId: root.id,
          conversationId: id,
          workspaceId: workspace.id,
        },
      });
      await post(id, general.bobMember.id, "reply", { threadRootId: root.id });

      const items = (await list()).items.filter(isConversation);
      expect(items).toHaveLength(1);
      expect(items[0]?.thread).toBeTruthy();
      expect(items[0]?.unreadCount).toBe(1);
      expect(await attention()).toEqual({
        hasUnread: true,
        unreadCount: 1,
        unreadKeys: [`thread:${root.id}`],
      });
    } finally {
      await cleanup(db, suffix);
    }
  },
);

test.each(["muted", "relevant"])(
  "switching from %s to all brings ordinary messages back",
  async (level) => {
    const db = database();
    const suffix = crypto.randomUUID();
    try {
      const { general, post, list } = await fixture(db, suffix, level);
      await post(general.conversation.id, general.bobMember.id, "ordinary");
      await db.conversationMember.update({
        where: { id: general.aliceMember.id },
        data: { notificationLevel: "all" },
      });
      const items = (await list()).items.filter(isConversation);
      expect(items).toHaveLength(1);
      expect(items[0]?.unreadCount).toBe(1);
    } finally {
      await cleanup(db, suffix);
    }
  },
);
