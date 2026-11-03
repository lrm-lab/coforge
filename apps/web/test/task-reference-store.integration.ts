import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { storeMessageBody } from "#src/server/conversations/message-references.server";

test("cross-conversation task references are stored only where the sender may read them", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { username: `alice-${suffix}`, displayName: "Alice" },
  });
  const bob = await db.user.create({
    data: { username: `bob-${suffix}`, displayName: "Bob" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Task references",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const general = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: "general",
        members: { create: [{ userId: alice.id }, { userId: bob.id }] },
      },
      include: { members: true },
    });
    const secret = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: "secret",
        visibility: "private",
        members: { create: [{ userId: bob.id }] },
      },
      include: { members: true },
    });
    const dm = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: `user:${alice.id}|user:${bob.id}`,
        members: { create: [{ userId: alice.id }, { userId: bob.id }] },
      },
      include: { members: true },
    });
    const member = (conversationId: string, userId: string) =>
      (conversationId === general.id
        ? general
        : conversationId === secret.id
          ? secret
          : dm
      ).members.find((row) => row.userId === userId)!.id;
    const task = (conversationId: string, number: number, ownerUserId = alice.id) =>
      db.task.create({
        data: {
          conversationId,
          workspaceId: workspace.id,
          number,
          title: `Task ${number}`,
          status: "todo",
          creatorMemberId: member(conversationId, ownerUserId),
          ownerMemberId: member(conversationId, ownerUserId),
        },
      });
    await task(general.id, 7);
    // The channel the sender cannot read has no task of the number, so it stays text.
    await task(dm.id, 9);
    const body = `see #general:#7, #secret:#8 and dm:@${bob.username}:#9`;
    const scope = {
      workspaceId: workspace.id,
      conversationId: general.id,
      reader: { userId: alice.id },
    };
    const stored = await db.$transaction((tx) =>
      storeMessageBody(tx, scope, body, { targets: [] }, { crossTaskReferences: true }),
    );
    expect(stored.body).toContain("<@task:c:" + general.id + ":general:7>");
    expect(stored.body).toContain(`<@task:d:${dm.id}:${bob.username}:9>`);
    expect(stored.body).toContain("#secret:#8");
    const off = await db.$transaction((tx) =>
      storeMessageBody(tx, scope, body, { targets: [] }, { crossTaskReferences: false }),
    );
    expect(off.body).toBe(body);
    // With the switch off no cross-conversation token is written, and the whole reference is
    // left as typed — its `#N` is not re-read as this conversation's task.
    expect(off.body).not.toContain("<@task:");
    const local = await db.$transaction((tx) =>
      storeMessageBody(
        tx,
        scope,
        "see #7 and task #7",
        { targets: [] },
        { crossTaskReferences: false },
      ),
    );
    expect(local.body).toBe("see <@task:7> and <@task:7>");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
