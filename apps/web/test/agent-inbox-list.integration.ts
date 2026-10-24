import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { listAgentInbox } from "#src/server/agents/agent-inbox-list.server";

const connection = () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
};

async function workspaceWithAgent(db: PrismaClient, suffix: string) {
  const owner = await db.user.create({
    data: { username: `inb-${suffix}`, displayName: "Owner" },
  });
  const workspace = await db.workspace.create({
    data: { slug: `inb-${suffix}`, name: "Inbox" },
  });
  await db.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: "owner" },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      name: `inb-${suffix.slice(0, 8)}`,
      displayName: "Inbox",
      runtimeConfig: {},
    },
  });
  return { owner, workspace, agent };
}

/**
 * What counts as unread: other people's top-level messages after the Agent's read position, in
 * conversations the Agent is still in, with muted channels listed only for a mention.
 */
test("lists unread conversations by the definition in the code, newest activity first", async () => {
  const db = connection();
  const suffix = crypto.randomUUID();
  try {
    const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));
    const make = async (
      name: string | null,
      options: {
        read?: number;
        muted?: boolean;
        archived?: boolean;
        left?: boolean;
        kind?: string;
      } = {},
    ) => {
      const conversation = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: name,
          kind: options.kind ?? null,
          directKey: name === null ? `dm-${crypto.randomUUID()}` : null,
          archivedAt: options.archived ? new Date() : null,
        },
      });
      const human = await db.conversationMember.create({
        data: { conversationId: conversation.id, workspaceId: workspace.id, userId: owner.id },
      });
      const self = await db.conversationMember.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          agentReadThroughSequence: options.read ?? 0,
          joinedAt: new Date(0),
          channelMuted: options.muted ?? false,
          leftAt: options.left ? new Date() : null,
        },
      });
      return { conversation, human, self };
    };
    const post = async (
      c: Awaited<ReturnType<typeof make>>,
      sequence: number,
      createdAt: Date,
      extra: { own?: boolean; thread?: string; mention?: boolean } = {},
    ) => {
      const message = await db.message.create({
        data: {
          conversationId: c.conversation.id,
          workspaceId: workspace.id,
          senderMemberId: extra.own ? c.self.id : c.human.id,
          body: `m${sequence}`,
          sequence,
          createdAt,
          threadRootId: extra.thread ?? null,
        },
      });
      if (extra.mention)
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
      return message;
    };

    const general = await make("general", { read: 1 });
    await post(general, 1, day(1));
    await post(general, 2, day(5));
    await post(general, 3, day(6), { mention: true });
    const dm = await make(null);
    await post(dm, 1, day(7));
    const ops = await make("ops");
    await post(ops, 1, day(2), { own: true });
    await post(ops, 2, day(3), { thread: (await post(ops, 3, day(2))).id });
    const mutedQuiet = await make("quiet", { muted: true });
    await post(mutedQuiet, 1, day(8));
    const mutedMention = await make("loud", { muted: true });
    await post(mutedMention, 1, day(4), { mention: true });
    const archived = await make("old", { archived: true });
    await post(archived, 1, day(9));
    const left = await make("gone", { left: true });
    await post(left, 1, day(9));
    const appEvents = await make("apps", { kind: "app_events" });
    await post(appEvents, 1, day(9));
    const caughtUp = await make("done", { read: 1 });
    await post(caughtUp, 1, day(9));

    const peer = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    const all = await listAgentInbox(db, workspace.id, agent.id);
    expect(all.items.map((item) => item.target)).toEqual([
      `@${peer.username}`,
      "#general",
      "#loud",
      "#ops",
    ]);
    expect(all.items[1]).toEqual({
      target: "#general",
      unread: 2,
      mentions: 1,
      latestAt: day(6).toISOString(),
      latestSenderName: peer.username,
      lastReadSeq: 1,
    });
    expect(all.items[3]).toMatchObject({ target: "#ops", unread: 1, mentions: 0 });
    expect(all.totals).toEqual({ conversations: 4, dms: 1, mentions: 2 });
    expect(all.hasMore).toBe(false);
    expect(all.nextBefore).toBeNull();

    const mentions = await listAgentInbox(db, workspace.id, agent.id, { view: "mentions" });
    expect(mentions.items.map((item) => item.target)).toEqual(["#general", "#loud"]);
    expect(mentions.totals).toEqual(all.totals);

    // Pages of two: the second starts after the first page's last activity time.
    const first = await listAgentInbox(db, workspace.id, agent.id, {}, 2);
    expect(first.items.map((item) => item.target)).toEqual([`@${peer.username}`, "#general"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(day(6).getTime());
    const second = await listAgentInbox(
      db,
      workspace.id,
      agent.id,
      { before: first.nextBefore! },
      2,
    );
    expect(second.items.map((item) => item.target)).toEqual(["#loud", "#ops"]);
    expect(second.hasMore).toBe(false);
    expect(second.totals).toEqual(all.totals);
  } finally {
    await db.$disconnect();
  }
});

