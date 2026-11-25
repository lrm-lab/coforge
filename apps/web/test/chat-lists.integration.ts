import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import { CHAT_LIST_READS } from "#src/features/conversations/chat-list-reads";
import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { AppError } from "#src/lib/app-error";
import { ChatSections } from "#src/server/conversations/chat-sections.server";
import { readChatLists } from "#src/server/conversations/chat-lists.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

function database() {
  const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("PREFERENCES_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: [{ level: "query", emit: "event" }],
  });
}

async function withMember(
  run: (context: WorkspaceUserContext, db: ReturnType<typeof database>) => Promise<void>,
) {
  const db = database();
  const suffix = crypto.randomUUID();
  const user = await db.user.create({
    data: { displayName: `chat-lists-${suffix}`, username: `chat-lists-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Chat lists", members: { create: { userId: user.id } } },
  });
  try {
    await run(
      { db, workspaceId: workspace.id, user: { id: user.id } as WorkspaceUserContext["user"] },
      db,
    );
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}

function recordedStreams(steps: string[]) {
  const reads: string[][] = [];
  return {
    reads,
    streams: {
      streamPositions: async (channels: string[]) => {
        steps.push("positions");
        reads.push(channels);
        return Object.fromEntries(
          channels.map((channel, offset) => [channel, { epoch: "e", offset: offset + 10 }]),
        );
      },
    },
  };
}

test("every list answers as its own read did, after one read of the positions it carries", () =>
  withMember(async (context) => {
    const { db, workspaceId, user } = context;
    const sections = new ChatSections(db, workspaceId, user.id);
    await sections.create({ name: "Focus", emoji: null });
    await sections.reorder(["channels", (await sections.list())[0]!.id]);
    const steps: string[] = [];
    const { reads, streams } = recordedStreams(steps);

    const results = await readChatLists(context, CHAT_LIST_READS, {
      streams,
      onboard: async () => void steps.push("onboarding"),
    });

    const workspace = workspaceConversationChannel(workspaceId);
    const viewer = userConversationChannel(user.id);
    expect(steps).toEqual(["onboarding", "positions"]);
    expect(reads).toEqual([[workspace, viewer]]);
    const both = { [workspace]: { epoch: "e", offset: 10 }, [viewer]: { epoch: "e", offset: 11 } };
    const own = { [viewer]: both[viewer] };
    const channels = new PublicChannels(db);
    const directs = new DirectConversations(db);
    expect(results).toEqual({
      channels: {
        value: { streamPositions: both, channels: await channels.list(workspaceId, user.id) },
      },
      channelNames: {
        value: { streamPositions: both, names: await channels.names(workspaceId, user.id) },
      },
      saved: { value: { streamPositions: own, entries: [] } },
      directPreferences: {
        value: { ...(await directs.list(workspaceId, user.id)), streamPositions: own },
      },
      directBadges: {
        value: { viewerId: user.id, unread: {}, firstUnreadMessageIds: {}, streamPositions: own },
      },
      sections: { value: { streamPositions: own, sections: await sections.list() } },
      sectionOrder: { value: { streamPositions: own, order: await sections.order() } },
    });
  }));

test("lists the Workspace's channel does not keep live read only the viewer's own position", () =>
  withMember(async (context) => {
    const { reads, streams } = recordedStreams([]);
    await readChatLists(context, ["saved", "directBadges", "sections", "sectionOrder"], {
      streams,
    });
    expect(reads).toEqual([[userConversationChannel(context.user.id)]]);
  }));

test("a list that fails answers with its own error, and the others still answer", () =>
  withMember(async (context) => {
    const refused = await readChatLists(context, ["directPreferences", "saved"], {
      streams: null,
      onboard: () => Promise.reject(new AppError("TEMPORARILY_UNAVAILABLE")),
    });
    expect(refused.directPreferences).toEqual({ error: { code: "TEMPORARILY_UNAVAILABLE" } });
    expect(refused.saved).toEqual({ value: { streamPositions: {}, entries: [] } });

    const broken = await readChatLists(context, ["directPreferences", "sectionOrder"], {
      streams: null,
      onboard: () => Promise.reject(new Error("boom")),
    });
    const failure = broken.directPreferences;
    expect(failure && "error" in failure && failure.error.code).toBe("INTERNAL_ERROR");
    expect(failure && "error" in failure && typeof failure.error.errorId).toBe("string");
    expect(broken.sectionOrder).toEqual({ value: { streamPositions: {}, order: [] } });
  }));

test("saved chat list includes each equally timed bookmark across the page boundary", () =>
  withMember(async (context) => {
    const { db, workspaceId, user } = context;
    const { id: conversationId } = await db.conversation.create({
      data: { workspaceId, channelName: "bookmarks" },
    });
    const { id: memberId } = await db.conversationMember.create({
      data: { workspaceId, conversationId, userId: user.id },
    });
    const messages = await db.message.createManyAndReturn({
      data: Array.from({ length: 201 }, (_, index) => ({
        workspaceId,
        conversationId,
        senderMemberId: memberId,
        body: String(index),
        sequence: index + 1,
      })),
      select: { id: true },
    });
    const createdAt = new Date();
    await db.savedMessage.createMany({
      data: messages.map(({ id: messageId }) => ({
        workspaceId,
        conversationId,
        memberId,
        messageId,
        createdAt,
      })),
    });
    const { saved } = await readChatLists(context, ["saved"], { streams: null });
    expect(
      saved && "value" in saved && saved.value.entries.map((entry) => entry.message.id),
    ).toEqual(
      messages
        .map(({ id }) => id)
        .sort()
        .reverse(),
    );
  }));

test("the section read starts while assistant onboarding is pending", () =>
  withMember(async (context, db) => {
    const onboarding = Promise.withResolvers<void>();
    const sectionRead = Promise.withResolvers<string>();
    db.$on("query", ({ query }) => {
      if (query.includes('"chat_sections"')) sectionRead.resolve("sections");
    });
    const steps: string[] = [];
    const { streams } = recordedStreams(steps);
    const lists = readChatLists(context, ["directPreferences", "sections"], {
      streams,
      onboard: () => onboarding.promise,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        sectionRead.promise,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve("blocked"), 750);
        }),
      ]);
      expect(outcome).toBe("sections");
      expect(steps).toEqual(["positions"]);
    } finally {
      clearTimeout(timeout);
      onboarding.resolve();
      await lists;
    }
  }));

test("the full sidebar shares channel visibility and collage reads with the name directory", () =>
  withMember(async (context, db) => {
    const { workspaceId, user } = context;
    const channel = await db.conversation.create({
      data: { workspaceId, channelName: "shared-read", description: "Composer text" },
    });
    await db.conversationMember.create({
      data: { workspaceId, conversationId: channel.id, userId: user.id },
    });
    const queries: string[] = [];
    db.$on("query", ({ query }) => queries.push(query));
    const result = await readChatLists(context, ["channels", "channelNames"], { streams: null });
    const admitted = queries.filter(
      (sql) =>
        sql.includes('"hiddenFromWorkspaceAt"') &&
        sql.includes('"visibility"') &&
        sql.includes('FROM "public"."conversations"'),
    );
    const collages = queries.filter(
      (sql) => sql.includes("CROSS JOIN LATERAL") && sql.includes('ORDER BY cm."joinedAt"'),
    );
    expect(admitted).toHaveLength(1);
    expect(collages).toHaveLength(1);
    const channels = new PublicChannels(db);
    expect(result).toEqual({
      channels: {
        value: { channels: await channels.list(workspaceId, user.id), streamPositions: {} },
      },
      channelNames: {
        value: { names: await channels.names(workspaceId, user.id), streamPositions: {} },
      },
    });
  }));

test("DM preview mentions start while people profiles are pending", () =>
  withMember(async (context, db) => {
    const { workspaceId, user } = context;
    const peer = await db.user.create({
      data: { username: `chat-peers-${crypto.randomUUID()}`, displayName: "Peer" },
    });
    await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
    try {
      const { conversationId } = await new DirectConversations(db).open(workspaceId, user.id, {
        userId: peer.id,
      });
      await db.message.create({
        data: { workspaceId, conversationId, sequence: 1, body: "Hello" },
      });
      const profiles = Promise.withResolvers<void>();
      const mentions = Promise.withResolvers<string>();
      const observed = db.$extends({
        query: {
          user: {
            async findMany({ args, query }) {
              await profiles.promise;
              return query(args);
            },
          },
          messageMention: {
            findMany({ args, query }) {
              mentions.resolve("mentions");
              return query(args);
            },
          },
        },
      });
      const lists = readChatLists(
        { ...context, db: observed as unknown as WorkspaceUserContext["db"] },
        ["directPreferences"],
        { streams: null, onboard: async () => undefined },
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          mentions.promise,
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve("blocked"), 750);
          }),
        ]);
        expect(outcome).toBe("mentions");
      } finally {
        clearTimeout(timeout);
        profiles.resolve();
        await lists;
      }
    } finally {
      await db.conversation.deleteMany({ where: { workspaceId, directKey: { not: null } } });
      await db.workspaceMembership.delete({
        where: { workspaceId_userId: { workspaceId, userId: peer.id } },
      });
      await db.user.delete({ where: { id: peer.id } });
    }
  }));

test("channel names still answer when the sidebar membership read fails", () =>
  withMember(async (context, db) => {
    const { workspaceId } = context;
    const channel = await db.conversation.create({
      data: { workspaceId, channelName: "directory-only" },
    });
    const observed = db.$extends({
      query: {
        conversationMember: {
          findMany({ args, query }) {
            if (args.select?.hiddenAt) throw new AppError("TEMPORARILY_UNAVAILABLE");
            return query(args);
          },
        },
      },
    });
    const result = await readChatLists(
      { ...context, db: observed as unknown as WorkspaceUserContext["db"] },
      ["channels", "channelNames"],
      { streams: null },
    );
    expect(result.channels).toEqual({ error: { code: "TEMPORARILY_UNAVAILABLE" } });
    expect(result.channelNames).toEqual({
      value: {
        streamPositions: {},
        names: [
          {
            id: channel.id,
            name: "directory-only",
            description: "",
            archived: false,
            visibility: "public",
            members: [],
          },
        ],
      },
    });
  }));
