import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import type { ChatListRead } from "#src/features/conversations/chat-list-reads";
import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import type { StreamPositions } from "#src/features/realtime/subscription-gap";
import { isAppError, type AppErrorCode } from "#src/lib/app-error";
import { workspaceAssistantOnboarding } from "#src/server/agents/workspace-assistant-onboarding.server";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import { ChatSections } from "./chat-sections.server";
import { chatStreamPositions } from "./chat-stream-positions.server";
import type { CentrifugoStreams } from "#src/server/centrifugo/server-api.server";
import { DirectConversations } from "./direct-conversations.server";
import { PublicChannels } from "./public-channels.server";
import { listUserSavedMessages } from "./saved-messages.server";

/** Where the signal channels stood before the lists were read, and which of them keep a list
 * live: the Workspace's carries public channels' facts, the viewer's own everything personal. */
type Positions = { of: (channels: readonly ("workspace" | "user")[]) => StreamPositions };

/** Each list's read, in the shape its own server function answered with before. */
function listReaders({ db, workspaceId, user }: WorkspaceUserContext, positions: Positions) {
  const channels = () => new PublicChannels(db);
  const directs = () => new DirectConversations(db);
  const sections = () => new ChatSections(db, workspaceId, user.id);
  return {
    channels: async () => ({
      streamPositions: positions.of(["workspace", "user"]),
      channels: await channels().list(workspaceId, user.id),
    }),
    channelNames: async () => ({
      streamPositions: positions.of(["workspace", "user"]),
      names: await channels().names(workspaceId, user.id),
    }),
    saved: async () => ({
      streamPositions: positions.of(["user"]),
      entries: await listUserSavedMessages(db, { workspaceId, userId: user.id }),
    }),
    directPreferences: async () => ({
      ...(await directs().list(workspaceId, user.id)),
      streamPositions: positions.of(["user"]),
    }),
    directBadges: async () => {
      const rows = await directs().unreadCounts(workspaceId, user.id);
      const unread: Record<string, number> = {};
      for (const row of rows) unread[row.conversationId] = row.unread;
      return { viewerId: user.id, unread, streamPositions: positions.of(["user"]) };
    },
    sections: async () => ({
      streamPositions: positions.of(["user"]),
      sections: await sections().list(),
    }),
    sectionOrder: async () => ({ order: await sections().order() }),
  };
}

type Readers = ReturnType<typeof listReaders>;

/** One list's answer: what it read, or the error its own call would have failed with. */
export type ChatListResult<Value> =
  | { value: Value }
  | { error: { code: AppErrorCode; errorId?: string } };

export type ChatListResults = {
  [List in ChatListRead]?: ChatListResult<Awaited<ReturnType<Readers[List]>>>;
};

async function settle<Value>(read: () => Promise<Value>): Promise<ChatListResult<Value>> {
  try {
    return { value: await read() };
  } catch (cause) {
    // Logged as a failed call would be, and answered with the same public error.
    const error = toPublicServerError(cause);
    if (!isAppError(error)) throw error;
    return { error: { code: error.code, ...(error.errorId ? { errorId: error.errorId } : {}) } };
  }
}

/**
 * The lists named, read together: the Workspace membership was checked once (the caller's
 * middleware), the signal channels' positions are read once before any list (`chatStreamPositions`),
 * and each list carries those of the channels that keep it live, as its own read did
 * (`readAfterStreamPositions`). A list's failure is its own; the others still answer.
 */
export async function readChatLists(
  context: WorkspaceUserContext,
  lists: readonly ChatListRead[],
  {
    streams,
    onboard = () =>
      workspaceAssistantOnboarding(context.db).ensure(context.workspaceId, context.user.id),
  }: { streams?: CentrifugoStreams | null; onboard?: () => Promise<unknown> } = {},
): Promise<ChatListResults> {
  const { workspaceId, user } = context;
  const wanted = new Set(lists);
  // Before the positions, as the DM list's own read did: it may start the viewer's DM with the
  // Workspace's assistant, whose announcement the positions then include.
  const onboarding = wanted.has("directPreferences")
    ? await settle(onboard)
    : undefined;
  const signalChannels = {
    workspace: workspaceConversationChannel(workspaceId),
    user: userConversationChannel(user.id),
  };
  const needsWorkspace = wanted.has("channels") || wanted.has("channelNames");
  const read = await chatStreamPositions(
    needsWorkspace ? [signalChannels.workspace, signalChannels.user] : [signalChannels.user],
    streams,
  );
  const positions: Positions = {
    of: (channels) =>
      Object.fromEntries(
        channels.flatMap((channel) => {
          const position = read[signalChannels[channel]];
          return position ? [[signalChannels[channel], position]] : [];
        }),
      ),
  };
  const readers = listReaders(context, positions);
  const entries = await Promise.all(
    [...wanted].map(async (list) => {
      if (list === "directPreferences" && onboarding && "error" in onboarding)
        return [list, onboarding] as const;
      return [list, await settle<unknown>(readers[list])] as const;
    }),
  );
  return Object.fromEntries(entries) as ChatListResults;
}
