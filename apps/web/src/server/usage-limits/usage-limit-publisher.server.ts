import type { PrismaClient } from "#src/generated/prisma/client";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { UsageLimitChangedEvent } from "#src/features/usage-limits/usage-limit-events";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { PrismaUsageLimitEventRepository } from "#src/server/db/repositories/usage-limit-events.repositories.server";
import type { UsageLimitAnnouncer } from "./usage-limit-events.server";

/**
 * Pushes `usage.limit.changed.v1` to each affected Workspace's owner/admin
 * members on their own `chat:user:<id>` channels — the only audience the
 * events belong to. One broadcast per Workspace; announces are single-shot,
 * so no idempotency key — a repeated frame only costs the client a refetch.
 */
export function createUsageLimitAnnouncer(
  centrifugo: Pick<CentrifugoServerApi, "broadcast">,
  db: PrismaClient,
): UsageLimitAnnouncer {
  const repo = new PrismaUsageLimitEventRepository(db);
  return async (changes) => {
    const byWorkspace = new Map<string, UsageLimitChangedEvent[]>();
    for (const change of changes) {
      const events = byWorkspace.get(change.workspaceId) ?? [];
      events.push(change);
      byWorkspace.set(change.workspaceId, events);
    }
    await Promise.all(
      [...byWorkspace].map(async ([workspaceId, events]) => {
        const userIds = await repo.elevatedUserIds(workspaceId);
        if (userIds.length === 0) return;
        const channels = userIds.map((userId) => userConversationChannel(userId));
        for (const event of events) await centrifugo.broadcast(channels, event);
      }),
    );
  };
}
