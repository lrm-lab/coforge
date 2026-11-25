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
import { recordServerFnError } from "#src/server/observability/server-fn-log.server";
import { ChatSections } from "./chat-sections.server";
import { chatStreamPositions } from "./chat-stream-positions.server";
import type { CentrifugoStreams } from "#src/server/centrifugo/server-api.server";
import { DirectConversations } from "./direct-conversations.server";
import { PublicChannels } from "./public-channels.server";
import { sharedChannelDirectory } from "./channel-directory.server";
import {
  SAVED_MESSAGES_DEFAULT_LIMIT,
  listUserSavedMessages,
  type SavedMessagesCursor,
  type SavedMessageView,
} from "./saved-messages.server";

type SignalChannel = "workspace" | "user";

const LIVE_ON: Record<ChatListRead, readonly SignalChannel[]> = {
  channels: ["workspace", "user"],
  channelNames: ["workspace", "user"],
  saved: ["user"],
  directPreferences: ["user"],
  directBadges: ["user"],
  sections: ["user"],
  sectionOrder: ["user"],
};

async function readSavedEntries({ db, workspaceId, user }: WorkspaceUserContext) {
  const entries: SavedMessageView[] = [];
  let cursor: SavedMessagesCursor | undefined;
  while (true) {
    const page = await listUserSavedMessages(db, { workspaceId, userId: user.id, cursor });
    entries.push(...page);
    if (page.length < SAVED_MESSAGES_DEFAULT_LIMIT) return entries;
    const last = page[page.length - 1]!;
    cursor = { savedAt: last.savedAt, messageId: last.message.id };
  }
}

function listReaders(
  context: WorkspaceUserContext,
  onboarded: Promise<unknown> | undefined,
  shareDirectory: boolean,
) {
  const { db, workspaceId, user } = context;
  const channels = new PublicChannels(db);
  const directory = shareDirectory ? sharedChannelDirectory(db, workspaceId, user.id) : undefined;
  const directs = () => new DirectConversations(db);
  const sections = () => new ChatSections(db, workspaceId, user.id);
  return {
    channels: async () => ({
      channels: await (directory?.list() ?? channels.list(workspaceId, user.id)),
    }),
    channelNames: async () => ({
      names: await (directory?.names() ?? channels.names(workspaceId, user.id)),
    }),
    saved: async () => ({
      entries: await readSavedEntries(context),
    }),
    directPreferences: async () => {
      await onboarded;
      return directs().list(workspaceId, user.id);
    },
    directBadges: async () => {
      await onboarded?.catch(() => undefined);
      const rows = await directs().unreadCounts(workspaceId, user.id);
      const unread: Record<string, number> = {};
      const firstUnreadMessageIds: Record<string, string | null> = {};
      for (const row of rows) {
        unread[row.conversationId] = row.unread;
        firstUnreadMessageIds[row.conversationId] = row.firstUnreadMessageId;
      }
      return { viewerId: user.id, unread, firstUnreadMessageIds };
    },
    sections: async () => ({ sections: await sections().list() }),
    sectionOrder: async () => ({ order: await sections().order() }),
  };
}

type Readers = ReturnType<typeof listReaders>;

type ChatListResult<Value> = { value: Value } | { error: { code: AppErrorCode; errorId?: string } };

type ChatListResults = {
  [List in ChatListRead]?: ChatListResult<
    Awaited<ReturnType<Readers[List]>> & { streamPositions: StreamPositions }
  >;
};

async function settle<Value>(read: () => Promise<Value>): Promise<ChatListResult<Value>> {
  try {
    return { value: await read() };
  } catch (cause) {
    const error = toPublicServerError(cause);
    if (!isAppError(error)) throw error;
    if (error !== cause) recordServerFnError(cause);
    return { error: { code: error.code, ...(error.errorId ? { errorId: error.errorId } : {}) } };
  }
}

export async function readChatLists(
  context: WorkspaceUserContext,
  lists: readonly ChatListRead[],
  {
    streams,
    onboard = () =>
      workspaceAssistantOnboarding(context.db).ensure(context.workspaceId, context.user.id),
  }: { streams?: CentrifugoStreams | null; onboard?: () => Promise<unknown> } = {},
): Promise<ChatListResults> {
  const wanted = [...new Set(lists)];
  const onboarded = wanted.includes("directPreferences") ? onboard() : undefined;
  void onboarded?.catch(() => undefined);
  const signalChannels: Record<SignalChannel, string> = {
    workspace: workspaceConversationChannel(context.workspaceId),
    user: userConversationChannel(context.user.id),
  };
  const live = new Set(wanted.flatMap((list) => LIVE_ON[list]));
  const read = await chatStreamPositions(
    [...live].map((channel) => signalChannels[channel]),
    streams,
  );
  const positionsOf = (list: ChatListRead): StreamPositions =>
    Object.fromEntries(
      LIVE_ON[list].flatMap((channel) => {
        const position = read[signalChannels[channel]];
        return position ? [[signalChannels[channel], position]] : [];
      }),
    );
  const readers = listReaders(
    context,
    onboarded,
    wanted.includes("channels") && wanted.includes("channelNames"),
  );
  const entries = await Promise.all(
    wanted.map(async (list) => {
      const result = await settle(async () => ({
        ...(await readers[list]()),
        streamPositions: positionsOf(list),
      }));
      return [list, result] as const;
    }),
  );
  return Object.fromEntries(entries) as ChatListResults;
}
