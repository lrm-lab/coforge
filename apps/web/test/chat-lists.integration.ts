import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
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
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function withMember(run: (context: WorkspaceUserContext) => Promise<void>) {
  const db = database();
  const suffix = crypto.randomUUID();
  const user = await db.user.create({
    data: { displayName: `chat-lists-${suffix}`, username: `chat-lists-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Chat lists", members: { create: { userId: user.id } } },
  });
  try {
    await run({
      db,
      workspaceId: workspace.id,
      user: { id: user.id } as WorkspaceUserContext["user"],
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}

/** Centrifugo's positions as a fake that notes each read, in `steps` beside the onboarding's. */
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

    const results = await readChatLists(
      context,
      [
        "channels",
        "channelNames",
        "saved",
        "directPreferences",
        "directBadges",
        "sections",
        "sectionOrder",
      ],
      { streams, onboard: async () => void steps.push("onboarding") },
    );

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
      directBadges: { value: { viewerId: user.id, unread: {}, streamPositions: own } },
      sections: { value: { streamPositions: own, sections: await sections.list() } },
      sectionOrder: { value: { order: await sections.order() } },
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

    // An unexpected failure is answered as a failed call is: an id to find it in the logs by.
    const broken = await readChatLists(context, ["directPreferences", "sectionOrder"], {
      streams: null,
      onboard: () => Promise.reject(new Error("boom")),
    });
    const failure = broken.directPreferences;
    expect(failure && "error" in failure && failure.error.code).toBe("INTERNAL_ERROR");
    expect(failure && "error" in failure && typeof failure.error.errorId).toBe("string");
    expect(broken.sectionOrder).toEqual({ value: { order: [] } });
  }));
