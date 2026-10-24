import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

test("a history read anchored by sequence number reads what the unread read's re-read hint names", async () => {
  const connectionString = Bun.env.THREAD_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("THREAD_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `s${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { displayName: username, username } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Sequence anchor test", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "anchor",
        displayName: "Anchor",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const opened = await repo.openForUser(workspace.id, user.id, agent.id);
    const dm = `@${username}`;
    const fromUser = (body: string) =>
      repo.sendMessage(opened.conversationId, opened.senderMemberId, user.id, body);
    const read = (page: Parameters<typeof repo.readMessagesPage>[3]) =>
      repo.readMessagesPage(workspace.id, agent.id, dm, page);
    const sequences = (page: { messages: { sequence: number }[] }) =>
      page.messages.map((message) => message.sequence);
    const one = await fromUser("one");
    const two = await fromUser("two");
    const three = await fromUser("three");

    // The hint an unread read prints is `--after <the position it started from>`; running it
    // reads the same messages again.
    const unread = await read({ unread: true });
    expect(sequences(unread)).toEqual([one.sequence, two.sequence, three.sequence]);
    const again = await read({ after: String(unread.unreadCursorBefore) });
    expect(sequences(again)).toEqual(sequences(unread));

    // A plain read says where the position stood before it; an anchored one says nothing of it.
    expect((await read({ after: "0" })).unreadCursorBefore).toBeUndefined();
    expect((await read({})).unreadCursorBefore).toBe(three.sequence);

    // Sequence zero is the start of the conversation; there is nothing older.
    const fromStart = await read({ after: "0", limit: 2 });
    expect(sequences(fromStart)).toEqual([one.sequence, two.sequence]);
    expect(fromStart.hasOlder).toBe(false);
    expect(fromStart.hasNewer).toBe(true);

    const afterOne = await read({ after: String(one.sequence) });
    expect(sequences(afterOne)).toEqual([two.sequence, three.sequence]);
    expect(afterOne.hasOlder).toBe(true);

    const beforeThree = await read({ before: String(three.sequence) });
    expect(sequences(beforeThree)).toEqual([one.sequence, two.sequence]);
    expect(beforeThree.hasNewer).toBe(true);
    expect((await read({ before: String(three.sequence + 1) })).hasNewer).toBe(false);

    expect(sequences(await read({ around: String(two.sequence), limit: 3 }))).toEqual([
      one.sequence,
      two.sequence,
      three.sequence,
    ]);
    // Past anything that exists there is nothing newer, however large the number.
    expect((await read({ after: "99999999999999999999" })).messages).toEqual([]);
    // The short Message id the CLI prints (eight hex, a dash, four more) still addresses the Message.
    expect(sequences(await read({ after: two.id.slice(0, 13) }))).toEqual([three.sequence]);
  } finally {
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("a sequence anchor in a channel thread reads and measures only that thread", async () => {
  const connectionString = Bun.env.THREAD_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("THREAD_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `c${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { displayName: username, username } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Channel thread anchor", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "threader",
        displayName: "Threader",
        runtimeConfig: {},
      },
    });
    await enrollGeneralChannel(db, workspace.id);
    const general = await db.conversation.findFirstOrThrow({
      where: { workspaceId: workspace.id, channelName: "general" },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const post = (body: string, thread?: string) =>
      repo.sendAgentMessage(general.id, agent.id, body, [], thread);
    // The sequence is shared by the whole channel, so a thread's own messages skip numbers.
    const root = await post("root");
    const between = await post("between");
    const first = await post("first reply", root.id);
    const elsewhere = await post("elsewhere");
    const second = await post("second reply", root.id);
    const read = (target: string, page: Parameters<typeof repo.readMessagesPage>[3]) =>
      repo.readMessagesPage(workspace.id, agent.id, target, page);
    const sequences = (page: { messages: { sequence: number }[] }) =>
      page.messages.map((message) => message.sequence);
    const thread = `#general:${root.id}`;

    const afterBetween = await read(thread, { after: String(between.sequence) });
    expect(sequences(afterBetween)).toEqual([first.sequence, second.sequence]);
    // Older is measured in the thread: the channel's messages below the anchor are not its own.
    expect(afterBetween.hasOlder).toBe(false);
    expect((await read(thread, { after: String(root.sequence) })).hasOlder).toBe(false);
    expect((await read(thread, { after: String(first.sequence) })).hasOlder).toBe(true);

    const beforeSecond = await read(thread, { before: String(second.sequence) });
    expect(sequences(beforeSecond)).toEqual([first.sequence]);
    expect(beforeSecond.hasNewer).toBe(true);
    // The channel's own later message is not this thread's newer message.
    expect((await read(thread, { before: String(second.sequence + 1) })).hasNewer).toBe(false);
    expect((await read(thread, { before: String(second.sequence + 1) })).hasOlder).toBe(false);

    // The top level of the channel leaves the thread's replies out.
    expect(sequences(await read("#general", { after: String(root.sequence) }))).toEqual([
      between.sequence,
      elsewhere.sequence,
    ]);
  } finally {
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
