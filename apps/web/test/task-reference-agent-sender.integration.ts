import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { storeMessageBody } from "#src/server/conversations/message-references.server";

test("an Agent sender resolves cross-conversation task references only where it may read", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { username: `alice-${suffix}`, displayName: "Alice" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `agentref-${suffix}`,
      name: "Agent references",
      members: { create: [{ userId: alice.id }] },
    },
  });
  try {
    const [sender, peer] = await Promise.all(
      ["sender", "peer"].map((name) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId: alice.id,
            name: `${name}-${suffix}`,
            displayName: name,
            runtimeConfig: {},
          },
        }),
      ),
    );
    const general = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: "general",
        members: {
          create: [{ userId: alice.id }, { agentId: sender!.id }, { agentId: peer!.id }],
        },
      },
      include: { members: true },
    });
    const secret = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: "qa514-priv",
        visibility: "private",
        members: { create: [{ userId: alice.id }] },
      },
      include: { members: true },
    });
    // A DM between alice and the peer Agent: the sender is not in it.
    const dm = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: `user:${alice.id}|agent:${peer!.id}`,
        members: { create: [{ userId: alice.id }, { agentId: peer!.id }] },
      },
      include: { members: true },
    });
    const seatOf = (conversation: typeof general | typeof secret | typeof dm, pick: object) =>
      conversation.members.find((row) =>
        Object.entries(pick).every(([key, value]) => row[key as "userId" | "agentId"] === value),
      )!;
    const task = (
      conversation: typeof general | typeof secret | typeof dm,
      number: number,
      pick: { userId?: string; agentId?: string },
    ) => {
      const seat = seatOf(conversation, pick);
      return db.task.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          number,
          title: `Task ${number}`,
          status: "todo",
          creatorMemberId: seat.id,
          ownerMemberId: seat.id,
        },
      });
    };
    await task(general, 3, { agentId: sender!.id });
    await task(secret, 1, { userId: alice.id });
    await task(dm, 1, { userId: alice.id });
    const scope = {
      workspaceId: workspace.id,
      conversationId: general.id,
      reader: { agentId: sender!.id } as const,
    };
    const body = `#qa514-priv:#1, dm:@${peer!.name}:#1 and #general:#3`;
    const stored = await db.$transaction((tx) =>
      storeMessageBody(tx, scope, body, { targets: [] }, { crossTaskReferences: true }),
    );
    // The private channel and the DM the sender is not in stay plain text; the channel it can
    // read resolves.
    expect(stored.body).toBe(
      `#qa514-priv:#1, dm:@${peer!.name}:#1 and <@task:c:${general.id}:general:3>`,
    );
    // Control: a reader who may read the private channel resolves the same reference.
    const allowed = await db.$transaction((tx) =>
      storeMessageBody(
        tx,
        { workspaceId: workspace.id, conversationId: secret.id, reader: { userId: alice.id } },
        "#qa514-priv:#1",
        { targets: [] },
        { crossTaskReferences: true },
      ),
    );
    expect(allowed.body).toContain("<@task:c:");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: alice.id } });
    await db.$disconnect();
  }
});
