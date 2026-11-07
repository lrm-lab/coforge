import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { COLLECT_RUN_STATUS } from "./weekly-report-collect-run.server";

/** Wake text for a per-Computer collector Agent. */
export function buildCollectorWakeBody(input: {
  runId: string;
  reportId: string;
  slotId: string;
  windowStart: Date;
  windowEnd: Date;
  scanPaths: string[];
  ownerUsername: string;
  ownerDisplayName?: string | null;
  ownerGitHubLogin?: string | null;
}): string {
  const paths =
    input.scanPaths.length > 0
      ? input.scanPaths.map((path) => `- ${path}`).join("\n")
      : "- (use Computer-local collect-roots or heuristic SCAN_ROOTS)";
  const ownerLines = [
    `ownerUsername=${input.ownerUsername}`,
    ...(input.ownerDisplayName?.trim()
      ? [`ownerDisplayName=${input.ownerDisplayName.trim()}`]
      : []),
    ...(input.ownerGitHubLogin?.trim()
      ? [`ownerGitHubLogin=${input.ownerGitHubLogin.trim()}`]
      : []),
  ];
  return [
    "请在本机按 weekly-report-collect skill 采集工作证据，完成后用 coforge 上报 pack。",
    "只采集本报告作者本人的工作；git 等平台必须按作者过滤，不要把同事的提交一并采入。",
    `runId=${input.runId}`,
    `reportId=${input.reportId}`,
    `slotId=${input.slotId}`,
    `windowStart=${input.windowStart.toISOString()}`,
    `windowEnd=${input.windowEnd.toISOString()}`,
    ...ownerLines,
    "scanPaths:",
    paths,
    "",
    "完成后调用：coforge weekly-report-collect submit-pack --run-id <runId> --idempotency-key <uuid> --markdown <file>",
    "无证据：coforge weekly-report-collect submit-empty --run-id <runId> --idempotency-key <uuid>",
    "失败：coforge weekly-report-collect submit-failure --run-id <runId> --idempotency-key <uuid> --reason <text>",
  ].join("\n");
}

/**
 * Wakes each running slot's collector Agent with its Collect Run wake DM.
 * Throws the first dispatch error after settling the run when any send fails.
 */
export async function dispatchCollectorWakes(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    runId: string;
    slots: Array<{
      id: string;
      collectorAgentId: string;
      computerId: string;
      scanPaths: string[];
    }>;
    windowStart: Date;
    windowEnd: Date;
  },
): Promise<void> {
  const conversations = new PrismaDirectConversationRepository(db);
  const centrifugo = createCentrifugoServerApi();
  const idempotency = getMessageRequestIdempotency();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  const sender = new SendDirectMessage(conversations, idempotency, centrifugo, realtime);

  const owner = await db.user.findUnique({
    where: { id: input.userId },
    select: {
      username: true,
      displayName: true,
      gitHubConnection: { select: { login: true } },
    },
  });
  if (!owner) throw new AppError("NOT_FOUND");

  try {
    for (const slot of input.slots) {
      const opened = await conversations.memberForUser(
        input.workspaceId,
        input.userId,
        slot.collectorAgentId,
      );
      await sender.execute({
        idempotencyKey: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        conversationId: opened.conversationId,
        senderMemberId: opened.senderMemberId,
        senderUserId: input.userId,
        body: buildCollectorWakeBody({
          runId: input.runId,
          reportId: input.reportId,
          slotId: slot.id,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          scanPaths: slot.scanPaths,
          ownerUsername: owner.username,
          ownerDisplayName: owner.displayName,
          ownerGitHubLogin: owner.gitHubConnection?.login ?? null,
        }),
      });
    }
  } catch (error) {
    // Do not leave a collecting Run behind when dispatch fails halfway through the wave.
    // Otherwise the card shows a permanently running collection and every retry adds another
    // orphan Run. Keep the original error so the browser can render its safe AppError code.
    await db.weeklyReportCollectSlot.updateMany({
      where: { runId: input.runId, status: "running" },
      data: { status: "cancelled", failureReason: "collector dispatch failed" },
    });
    await db.weeklyReportCollectRun.updateMany({
      where: { id: input.runId, status: COLLECT_RUN_STATUS.collecting },
      data: { status: COLLECT_RUN_STATUS.cancelled, completedAt: new Date() },
    });
    console.error(
      JSON.stringify({
        event: "weekly_report.collect_dispatch_failed",
        run_id: input.runId,
        report_id: input.reportId,
        computer_ids: input.slots.map((slot) => slot.computerId),
        error_type: error instanceof Error ? error.name : typeof error,
        error_message: thrownMessage(error),
      }),
    );
    throw error;
  }
}
