import { fromPrisma, type PgBoss } from "pg-boss";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import { AppError } from "#src/lib/app-error";
import {
  centrifugoServerApiConfigured,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";

export const CHANNEL_THREAD_UNREAD_QUEUE = "channel-thread-unread-invalidation";

type ChannelTarget = { workspaceId: string; conversationId: string };

export type ChannelThreadUnreadJob = ChannelTarget &
  ({ userId: string } | { rootMessageId: string });

let activeQueue: (() => Pick<PgBoss, "insert"> | undefined) | undefined;

export function registerChannelThreadUnreadQueue(queue: () => Pick<PgBoss, "insert"> | undefined) {
  activeQueue = queue;
}

export async function recordChannelThreadUnread(
  tx: Prisma.TransactionClient,
  ...jobs: ChannelThreadUnreadJob[]
) {
  if (jobs.length === 0 || !centrifugoServerApiConfigured()) return;
  const queue = activeQueue?.();
  if (!queue) throw new AppError("TEMPORARILY_UNAVAILABLE");
  const ids = await queue.insert(
    CHANNEL_THREAD_UNREAD_QUEUE,
    jobs.map((data) => ({ data })),
    { db: fromPrisma(tx), returnId: true },
  );
  if (ids?.length !== jobs.length) throw new AppError("TEMPORARILY_UNAVAILABLE");
}

export async function publishChannelThreadUnread(
  db: PrismaClient,
  publisher: Pick<CentrifugoServerApi, "broadcast">,
  job: ChannelThreadUnreadJob,
  jobId: string,
) {
  const { workspaceId, conversationId } = job;
  const candidates = await db.conversationMember.findMany({
    where: {
      workspaceId,
      conversationId,
      ...ACTIVE_MEMBER_WHERE,
      conversation: { channelName: { not: null }, ...VISIBLE_CONVERSATION_WHERE },
      user: { memberships: { some: { workspaceId } } },
      userId: "userId" in job ? job.userId : { not: null },
      ...("rootMessageId" in job
        ? { threadFollows: { some: { rootMessageId: job.rootMessageId, unfollowedAt: null } } }
        : {}),
    },
    select: { userId: true },
  });
  await publisher.broadcast(
    candidates.flatMap(({ userId }) => (userId ? [userConversationChannel(userId)] : [])),
    { type: REALTIME_EVENTS.channelThreadUnreadInvalidated, workspaceId, conversationId },
    jobId,
  );
}
