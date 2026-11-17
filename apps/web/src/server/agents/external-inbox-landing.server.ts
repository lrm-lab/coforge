import type { PrismaClient } from "#src/generated/prisma/client";
import { startedAppNotificationQueue } from "#src/server/app-notifications/app-notification-queue.server";
import { sendExternalInboxNotice } from "./external-inbox-notice-queue.server";
import { externalInboxSignal } from "./external-inbox-signal.server";

type LandingDeps = {
  notify: (agentId: string) => void;
  enqueueNotice: (agentId: string) => Promise<void>;
};

const PRODUCTION: LandingDeps = {
  notify: (agentId) => externalInboxSignal.notify(agentId),
  enqueueNotice: async (agentId) => {
    const boss = startedAppNotificationQueue();
    if (!boss) throw new Error("notice queue is not running");
    await sendExternalInboxNotice(boss, agentId);
  },
};

export async function noticeExternalInbox(
  db: Pick<PrismaClient, "$queryRaw">,
  message: { conversationId: string; messageId: string },
  deps: LandingDeps = PRODUCTION,
): Promise<void> {
  try {
    const agents = await db.$queryRaw<{ agentId: string; pushable: boolean }[]>`
      SELECT a."id"::text AS "agentId",
        (w."agentId" IS NOT NULL AND w."enabled"
          AND (w."retryAt" IS NULL OR w."retryAt" <= (now() AT TIME ZONE 'UTC'))) AS "pushable"
      FROM "conversations" c
      JOIN "agents" a ON a."workspaceId" = c."workspaceId" AND a."hosting" = 'external'
        AND a."deletedAt" IS NULL AND a."stoppedAt" IS NULL
      LEFT JOIN "external_agent_push_webhooks" w ON w."agentId" = a."id"
      WHERE c."id" = ${message.conversationId}::uuid
        AND (EXISTS (
          SELECT 1 FROM "conversation_members" m
          WHERE m."conversationId" = c."id" AND m."agentId" = a."id" AND m."leftAt" IS NULL
        ) OR EXISTS (
          SELECT 1 FROM "pending_mention_actions" p
          WHERE p."messageId" = ${message.messageId}::uuid AND p."targetAgentId" = a."id"
        ))`;
    for (const { agentId, pushable } of agents) {
      deps.notify(agentId);
      if (pushable) await deps.enqueueNotice(agentId).catch(() => logFailure("enqueue"));
    }
  } catch {
    logFailure("lookup");
  }
}

function logFailure(step: "lookup" | "enqueue") {
  console.warn(JSON.stringify({ event: "external_agent.inbox_notice_skipped", step }));
}
