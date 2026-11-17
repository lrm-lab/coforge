import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { listAgentInbox } from "#src/server/agents/agent-inbox-list.server";
import { connection, workspaceWithAgent } from "./support/agent-inbox-fixture";
import { seedScaleInbox } from "./support/agent-inbox-scale-seed";
import { createMigratedScratchDatabase, type ScratchDatabase } from "./support/scratch-database";

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
          notificationLevel: options.muted ? "muted" : "all",
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
      kind: "channel",
      target: "#general",
      unread: 2,
      mentions: 1,
      latestAt: day(6).toISOString(),
      latestSenderName: peer.username,
      lastReadSeq: 1,
    });
    expect(all.items[0]!.kind).toBe("dm");
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

describe("an inbox at scale, on a database of its own whose statistics are refreshed after the bulk load", () => {
  let scratch: ScratchDatabase | undefined;
  let db: PrismaClient;
  const statements: string[] = [];
  beforeAll(async () => {
    const base = Bun.env.CHANNEL_TEST_DATABASE_URL;
    if (!base) throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
    scratch = await createMigratedScratchDatabase(base, "inbox_scale");
    const logging = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
      log: [{ emit: "event", level: "query" }],
    });
    logging.$on("query", (event) => statements.push(event.query));
    db = logging;
  }, 120_000);
  afterAll(async () => {
    await db?.$disconnect();
    await scratch?.drop();
  });

  async function statementsFor(workspaceId: string, agentId: string) {
    statements.length = 0;
    const started = performance.now();
    const inbox = await listAgentInbox(db, workspaceId, agentId);
    return { inbox, elapsedMs: performance.now() - started, count: statements.length };
  }

  test("hundreds of conversations and hundreds of thousands of messages take as many statements as a few", async () => {
    const shape = { messagesPerConversation: 500, threadsPerConversation: 8, repliesPerThread: 3 };
    const large = await seedScaleInbox(db, { ...shape, conversations: 400 });
    const small = await seedScaleInbox(db, { ...shape, conversations: 16 });
    const few = await statementsFor(small.workspace.id, small.agent.id);
    const many = await statementsFor(large.workspace.id, large.agent.id);
    console.log(
      `listAgentInbox: 400 conversations, 200000 messages, ${large.followedThreads} followed threads in ${many.elapsedMs.toFixed(1)} ms, ${many.count} statements`,
    );
    expect(few.inbox.hasMore).toBe(true);
    expect(many.count).toBe(few.count);
    expect(many.count).toBeLessThanOrEqual(5);
    expect(many.inbox.totals.conversations).toBe(300 + large.followedThreads / 2);
    expect(many.inbox.items.length).toBeGreaterThanOrEqual(50);
    expect(many.inbox.hasMore).toBe(true);
  }, 120_000);
});

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

/**
 * A thread the Agent follows is listed on its own, from the thread's read position. A muted
 * channel does not hide it: a followed thread keeps delivering after the channel is muted, and only
 * leaving the channel ends that.
 */
test("followed threads with unread replies are listed as threads, muted channel or not", async () => {
  const db = connection();
  const suffix = crypto.randomUUID();
  try {
    const { owner, workspace, agent } = await workspaceWithAgent(db, suffix);
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));
    const channel = async (name: string, options: { muted?: boolean; left?: boolean } = {}) => {
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
          // The channel itself is read, so only the threads can be unread.
          agentReadThroughSequence: 100,
          channelMuted: options.muted ?? false,
          notificationLevel: options.muted ? "muted" : "all",
          leftAt: options.left ? new Date() : null,
        },
      });
      let sequence = 0;
      const post = (
        createdAt: Date,
        extra: { root?: string; own?: boolean; mention?: boolean } = {},
      ) =>
        db.message
          .create({
            data: {
              conversationId: conversation.id,
              workspaceId: workspace.id,
              senderMemberId: extra.own ? self.id : human.id,
              body: `m${sequence + 1}`,
              sequence: ++sequence,
              createdAt,
              threadRootId: extra.root ?? null,
            },
          })
          .then(async (message) => {
            if (extra.mention)
              await db.messageMention.create({
                data: {
                  messageId: message.id,
                  memberId: self.id,
                  conversationId: conversation.id,
                  workspaceId: workspace.id,
                  kind: "agent",
                  actorId: agent.id,
                  handle: agent.name,
                },
              });
            return message;
          });
      const follow = async (rootId: string, readThrough?: number) => {
        await db.threadFollow.create({
          data: {
            memberId: self.id,
            rootMessageId: rootId,
            conversationId: conversation.id,
            workspaceId: workspace.id,
          },
        });
        if (readThrough !== undefined)
          await db.threadRead.create({
            data: {
              memberId: self.id,
              rootMessageId: rootId,
              conversationId: conversation.id,
              workspaceId: workspace.id,
              readThroughSequence: readThrough,
            },
          });
      };
      return { conversation, post, follow };
    };

    const open = await channel("open");
    const openRoot = await open.post(day(1));
    await open.follow(openRoot.id);
    await open.post(day(3), { root: openRoot.id });
    await open.post(day(4), { root: openRoot.id, mention: true });
    await open.post(day(5), { root: openRoot.id, own: true });

    const readRoot = await open.post(day(2));
    await open.follow(readRoot.id, 100);
    await open.post(day(6), { root: readRoot.id });

    const muted = await channel("quiet", { muted: true });
    const mutedRoot = await muted.post(day(1));
    await muted.follow(mutedRoot.id);
    await muted.post(day(7), { root: mutedRoot.id });

    const gone = await channel("gone", { left: true });
    const goneRoot = await gone.post(day(1));
    await gone.follow(goneRoot.id);
    await gone.post(day(8), { root: goneRoot.id });

    const notFollowed = await channel("unfollowed");
    const strangerRoot = await notFollowed.post(day(1));
    await notFollowed.post(day(9), { root: strangerRoot.id });

    const reference = (name: string, rootId: string) => `#${name}:${rootId.slice(0, 13)}`;
    const peer = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    const all = await listAgentInbox(db, workspace.id, agent.id);
    expect(all.items.map((item) => [item.kind, item.target])).toEqual([
      ["thread", reference("quiet", mutedRoot.id)],
      ["thread", reference("open", openRoot.id)],
    ]);
    expect(all.items[1]).toEqual({
      kind: "thread",
      target: reference("open", openRoot.id),
      unread: 2,
      mentions: 1,
      latestAt: day(4).toISOString(),
      latestSenderName: peer.username,
      lastReadSeq: 0,
    });
    expect(all.items[0]).toMatchObject({ unread: 1, mentions: 0 });
    // A thread counts as a conversation; it is not a DM.
    expect(all.totals).toEqual({ conversations: 2, dms: 0, mentions: 1 });

    const mentions = await listAgentInbox(db, workspace.id, agent.id, { view: "mentions" });
    expect(mentions.items.map((item) => item.target)).toEqual([reference("open", openRoot.id)]);
    expect(mentions.totals).toEqual(all.totals);
  } finally {
    await db.$disconnect();
  }
});
