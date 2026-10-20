import type { PrismaClient } from "#src/generated/prisma/client";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "./conversation-realtime.server";
import { DirectConversations } from "./direct-conversations.server";
import { PublicChannels } from "./public-channels.server";

type Toggle = { messageId: string; emoji: string; active: boolean };
/** Who reacts, as a Server Function's `workspaceUserMiddleware` context says. */
type Viewer = { db: PrismaClient; workspaceId: string; user: { id: string } };

/** The production port a person's reaction tells the conversation's open pages through. */
const realtime = () => new CentrifugoConversationRealtime(createCentrifugoServerApi());

/**
 * A person's reaction in a channel, as its Server Functions make it: the current one returns the
 * versioned summary, and the one a tab opened before versions existed still calls takes its
 * `reactions` alone.
 */
export function toggleChannelReaction(
  { db, workspaceId, user }: Viewer,
  { channelId, messageId, emoji, active }: Toggle & { channelId: string },
) {
  return new PublicChannels(db, undefined, undefined, undefined, realtime()).toggleUserReaction(
    workspaceId,
    user.id,
    channelId,
    messageId,
    emoji,
    active,
  );
}

/** A person's reaction in one of their direct conversations, like `toggleChannelReaction`. */
export function toggleDirectReaction(
  { db, workspaceId, user }: Viewer,
  { conversationId, ...reaction }: Toggle & { conversationId: string },
) {
  return new DirectConversations(db, realtime()).react(
    workspaceId,
    user.id,
    conversationId,
    reaction,
  );
}
