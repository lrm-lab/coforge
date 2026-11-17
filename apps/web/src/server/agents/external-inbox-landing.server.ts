import type { PrismaClient } from "#src/generated/prisma/client";
import { liveDeliverySql } from "#src/server/db/repositories/agent-attention-deliveries.repositories.server";
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
        (w."agentId" IS NOT NULL AND w."disabledReason" IS NULL
          AND (w."retryAt" IS NULL OR w."retryAt" <= (now() AT TIME ZONE 'UTC'))) AS "pushable"
      FROM "conversations" c
      JOIN "agents" a ON a."workspaceId" = c."workspaceId" AND a."hosting" = 'external'
        AND a."deletedAt" IS NULL AND a."stoppedAt" IS NULL
      LEFT JOIN "external_agent_push_webhooks" w ON w."agentId" = a."id"
      WHERE c."id" = ${message.conversationId}::uuid
        AND (EXISTS (
          SELECT 1 FROM "agent_message_deliveries" d
          WHERE d."messageId" = ${message.messageId}::uuid AND d."agentId" = a."id"
            AND ${liveDeliverySql("d")}
        ) OR (c."directKey" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "conversation_members" m
          WHERE m."conversationId" = c."id" AND m."agentId" = a."id" AND m."leftAt" IS NULL
        ) AND EXISTS (
          SELECT 1 FROM "messages" msg
          JOIN "conversation_members" sm ON sm."id" = msg."senderMemberId"
          WHERE msg."id" = ${message.messageId}::uuid AND sm."userId" IS NOT NULL
        )))`;
    await Promise.all(
      agents.map(({ agentId, pushable }) => {
        deps.notify(agentId);
        return pushable
          ? deps.enqueueNotice(agentId).catch(() => logFailure("enqueue"))
          : undefined;
      }),
    );
  } catch {
    logFailure("lookup");
  }
}

function logFailure(step: "lookup" | "enqueue") {
  console.warn(JSON.stringify({ event: "external_agent.inbox_notice_skipped", step }));
}
