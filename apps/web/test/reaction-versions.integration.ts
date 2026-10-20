import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { MessageReactionEvent } from "#src/features/conversations/conversation-realtime";
import { readMessageReactions } from "#src/server/conversations/message-reaction-reads.server";
import { toggleUserMessageReaction } from "#src/server/conversations/user-message-reactions.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

// Every reaction write, a person's or an Agent's, raises its message's `reactionVersion` in its
// own transaction, and the repair read returns the summary with the version it was read at.

test("each reaction write raises the message's version, and a read returns it with the summary", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const user = await db.user.create({
    data: { username: `reaction-version-${id.slice(0, 8)}`, displayName: "Ada Lovelace" },
  });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Reaction versions", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const published: Omit<MessageReactionEvent, "type">[] = [];
    const realtime = {
      reactionChanged: async (event: Omit<MessageReactionEvent, "type">) => {
        published.push(event);
      },
    };
    const repo = new PrismaDirectConversationRepository(db, {}, realtime);
    const { conversationId, senderMemberId } = await repo.memberForUser(
      workspace.id,
      user.id,
      agent.id,
    );
    const root = await repo.sendMessage(conversationId, senderMemberId, user.id, "release plan");
    const react = (emoji: string, active: boolean) =>
      toggleUserMessageReaction(db, realtime, {
        workspaceId: workspace.id,
        conversationId,
        userId: user.id,
        messageId: root.id,
        emoji,
        active,
      });
    const ada = { id: user.id, label: "Ada Lovelace" };

    expect(await react("👍", true)).toEqual({
      reactions: [{ emoji: "👍", count: 1, reactors: [ada] }],
      version: 1,
    });
    await repo.setAgentMessageReaction(workspace.id, agent.id, root.id, "👍", true);
    expect(await react("👍", false)).toEqual({
      reactions: [{ emoji: "👍", count: 1, reactors: [{ id: agent.id, label: "@helper" }] }],
      version: 3,
    });
    // The Agent's write is announced too.
    expect(published.map((event) => event.version)).toEqual([1, 2, 3]);

    expect(
      await readMessageReactions(db, {
        workspaceId: workspace.id,
        userId: user.id,
        conversationId,
        messageIds: [root.id, crypto.randomUUID()],
      }),
    ).toEqual({
      [root.id]: {
        reactions: [{ emoji: "👍", count: 1, reactors: [{ id: agent.id, label: "@helper" }] }],
        version: 3,
      },
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
