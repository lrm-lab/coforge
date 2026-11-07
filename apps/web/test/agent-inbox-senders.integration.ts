import { expect, test } from "bun:test";
import { listAgentInbox } from "#src/server/agents/agent-inbox-list.server";
import { connection, workspaceWithAgent } from "./support/agent-inbox-fixture";

/**
 * System notices carry no sender member; like the human unread rule they never count, or a
 * channel's task housekeeping would read as unread for the Agent.
 */
test("system notices never count as unread, top-level or in a followed thread", async () => {
  const db = connection();
  const suffix = crypto.randomUUID();
  try {
    const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));
    const conversation = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "tasks" },
    });
    const human = await db.conversationMember.create({
      data: { conversationId: conversation.id, workspaceId: workspace.id, userId: owner.id },
    });
    const self = await db.conversationMember.create({
      data: {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        joinedAt: new Date(0),
      },
    });
    const post = (
      sequence: number,
      createdAt: Date,
      senderMemberId: string | null,
      threadRootId?: string,
    ) =>
      db.message.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          senderMemberId,
          body: `m${sequence}`,
          sequence,
          createdAt,
          threadRootId: threadRootId ?? null,
        },
      });
    await post(1, day(1), null);
    await post(2, day(2), self.id);
    const root = await post(3, day(3), human.id);
    await post(4, day(4), null, root.id);
    await post(5, day(5), human.id, root.id);
    await post(6, day(6), self.id, root.id);
    await db.threadFollow.create({
      data: {
        memberId: self.id,
        rootMessageId: root.id,
        conversationId: conversation.id,
        workspaceId: workspace.id,
      },
    });

    const listed = await listAgentInbox(db, workspace.id, agent.id);
    const reference = `#tasks:${root.id.slice(0, 13)}`;
    expect(listed.items.map((item) => [item.kind, item.target, item.unread])).toEqual([
      ["thread", reference, 1],
      ["channel", "#tasks", 1],
    ]);
    expect(listed.totals).toEqual({ conversations: 2, dms: 0, mentions: 0 });
  } finally {
    await db.$disconnect();
  }
});

/**
 * The other half of the rule: a person who writes to or @-mentions the Agent still counts, so
 * task assignment and mention delivery keep working — a muted channel surfaces for a mention.
 */
test("a human message and an @-mention still count as unread", async () => {
  const db = connection();
  const suffix = crypto.randomUUID();
  try {
    const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));
    const channel = async (name: string, muted = false) => {
      const conversation = await db.conversation.create({
        data: { workspaceId: workspace.id, channelName: name },
      });
      const human = await db.conversationMember.create({
        data: { conversationId: conversation.id, workspaceId: workspace.id, userId: owner.id },
      });
      const self = await db.conversationMember.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          joinedAt: new Date(0),
          channelMuted: muted,
          notificationLevel: muted ? "muted" : "all",
        },
      });
      return { conversation, human, self };
    };
    const loud = await channel("loud", true);
    const plain = await channel("plain");
    const post = async (
      c: Awaited<ReturnType<typeof channel>>,
      sequence: number,
      mention = false,
    ) => {
      const message = await db.message.create({
        data: {
          conversationId: c.conversation.id,
          workspaceId: workspace.id,
          senderMemberId: c.human.id,
          body: `m${sequence}`,
          sequence,
          createdAt: day(sequence),
        },
      });
      if (mention)
        await db.messageMention.create({
          data: {
            messageId: message.id,
            memberId: c.self.id,
            conversationId: c.conversation.id,
            workspaceId: workspace.id,
            kind: "agent",
            actorId: agent.id,
            handle: agent.name,
          },
        });
    };
    await post(loud, 2, true);
    await post(plain, 1);

    const listed = await listAgentInbox(db, workspace.id, agent.id);
    expect(listed.items.map((item) => [item.target, item.unread, item.mentions])).toEqual([
      ["#loud", 1, 1],
      ["#plain", 1, 0],
    ]);
    expect(listed.totals).toEqual({ conversations: 2, dms: 0, mentions: 1 });
  } finally {
    await db.$disconnect();
  }
});
