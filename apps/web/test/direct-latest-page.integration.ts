import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { enrollGeneralChannel } from "#src/server/conversations/general-channel.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/** A read with no anchor and no `--unread` shows the newest page of the target and leaves the
 * Agent's read position where it was; only `--unread` moves it. */

async function withWorkspace(
  run: (context: {
    db: PrismaClient;
    repo: PrismaDirectConversationRepository;
    workspaceId: string;
    userId: string;
    username: string;
    agentId: string;
  }) => Promise<void>,
) {
  const connectionString = Bun.env.THREAD_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("THREAD_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `l${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { displayName: username, username } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Latest page", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "latest",
        displayName: "Latest",
        runtimeConfig: {},
      },
    });
    await run({
      db,
      repo: new PrismaDirectConversationRepository(db),
      workspaceId: workspace.id,
      userId: user.id,
      username,
      agentId: agent.id,
    });
  } finally {
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}

const sequences = (page: { messages: { sequence: number }[] }) =>
  page.messages.map((message) => message.sequence);

test("a plain direct-message read shows the newest page, says what is older, and does not move the read position", async () => {
  await withWorkspace(async ({ repo, workspaceId, userId, username, agentId }) => {
    const opened = await repo.openForUser(workspaceId, userId, agentId);
    const dm = `@${username}`;
    const sent = [];
    for (const body of ["one", "two", "three", "four", "five"])
      sent.push(await repo.sendMessage(opened.conversationId, opened.senderMemberId, userId, body));
    const seq = sent.map((message) => message.sequence);

    const plain = await repo.readMessagesPage(workspaceId, agentId, dm, { limit: 3 });
    expect(sequences(plain)).toEqual(seq.slice(2));
    expect(plain.hasOlder).toBe(true);
    expect(plain.hasNewer).toBe(false);
    expect(plain.modelSeenUpToSeq).toBeNull();
    expect(plain.readPositionAfter).toBeUndefined();

    // The position did not move: the unread read still starts at the first message.
    const unread = await repo.readMessagesPage(workspaceId, agentId, dm, {
      unread: true,
      limit: 2,
    });
    expect(sequences(unread)).toEqual(seq.slice(0, 2));
    expect(unread.unreadCursorBefore).toBe(0);

    // Everything read: the plain read is still the newest page, never an empty one.
    await repo.readMessagesPage(workspaceId, agentId, dm, { unread: true });
    const again = await repo.readMessagesPage(workspaceId, agentId, dm, { limit: 3 });
    expect(sequences(again)).toEqual(seq.slice(2));
    expect(again.hasOlder).toBe(true);
    // An explicit range, even from 0, is not the newest page.
    const ranged = await repo.readMessagesPage(workspaceId, agentId, dm, {
      fromSequence: 0,
      limit: 2,
    });
    expect(sequences(ranged)).toEqual(seq.slice(0, 2));
    const whole = await repo.readMessagesPage(workspaceId, agentId, dm, {});
    expect(sequences(whole)).toEqual(seq);
    expect(whole.hasOlder).toBe(false);
  });
});

test("a plain channel and thread read show the newest page of their own messages", async () => {
  await withWorkspace(async ({ db, repo, workspaceId, agentId }) => {
    await enrollGeneralChannel(db, workspaceId);
    const general = await db.conversation.findFirstOrThrow({
      where: { workspaceId, channelName: "general" },
    });
    const post = (body: string, thread?: string) =>
      repo.sendAgentMessage(general.id, agentId, body, [], thread);
    const root = await post("root");
    const first = await post("first reply", root.id);
    const top = await post("top level");
    const second = await post("second reply", root.id);
    const third = await post("third reply", root.id);
    const read = (target: string, limit: number) =>
      repo.readMessagesPage(workspaceId, agentId, target, { limit });

    // The Agent's own messages sit under its read position, as in a thread it has been writing in:
    // the newest page is still there.
    const thread = await read(`#general:${root.id}`, 2);
    expect(sequences(thread)).toEqual([second.sequence, third.sequence]);
    expect(thread.hasOlder).toBe(true);
    expect(thread.hasNewer).toBe(false);
    expect(sequences(await read(`#general:${root.id}`, 10))).toEqual([
      first.sequence,
      second.sequence,
      third.sequence,
    ]);
    expect((await read(`#general:${root.id}`, 10)).hasOlder).toBe(false);

    // The top level leaves the replies out.
    const channel = await read("#general", 10);
    expect(sequences(channel)).toEqual([root.sequence, top.sequence]);
    expect(channel.hasOlder).toBe(false);
    expect((await read("#general", 1)).hasOlder).toBe(true);
  });
});
