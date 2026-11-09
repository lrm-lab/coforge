import { expect, test } from "bun:test";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { cleanup, database, seed } from "./helpers/activity-inbox-fixture";

/**
 * A muted channel reaches Activity only through what involves the viewer: a mention of them or a
 * thread they follow (task #41, the rule Frank confirmed against Raft's). Against PostgreSQL.
 */

async function fixture(db: ReturnType<typeof database>, suffix: string) {
  const seeded = await seed(db, suffix);
  const general = await seeded.channel("general");
  await db.conversationMember.update({
    where: { id: general.aliceMember.id },
    data: { notificationLevel: "muted" },
  });
  const inbox = new ActivityInbox(db, {});
  const list = () => inbox.list(seeded.workspace.id, seeded.alice.id, { filter: "all" });
  return { ...seeded, general, list };
}

test("a muted channel's ordinary messages are not in Activity", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { general, post, list } = await fixture(db, suffix);
    await post(general.conversation.id, general.bobMember.id, "ordinary");
    expect((await list()).items).toEqual([]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("a mention lists a muted channel, counting and anchored on the mention only", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { general, post, list } = await fixture(db, suffix);
    const id = general.conversation.id;
    await post(id, general.bobMember.id, "before");
    const mention = await post(id, general.bobMember.id, "hey", {
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(id, general.bobMember.id, "after");

    const [item] = (await list()).items;
    expect(item?.unreadCount).toBe(1);
    expect(item?.firstUnreadMessageId).toBe(mention.id);
    expect(item?.latest.id).toBe(mention.id);
  } finally {
    await cleanup(db, suffix);
  }
});

test("a followed thread in a muted channel stays in Activity", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { general, post, list, workspace } = await fixture(db, suffix);
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

    const items = (await list()).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.thread).toBeTruthy();
  } finally {
    await cleanup(db, suffix);
  }
});

test("unmuting brings a channel's messages back", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { general, post, list } = await fixture(db, suffix);
    await post(general.conversation.id, general.bobMember.id, "ordinary");
    await db.conversationMember.update({
      where: { id: general.aliceMember.id },
      data: { notificationLevel: "all" },
    });
    const items = (await list()).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.unreadCount).toBe(1);
  } finally {
    await cleanup(db, suffix);
  }
});
