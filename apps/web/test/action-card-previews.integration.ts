import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "#src/generated/prisma/client";
import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { channelListPreviews } from "#src/server/conversations/channel-list-preview.server";
import { announceMessage } from "#src/server/conversations/conversation-activity.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { searchMessages } from "#src/server/conversations/message-search.server";
import { listUserSavedMessages } from "#src/server/conversations/saved-messages.server";
import { readWindowThreads } from "#src/server/conversations/thread-summaries.server";
import { PrismaDirectConversationPreferences } from "#src/server/db/repositories/direct-conversation-preferences.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";

/**
 * Every list that shows a message's text without its card carries what an action card's line is
 * written from (`card`), so the browser writes it in the viewer's language: the Chat sidebar's
 * channel and DM rows and their live update, Activity, Saved, search and a thread's reply preview
 * (task #443).
 */
test("an action card's lists carry what its line is written from", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: { displayName: `acp-alice-${suffix}`, username: `acp-alice-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `acp-${suffix}`,
      name: "Card previews",
      members: { create: [{ userId: alice.id, role: "owner" }] },
      agents: {
        create: [
          { name: `scout-${suffix}`, displayName: "Scout", ownerId: alice.id, runtimeConfig: {} },
        ],
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  try {
    const hub = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `hub-${suffix}`,
        members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
      },
      include: { members: true },
    });
    const aliceInHub = hub.members.find((member) => member.userId === alice.id)!;
    const agentInHub = hub.members.find((member) => member.agentId === agent.id)!;
    const announced: ConversationActivityEvent[] = [];
    const realtime = {
      async messageAvailable() {},
      async conversationActivity({ event }: { event: ConversationActivityEvent }) {
        announced.push(event);
      },
    };
    const actionCards = new ActionCards(db, new PrismaDirectConversationRepository(db), {
      async memberChanged() {},
      async messageAvailable() {},
    });

    // A message posted straight to the table, as the next in its conversation.
    async function post(
      conversationId: string,
      senderMemberId: string,
      body: string,
      card?: { kind: string; payload: Prisma.InputJsonValue },
      threadRootId?: string,
    ) {
      const { lastSequence } = await db.conversation.update({
        where: { id: conversationId },
        data: { lastSequence: { increment: 1 } },
        select: { lastSequence: true },
      });
      return db.message.create({
        data: {
          conversationId,
          workspaceId: workspace.id,
          senderMemberId,
          body,
          sequence: lastSequence,
          threadRootId,
          ...(card
            ? {
                actionCard: {
                  create: {
                    workspaceId: workspace.id,
                    kind: card.kind,
                    payload: card.payload,
                    preparedByAgentId: agent.id,
                  },
                },
              }
            : {}),
        },
      });
    }

    // The channel's last message is a card the Agent prepared, with a note.
    const prepared = await actionCards.prepare(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        target: `#${hub.channelName}`,
        action: { type: "channel:create", name: `launch-${suffix}`, draftHint: "For the launch" },
      },
    );
    const channelCard = {
      kind: "channel:create",
      params: { name: `launch-${suffix}` },
      hint: "For the launch",
    };
    const channelRow = (await channelListPreviews(db, workspace.id, [hub.id], alice.id)).get(
      hub.id,
    );
    expect(channelRow?.lastMessage?.card).toEqual(channelCard);
    const stored = await db.message.findUniqueOrThrow({ where: { id: prepared.messageId } });
    await announceMessage(db, realtime, {
      conversationId: hub.id,
      messageId: stored.id,
      sequence: stored.sequence,
      workspaceId: workspace.id,
    });
    expect(announced.at(-1)?.card).toEqual(channelCard);

    // Saved and search.
    await db.savedMessage.create({
      data: {
        workspaceId: workspace.id,
        conversationId: hub.id,
        messageId: stored.id,
        memberId: aliceInHub.id,
      },
    });
    const [saved] = await listUserSavedMessages(db, {
      workspaceId: workspace.id,
      userId: alice.id,
    });
    expect(saved?.message.card).toEqual(channelCard);
    // Matching stays on the stored English body.
    const found = await searchMessages(db, {
      workspaceId: workspace.id,
      userId: alice.id,
      query: `launch-${suffix}`,
      sort: "recent",
      limit: 10,
      offset: 0,
    });
    expect(found.results.map((hit) => hit.message.card)).toEqual([channelCard]);

    // A thread whose newest reply is a card, and a plain message beside it that carries none.
    const root = await post(hub.id, aliceInHub.id, "Who should join?");
    const addCard = {
      kind: "channel:add_member",
      payload: {
        type: "channel:add_member",
        channelId: hub.id,
        humanIds: [alice.id],
        channelHandle: `hub-${suffix}`,
        memberHandles: [`@${alice.username}`],
      },
    };
    await post(hub.id, agentInHub.id, "Action card: add …", addCard, root.id);
    const { threads } = await readWindowThreads(db, {
      workspaceId: workspace.id,
      conversationId: hub.id,
      rootIds: [root.id],
    });
    expect(threads[root.id]?.latestReplies.at(-1)?.card).toEqual({
      kind: "channel:add_member",
      params: { channel: `hub-${suffix}`, members: [`@${alice.username}`] },
    });
    expect(
      (await channelListPreviews(db, workspace.id, [hub.id], alice.id)).get(hub.id)?.lastMessage,
    ).not.toHaveProperty("card");

    // The DM's row and its Activity item.
    const { conversationId: dmId } = await new DirectConversations(db).open(
      workspace.id,
      alice.id,
      {
        agentId: agent.id,
      },
    );
    const agentInDm = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: dmId, agentId: agent.id },
    });
    await post(dmId, agentInDm.id, "Action card: create agent helper", {
      kind: "agent:create",
      payload: { type: "agent:create", name: `helper-${suffix}` },
    });
    const dmCard = { kind: "agent:create", params: { name: `helper-${suffix}` } };
    const { conversations } = await new PrismaDirectConversationPreferences(db).preferencesForUser(
      workspace.id,
      alice.id,
    );
    expect(conversations.find((row) => row.conversationId === dmId)?.lastMessage?.card).toEqual(
      dmCard,
    );
    const activity = await new ActivityInbox(db, {}).list(workspace.id, alice.id, {
      filter: "all",
    });
    expect(activity.items.find((item) => item.place.conversationId === dmId)?.latest.card).toEqual(
      dmCard,
    );
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: alice.id } });
    await db.$disconnect();
  }
});
