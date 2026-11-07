import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import {
  COLLECT_RUN_STATUS,
  COLLECT_SLOT_STATUS,
  collectWaveExhausted,
} from "./weekly-report-collect-run.server";

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

export const COLLECT_DISPATCH_FAILED_REASON = "collector dispatch failed";

type CollectorWakeSlot = {
  id: string;
  collectorAgentId: string;
  computerId: string;
  scanPaths: string[];
};

/**
 * Wakes each running slot's collector Agent with its Collect Run wake DM.
 *
 * One slot's failed send must not judge the wave's other slots: a slot whose
 * DM already landed keeps running so its collector can still submit, while a
 * slot whose send threw is marked `failed` — reopenable, because a stored DM
 * can still reach the Agent and a late report beats a cancelled slot (#695).
 * The run is cancelled only once every slot is terminal with nothing to
 * synthesize; the first error is rethrown only when no slot was dispatched.
 */
export async function dispatchCollectorWakes(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    runId: string;
    slots: CollectorWakeSlot[];
    windowStart: Date;
    windowEnd: Date;
  },
  sendWake?: (slot: CollectorWakeSlot, body: string) => Promise<void>,
): Promise<void> {
  const owner = await db.user.findUnique({
    where: { id: input.userId },
    select: {
      username: true,
      displayName: true,
      gitHubConnection: { select: { login: true } },
    },
  });
  if (!owner) throw new AppError("NOT_FOUND");

  let deliver = sendWake;
  if (!deliver) {
    const conversations = new PrismaDirectConversationRepository(db);
    const centrifugo = createCentrifugoServerApi();
    const idempotency = getMessageRequestIdempotency();
    const realtime = new CentrifugoConversationRealtime(centrifugo);
    const sender = new SendDirectMessage(conversations, idempotency, centrifugo, realtime);
    deliver = async (slot, body) => {
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
        body,
      });
    };
  }

  const failedSlotIds: string[] = [];
  let firstError: unknown;
  for (const slot of input.slots) {
    try {
      await deliver(
        slot,
        buildCollectorWakeBody({
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
      );
    } catch (error) {
      failedSlotIds.push(slot.id);
      firstError ??= error;
      console.error(
        JSON.stringify({
          event: "weekly_report.collect_dispatch_slot_failed",
          run_id: input.runId,
          report_id: input.reportId,
          slot_id: slot.id,
          computer_id: slot.computerId,
          error_type: error instanceof Error ? error.name : typeof error,
          error_message: thrownMessage(error),
        }),
      );
    }
  }
  if (failedSlotIds.length === 0) return;

  // No requestId fence: the send may have stored the DM before throwing, so a
  // late submit must still be able to settle this slot.
  await db.weeklyReportCollectSlot.updateMany({
    where: { id: { in: failedSlotIds }, status: COLLECT_SLOT_STATUS.running },
    data: { status: COLLECT_SLOT_STATUS.failed, failureReason: COLLECT_DISPATCH_FAILED_REASON },
  });

  const refreshed = await db.weeklyReportCollectRun.findFirst({
    where: { id: input.runId },
    include: { slots: { orderBy: { computerId: "asc" } } },
  });
  if (
    refreshed?.status === COLLECT_RUN_STATUS.collecting &&
    collectWaveExhausted(refreshed.slots)
  ) {
    await db.weeklyReportCollectRun.updateMany({
      where: { id: input.runId, status: COLLECT_RUN_STATUS.collecting },
      data: { status: COLLECT_RUN_STATUS.cancelled, completedAt: new Date() },
    });
  }

  if (failedSlotIds.length === input.slots.length) throw firstError;
}
