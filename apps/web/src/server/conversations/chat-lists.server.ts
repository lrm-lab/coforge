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
import { listUserSavedMessages } from "./saved-messages.server";

type SignalChannel = "workspace" | "user";

/** The signal channels that keep each list live, whose positions its read carries: the
 * Workspace's carries public channels' facts, the viewer's own everything personal. */
const LIVE_ON: Record<ChatListRead, readonly SignalChannel[]> = {
  channels: ["workspace", "user"],
  channelNames: ["workspace", "user"],
  saved: ["user"],
  directPreferences: ["user"],
  directBadges: ["user"],
  sections: ["user"],
  sectionOrder: ["user"],
};

/** Each list's read, in the shape its own server function answered with before (less the
 * positions, which `readChatLists` adds). The DM list waits for `onboarded`, as its own read did. */
function listReaders(
  { db, workspaceId, user }: WorkspaceUserContext,
  onboarded: Promise<unknown> | undefined,
) {
  const channels = () => new PublicChannels(db);
  const directs = () => new DirectConversations(db);
  const sections = () => new ChatSections(db, workspaceId, user.id);
  return {
    channels: async () => ({ channels: await channels().list(workspaceId, user.id) }),
    channelNames: async () => ({ names: await channels().names(workspaceId, user.id) }),
    saved: async () => ({
      entries: await listUserSavedMessages(db, { workspaceId, userId: user.id }),
    }),
    directPreferences: async () => {
      await onboarded;
      return directs().list(workspaceId, user.id);
    },
    directBadges: async () => {
      const rows = await directs().unreadCounts(workspaceId, user.id);
      const unread: Record<string, number> = {};
      for (const row of rows) unread[row.conversationId] = row.unread;
      return { viewerId: user.id, unread };
    },
    sections: async () => ({ sections: await sections().list() }),
    sectionOrder: async () => ({ order: await sections().order() }),
  };
}

type Readers = ReturnType<typeof listReaders>;

/** One list's answer: what it read, or the error its own call would have failed with. */
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
    // Answered and logged as a failed call would be (`publicServerFunctionErrors`).
    const error = toPublicServerError(cause);
    if (!isAppError(error)) throw error;
    if (error !== cause) recordServerFnError(cause);
    return { error: { code: error.code, ...(error.errorId ? { errorId: error.errorId } : {}) } };
  }
}

/**
 * The lists named, read together: the Workspace membership was checked once (the caller's
 * middleware), the signal channels' positions are read once before any list (`chatStreamPositions`),
 * and each list carries those of the channels that keep it live (`LIVE_ON`), as its own read did
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
  const wanted = [...new Set(lists)];
  // Before the positions, as the DM list's own read did: it may start the viewer's DM with the
  // Workspace's assistant, whose announcement the positions then include. Its failure is the DM
  // list's alone.
  const onboarded = wanted.includes("directPreferences") ? onboard() : undefined;
  await onboarded?.catch(() => undefined);
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
  const readers = listReaders(context, onboarded);
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
