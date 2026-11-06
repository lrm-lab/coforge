import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  COLLECT_RUN_STATUS,
  COLLECT_SLOT_STATUS,
  asScanPaths,
  canSynthesizeFromSlots,
  collectWaveExhausted,
  toRunView,
  type CollectRunSlotView,
  type CollectRunView,
} from "./weekly-report-collect-run.server";

/** Platform settle ceiling for one collect wave. */
export const COLLECT_SLOT_STALL_MS = 15 * 60_000;

export const COLLECT_SLOT_STALL_REASON =
  "采集超时：采集 Agent 在限定时间内未上报结果（常见原因：模型接口失败或进程异常）。";

export const COLLECT_SLOT_OFFLINE_REASON =
  "电脑离线：采集 Agent 所在电脑的运行时不在线，无法开始采集。";

/**
 * Safety ceiling: overdue `running` slots become `stalled`, then an
 * empty wave leaves `collecting`. A computer whose runtime is already offline
 * fails immediately — the collector never starts, so the card must not stay on
 * 「采集中」 until the stall ceiling. Called from the User-facing load path so
 * the side-chat card can settle without a separate cron.
 */
export async function settleStaleCollectRun(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; runId: string },
  nowMs: number = Date.now(),
  isComputerOnline?: (computerId: string) => Promise<boolean>,
): Promise<CollectRunView> {
  const run = await db.weeklyReportCollectRun.findFirst({
    where: {
      id: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    include: { slots: { orderBy: { computerId: "asc" } } },
  });
  if (!run) throw new AppError("NOT_FOUND");
  if (run.status !== COLLECT_RUN_STATUS.collecting || !run.startedAt) return toRunView(run);

  const offlineComputerIds = await offlineRunningComputerIds(run.slots, isComputerOnline);
  await Promise.all(
    offlineComputerIds.map((computerId) =>
      db.weeklyReportCollectSlot.updateMany({
        where: {
          runId: run.id,
          status: COLLECT_SLOT_STATUS.running,
          computerId,
        },
        data: {
          status: COLLECT_SLOT_STATUS.failed,
          failureReason: COLLECT_SLOT_OFFLINE_REASON,
          // A later submit from a queued wake must not reopen this slot.
          requestId: crypto.randomUUID(),
        },
      }),
    ),
  );

  const overdue = nowMs - run.startedAt.getTime() >= COLLECT_SLOT_STALL_MS;
  if (offlineComputerIds.length === 0 && !overdue) return toRunView(run);

  if (overdue) {
    await db.weeklyReportCollectSlot.updateMany({
      where: { runId: run.id, status: COLLECT_SLOT_STATUS.running },
      data: {
        status: COLLECT_SLOT_STATUS.stalled,
        failureReason: COLLECT_SLOT_STALL_REASON,
      },
    });
  }

  let refreshed = await db.weeklyReportCollectRun.findFirstOrThrow({
    where: { id: run.id },
    include: { slots: { orderBy: { computerId: "asc" } } },
  });

  if (refreshed.status === COLLECT_RUN_STATUS.collecting) {
    if (canSynthesizeFromSlots(refreshed.slots)) {
      await db.weeklyReportCollectRun.updateMany({
        where: { id: run.id, status: COLLECT_RUN_STATUS.collecting },
        data: { status: COLLECT_RUN_STATUS.synthesizing },
      });
    } else if (collectWaveExhausted(refreshed.slots)) {
      await db.weeklyReportCollectRun.updateMany({
        where: { id: run.id, status: COLLECT_RUN_STATUS.collecting },
        data: { status: COLLECT_RUN_STATUS.cancelled, completedAt: new Date(nowMs) },
      });
    }
    refreshed = await db.weeklyReportCollectRun.findFirstOrThrow({
      where: { id: run.id },
      include: { slots: { orderBy: { computerId: "asc" } } },
    });
  }

  return toRunView(refreshed);
}

async function offlineRunningComputerIds(
  slots: Array<{ computerId: string; status: string }>,
  isComputerOnline: ((computerId: string) => Promise<boolean>) | undefined,
): Promise<string[]> {
  if (!isComputerOnline) return [];
  const running = slots.filter((slot) => slot.status === COLLECT_SLOT_STATUS.running);
  const results = await Promise.all(
    running.map(async (slot) =>
      (await isComputerOnline(slot.computerId)) ? undefined : slot.computerId,
    ),
  );
  return results.filter((computerId): computerId is string => computerId !== undefined);
}

/** Missing or unreadable presence counts as offline, matching the Computer list. A lookup
 * failure stays online so a Redis blip cannot cancel a wave that may still be running. */
async function computerRuntimeOnline(workspaceId: string, computerId: string): Promise<boolean> {
  try {
    return await getComputerStatusCache().get({ workspaceId, computerId });
  } catch {
    return true;
  }
}

export type CollectRunSlotDetail = CollectRunSlotView & {
  packMarkdown: string | null;
  computerLabel: string;
};

export type CollectRunDetailView = Omit<CollectRunView, "slots"> & {
  slots: CollectRunSlotDetail[];
};

/** Slot view including pack body for the collapsed result UI. */
export async function getCollectRunWithPacks(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; runId: string },
): Promise<CollectRunDetailView> {
  await settleStaleCollectRun(db, input, Date.now(), (computerId) =>
    computerRuntimeOnline(input.workspaceId, computerId),
  );
  const run = await db.weeklyReportCollectRun.findFirst({
    where: {
      id: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    include: {
      slots: {
        orderBy: { computerId: "asc" },
        include: { computer: { select: { displayName: true, name: true } } },
      },
    },
  });
  if (!run) throw new AppError("NOT_FOUND");
  const base = toRunView(run);
  return {
    ...base,
    slots: run.slots.map((slot) => ({
      id: slot.id,
      computerId: slot.computerId,
      collectorAgentId: slot.collectorAgentId,
      scanPaths: asScanPaths(slot.scanPaths),
      status: slot.status,
      retryCount: slot.retryCount,
      failureReason: slot.failureReason,
      hasPack: Boolean(slot.packMarkdown && slot.packMarkdown.length > 0),
      packMarkdown: slot.packMarkdown,
      computerLabel: slot.computer.displayName || slot.computer.name || slot.computerId,
    })),
  };
}
