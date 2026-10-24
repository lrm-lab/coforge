import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

export function database() {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** An item's kind as the page shows it: a thread card, or its conversation's own kind. */
export function kindOf(item: ActivityInboxItem) {
  return item.thread ? "thread" : item.place.kind;
}

export async function seed(db: PrismaClient, suffix: string) {
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({ data: { username: `inbox-${name}-${suffix}`, displayName: name } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: { slug: `inbox-${suffix}`, name: "Inbox" },
  });
  await db.workspaceMembership.createMany({
    data: [alice!, bob!].map((user) => ({ workspaceId: workspace.id, userId: user.id })),
  });
  const sequences = new Map<string, number>();
  async function channel(name: string, options: { archived?: boolean } = {}) {
    const conversation = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `${name}-${suffix.slice(0, 8)}`,
        ...(options.archived ? { archivedAt: new Date() } : {}),
      },
    });
    const [aliceMember, bobMember] = await Promise.all(
      [alice!, bob!].map((user) =>
        db.conversationMember.create({
          data: { conversationId: conversation.id, workspaceId: workspace.id, userId: user.id },
        }),
      ),
    );
    return { conversation, aliceMember: aliceMember!, bobMember: bobMember! };
  }
  let clock = Date.UTC(2026, 0, 1, 8, 0, 0);
  async function post(
    conversationId: string,
    senderMemberId: string | null,
    body: string,
    options: { threadRootId?: string; mentionMemberIds?: string[] } = {},
  ) {
    const sequence = (sequences.get(conversationId) ?? 0) + 1;
    sequences.set(conversationId, sequence);
    clock += 60_000;
    const message = await db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId,
        body,
        sequence,
        createdAt: new Date(clock),
        threadRootId: options.threadRootId ?? null,
      },
    });
    for (const memberId of options.mentionMemberIds ?? [])
      await db.messageMention.create({
        data: {
          messageId: message.id,
          memberId,
          conversationId,
          workspaceId: workspace.id,
          kind: "user",
          actorId: alice!.id,
          handle: alice!.username,
        },
      });
    return message;
  }
  /** Pins the member's conversation in their sidebar, at `sortOrder` among their pins. */
  function pin(member: { id: string; conversationId: string }, sortOrder: number) {
    return db.conversationPin.create({
      data: {
        conversationId: member.conversationId,
        memberId: member.id,
        workspaceId: workspace.id,
        sortOrder,
      },
    });
  }
  return { alice: alice!, bob: bob!, workspace, channel, post, pin, sequences };
}

export async function cleanup(db: PrismaClient, suffix: string) {
  await db.workspace.deleteMany({ where: { slug: `inbox-${suffix}` } });
  await db.user.deleteMany({ where: { username: { startsWith: "inbox-", endsWith: suffix } } });
  await db.$disconnect();
}