test("a page that ends inside a run of equal activity times is extended to the end of the run", async () => {
  const db = connection();
  const suffix = crypto.randomUUID();
  try {
    const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
    const same = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));
    const earlier = new Date(Date.UTC(2026, 9, 1, 11, 0, 0));
    for (const [index, at] of [same, same, same, earlier].entries()) {
      const conversation = await db.conversation.create({
        data: { workspaceId: workspace.id, channelName: `tie-${index}` },
      });
      const human = await db.conversationMember.create({
        data: { conversationId: conversation.id, workspaceId: workspace.id, userId: owner.id },
      });
      await db.conversationMember.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          joinedAt: new Date(0),
        },
      });
      await db.message.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          senderMemberId: human.id,
          body: "hi",
          sequence: 1,
          createdAt: at,
        },
      });
    }
    const first = await listAgentInbox(db, workspace.id, agent.id, {}, 2);
    expect(first.items).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = await listAgentInbox(
      db,
      workspace.id,
      agent.id,
      { before: first.nextBefore! },
      2,
    );
    expect(second.items.map((item) => item.target)).toEqual(["#tie-3"]);
    expect(second.hasMore).toBe(false);
  } finally {
    await db.$disconnect();
  }
});

test("hundreds of conversations and hundreds of thousands of messages answer in one statement", async () => {
  const db = connection();
  const suffix = crypto.randomUUID();
  const conversationCount = 400;
  const messagesPerConversation = 500;
  try {
    const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
    const conversations = await db.conversation.createManyAndReturn({
      data: Array.from({ length: conversationCount }, (_, index) => ({
        workspaceId: workspace.id,
        channelName: `bulk-${String(index).padStart(3, "0")}`,
      })),
    });
    const humans = await db.conversationMember.createManyAndReturn({
      data: conversations.map((conversation) => ({
        conversationId: conversation.id,
        workspaceId: workspace.id,
        userId: owner.id,
      })),
    });
    await db.conversationMember.createMany({
      data: conversations.map((conversation, index) => ({
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        joinedAt: new Date(0),
        // Half the conversations are read up to the middle, a quarter fully.
        agentReadThroughSequence:
          index % 4 === 0 ? messagesPerConversation : index % 2 === 0 ? 250 : 0,
      })),
    });
    const humanOf = new Map(humans.map((member) => [member.conversationId, member.id]));
    const base = Date.UTC(2026, 9, 1);
    for (let start = 0; start < conversations.length; start += 20) {
      await db.message.createMany({
        data: conversations.slice(start, start + 20).flatMap((conversation, offset) =>
          Array.from({ length: messagesPerConversation }, (_, index) => ({
            conversationId: conversation.id,
            workspaceId: workspace.id,
            senderMemberId: humanOf.get(conversation.id)!,
            body: `m${index}`,
            sequence: index + 1,
            // Each conversation's latest message is a different second.
            createdAt: new Date(base + (start + offset) * 1000 + index),
          })),
        ),
      });
    }

    const started = performance.now();
    const inbox = await listAgentInbox(db, workspace.id, agent.id);
    const elapsedMs = performance.now() - started;
    console.log(
      `listAgentInbox: ${conversationCount} conversations, ${conversationCount * messagesPerConversation} messages in ${elapsedMs.toFixed(1)} ms`,
    );
    expect(inbox.totals.conversations).toBe(300);
    expect(inbox.items.length).toBeGreaterThanOrEqual(50);
    expect(inbox.hasMore).toBe(true);
  } finally {
    await db.$disconnect();
  }
}, 120_000);

test("a channel's history from before the Agent joined is not unread", async () => {
  const db = connection();
  const suffix = crypto.randomUUID();
  try {
    const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
    const conversation = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "backlog" },
    });
    const human = await db.conversationMember.create({
      data: { conversationId: conversation.id, workspaceId: workspace.id, userId: owner.id },
    });
    const joinedAt = new Date(Date.UTC(2026, 9, 10));
    await db.conversationMember.create({
      data: {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        joinedAt,
      },
    });
    for (const [sequence, day] of [
      [1, 5],
      [2, 9],
      [3, 11],
    ] as const)
      await db.message.create({
        data: {
          conversationId: conversation.id,
          workspaceId: workspace.id,
          senderMemberId: human.id,
          body: `m${sequence}`,
          sequence,
          createdAt: new Date(Date.UTC(2026, 9, day)),
        },
      });
    const listed = await listAgentInbox(db, workspace.id, agent.id, { view: "unread" }, 50);
    expect(listed.items.map((item) => [item.target, item.unread])).toEqual([["#backlog", 1]]);
  } finally {
    await db.$disconnect();
  }
});
