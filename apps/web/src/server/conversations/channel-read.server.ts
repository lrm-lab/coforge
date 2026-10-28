import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { announceViewerEvent, type ConversationRealtime } from "./conversation-realtime.server";
import { announceConversationReadChanged } from "./conversation-read-realtime.server";
import { markHumanRead } from "./human-unread.server";

/** Advances a channel's human read cursor and announces the viewer and shared read state. */
export async function markPublicChannelRead(input: {
  db: PrismaClient;
  realtime?: Pick<ConversationRealtime, "viewerChanged" | "conversationReadChanged">;
  authorize: () => Promise<unknown>;
  workspaceId: string;
  userId: string;
  conversationId: string;
  throughSequence: number;
}) {
  await input.authorize();
  if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 1)
    throw new AppError("INVALID_INPUT");
  const state = await markHumanRead(input.db, {
    conversationId: input.conversationId,
    userId: input.userId,
    throughSequence: input.throughSequence,
  });
  if (state === undefined) return;
  const { memberId, readThroughAdvanced, ...viewerState } = state;
  await announceViewerEvent(input.realtime, {
    userIds: [input.userId],
    event: {
      type: "channel.marked.v1",
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      ...viewerState,
    },
  });
  if (readThroughAdvanced)
    await announceConversationReadChanged(input.realtime, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      memberId,
      readThroughSequence: state.readThroughSequence,
    });
}
