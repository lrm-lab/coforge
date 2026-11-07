import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  ensureCollector,
  listOwnedComputerSlots,
  type CollectorComputerSlot,
} from "./weekly-report-collector.server";
import { dispatchCollectorWakes } from "./weekly-report-collect-dispatch.server";
import {
  acceptCollectSlotReport,
  canSynthesizeFromSlots,
  COLLECT_RUN_STATUS,
  failRunningCollectSlotsForAgent,
  startCollectRun,
  type AcceptCollectSlotReportResult,
  type CollectRunComputerInput,
  type CollectWindowKind,
} from "./weekly-report-collect-run.server";
import { getCollectRunWithPacks } from "./weekly-report-collect-settlement.server";
import { loadCollectorRunMetadata } from "./weekly-report-collect-run-metadata.server";
import { resolveCollectWindow } from "#src/features/records/weekly-report-collect-window";
import { recordSideChat } from "./record-side-chat.server";
import { resolveLatestChatSessionId } from "./weekly-report-assistant-chat-session.server";
import {
  formatMemoryPromptSection,
  memoryForPrompt,
  parseStoredWeeklyReportMemory,
} from "./weekly-report-memory.server";

/** Platform→WeeklyReportAssistant synthesizer turn. */
export function buildCollectSynthesizerWakeText(input: {
  reportId: string;
  runId: string;
  slots: Array<{
    computerLabel: string;
    status: string;
    packMarkdown: string | null;
    failureReason: string | null;
  }>;
  /** Side-chat revision notes (e.g. 「更概括一些」) for a re-synthesize. */
  userGuidance?: string | null;
  memoryPrompt?: {
    writingHabits: readonly string[];
    openThreads: ReadonlyArray<{ title: string; status: "open" | "done" }>;
  };
}): string {
  const board = input.slots
    .map((slot) => {
      const detail =
        slot.status === "ready"
          ? "ready"
          : slot.failureReason
            ? `${slot.status}: ${slot.failureReason}`
            : slot.status;
      return `- ${slot.computerLabel}: ${detail}`;
    })
    .join("\n");
  const packs = input.slots
    .filter((slot) => slot.status === "ready" && slot.packMarkdown)
    .map((slot) => `### Pack · ${slot.computerLabel}\n\n${slot.packMarkdown!.trim()}`)
    .join("\n\n");
  const guidance = input.userGuidance?.trim();
  return [
    "采集已全部结束。请根据老板周报模板结构和下列采集包，整理成当前成员周报草稿。",
    "采集包应已按作者过滤；草稿只写该成员本人工作，不要扩写同事贡献。",
    "用 coforge weekly-report context / list / read 读取模板、当前报告结构，以及同一成员最近两周已提交的周报；不要重新采集本机文件。",
    "把上周未完成事项、本周完成结果和仍需延续的 Next Steps 明确串起来；没有历史内容时不要编造延续关系。",
    "在回复末尾附上 [weekly-report-suggestion] body-edit（reportId 如下）。平台收到后直接写入周报，用户可以在上一版和最新版之间切换。",
    `reportId=${input.reportId}`,
    `runId=${input.runId}`,
    ...(guidance ? ["", "## 用户调整要求", "请按下列要求重写草稿（不要忽略）：", guidance] : []),
    "",
    "## 槽位状态",
    board,
    "",
    "## 可用采集包",
    packs || "(无)",
    ...(input.memoryPrompt ? ["", formatMemoryPromptSection(input.memoryPrompt)] : []),
  ].join("\n");
}

/** Lists owned Computer collector slots for the plan card. */
export async function loadCollectPlanSlots(
  db: PrismaClient,
  input: { workspaceId: string; userId: string },
): Promise<CollectorComputerSlot[]> {
  return listOwnedComputerSlots(db, input);
}

export async function ensureCollectPlanCollector(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; computerId: string },
) {
  return ensureCollector(db, input);
}

/**
 * Submits the E2 plan: start Collect Run, wake each collector Agent via DM,
 * and post a side-chat collect-run card.
 */
export async function submitWeeklyReportCollectPlan(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    windowKind: CollectWindowKind;
    year?: number;
    week?: number;
    month?: number;
    quarter?: number;
    customStart?: string;
    customEnd?: string;
    computers: CollectRunComputerInput[];
  },
) {
  let windowStart: Date;
  let windowEnd: Date;
  let label: string;
  try {
    const resolved = resolveCollectWindow({
      kind: input.windowKind,
      year: input.year,
      week: input.week,
      month: input.month,
      quarter: input.quarter,
      customStart: input.customStart,
      customEnd: input.customEnd,
    });
    windowStart = resolved.windowStart;
    windowEnd = resolved.windowEnd;
    label = resolved.label;
  } catch {
    throw new AppError("INVALID_INPUT");
  }

  const run = await startCollectRun(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    reportId: input.reportId,
    windowKind: input.windowKind,
    windowStart,
    windowEnd,
    computers: input.computers,
  });

  const detailed = await getCollectRunWithPacks(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    runId: run.id,
  });
  const runnable = detailed.slots.filter((slot) => slot.status === "running");
  if (runnable.length === 0) {
    await recordSideChat(db).postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      body: "采集没有开始：所选电脑的运行时不在线。请让电脑上的 CoForge 保持连接后再提交。",
    });
    return detailed;
  }

  await dispatchCollectorWakes(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    reportId: input.reportId,
    runId: run.id,
    slots: runnable,
    windowStart,
    windowEnd,
  });

  await recordSideChat(db).postAssistantCollectComment({
    workspaceId: input.workspaceId,
    userId: input.userId,
    subjectType: "report",
    subjectId: input.reportId,
    body: `已开始采集（${label}）。各采集 Agent 正在对应电脑上工作；完成后可在下方展开查看采集包。`,
    payload: { kind: "collect-run", runId: run.id },
  });

  return detailed;
}

/**
 * Agent HTTPS settle path: accept pack/failure, post plain progress text (no
 * second collect-run card), and wake the WeeklyReportAssistant when synthesis
 * can start.
 */
export async function reportCollectSlotOutcome(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    computerId: string;
    requestId: string;
    runId: string;
    outcome: "ready" | "empty" | "failed";
    packMarkdown?: string;
    failureReason?: string;
  },
): Promise<AcceptCollectSlotReportResult> {
  const accepted = await acceptCollectSlotReport(db, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    requestId: input.requestId,
    runId: input.runId,
    outcome: input.outcome,
    packMarkdown: input.packMarkdown,
    failureReason: input.failureReason,
  });

  if (!accepted.newlyAccepted) return accepted;

  const runMeta = await db.weeklyReportCollectRun.findFirst({
    where: { id: input.runId, workspaceId: input.workspaceId },
    select: { reportId: true, userId: true },
  });
  if (!runMeta) return accepted;

  const computer = await db.computer.findFirst({
    where: { id: input.computerId },
    select: { displayName: true, name: true },
  });
  const label = computer?.displayName || computer?.name || input.computerId;

  if (accepted.synthesisStarted) {
    // One user-visible progress line: collect→synthesize handoff. Per-slot
    // "已就绪" is redundant when this accept already finishes the wave.
    await recordSideChat(db).postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: "采集已完成，正在整理周报草稿，请稍候确认。",
    });
    await wakeCollectSynthesizer(db, {
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      reportId: runMeta.reportId,
      runId: input.runId,
    });
  } else if (accepted.waveExhausted || (accepted.run.allTerminal && !accepted.run.canSynthesize)) {
    await recordSideChat(db).postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: "采集结束，但没有可用的采集包，无法生成周报草稿。请检查采集 Agent 的模型配置后重新提交采集计划。",
    });
  } else if (input.outcome === "ready") {
    await recordSideChat(db).postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: `采集包 · ${label} 已就绪。`,
    });
  } else if (input.outcome === "empty") {
    await recordSideChat(db).postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: `采集 · ${label} 未找到可用证据。`,
    });
  } else {
    await recordSideChat(db).postAssistantCollectComment({
      workspaceId: input.workspaceId,
      userId: runMeta.userId,
      subjectType: "report",
      subjectId: runMeta.reportId,
      body: `采集 · ${label} 失败${input.failureReason ? `：${input.failureReason}` : "。"}`,
    });
  }

  return accepted;
}

/**
 * When a collector turn fails before HTTPS submit (model 405, crash, …), mark
 * every still-running slot for that Agent failed and post the same side-chat
 * progress lines as an explicit submit-failure.
 */
export async function reportCollectorRuntimeFailure(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    computerId: string;
    requestId: string;
    failureReason: string;
  },
): Promise<{ accepted: AcceptCollectSlotReportResult[]; slotCount: number }> {
  const failed = await failRunningCollectSlotsForAgent(db, input);
  if (failed.slotCount === 0) return failed;

  const computer = await db.computer.findFirst({
    where: { id: input.computerId },
    select: { displayName: true, name: true },
  });
  const label = computer?.displayName || computer?.name || input.computerId;
  const reason = input.failureReason.trim() || "collector runtime failed";
  const runMetadata = await loadCollectorRunMetadata(db, {
    workspaceId: input.workspaceId,
    runIds: failed.accepted
      .filter((accepted) => accepted.newlyAccepted)
      .map((accepted) => accepted.run.id),
  });

  for (const accepted of failed.accepted) {
    if (!accepted.newlyAccepted) continue;
    const runMeta = runMetadata.get(accepted.run.id) ?? null;
    if (!runMeta) continue;
    if (accepted.synthesisStarted) {
      await recordSideChat(db).postAssistantCollectComment({
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        subjectType: "report",
        subjectId: runMeta.reportId,
        body: "采集已完成，正在整理周报草稿，请稍候确认。",
      });
      await wakeCollectSynthesizer(db, {
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        reportId: runMeta.reportId,
        runId: accepted.run.id,
      });
    } else if (accepted.waveExhausted) {
      await recordSideChat(db).postAssistantCollectComment({
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        subjectType: "report",
        subjectId: runMeta.reportId,
        body: "采集结束，但没有可用的采集包，无法生成周报草稿。请检查采集 Agent 的模型配置后重新提交采集计划。",
      });
    } else {
      await recordSideChat(db).postAssistantCollectComment({
        workspaceId: input.workspaceId,
        userId: runMeta.userId,
        subjectType: "report",
        subjectId: runMeta.reportId,
        body: `采集 · ${label} 失败：${reason}`,
      });
    }
  }

  return failed;
}

async function wakeCollectSynthesizer(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    runId: string;
    sessionId?: string | null;
    userGuidance?: string | null;
  },
) {
  const detailed = await getCollectRunWithPacks(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    runId: input.runId,
  });
  const sessionId =
    input.sessionId ??
    (await resolveLatestChatSessionId(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
    }));
  const assistant = await db.weeklyReportAssistant.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
    select: { memory: true },
  });
  const { openWeeklyReportAssistantChat } = await import("./weekly-report-assistant-chat.server");
  const chat = openWeeklyReportAssistantChat(db);
  await chat.postRequest({
    workspaceId: input.workspaceId,
    userId: input.userId,
    requestId: crypto.randomUUID(),
    subjectType: "report",
    subjectId: input.reportId,
    sessionId,
    platformTurn: true,
    body: buildCollectSynthesizerWakeText({
      reportId: input.reportId,
      runId: input.runId,
      userGuidance: input.userGuidance,
      memoryPrompt: memoryForPrompt(parseStoredWeeklyReportMemory(assistant?.memory)),
      slots: detailed.slots.map((slot) => ({
        computerLabel: slot.computerLabel,
        status: slot.status,
        packMarkdown: slot.packMarkdown,
        failureReason: slot.failureReason,
      })),
    }),
  });
}

/**
 * Side-chat 「整理周报」: wake the WeeklyReportAssistant from the latest ready
 * Collect Run packs without starting a new harvest.
 */
export async function requestWeeklyReportSynthesis(
  db: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    sessionId?: string | null;
    userGuidance?: string | null;
  },
): Promise<{ ok: true; runId: string } | { ok: false; reason: "no_packs" }> {
  const runs = await db.weeklyReportCollectRun.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: input.reportId,
    },
    orderBy: { createdAt: "desc" },
    include: { slots: true },
    take: 10,
  });
  const usable = runs.find((run) => canSynthesizeFromSlots(run.slots));
  if (!usable) return { ok: false, reason: "no_packs" };

  await db.weeklyReportCollectRun.update({
    where: { id: usable.id },
    data: { status: COLLECT_RUN_STATUS.synthesizing },
  });
  await wakeCollectSynthesizer(db, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    reportId: input.reportId,
    runId: usable.id,
    sessionId: input.sessionId,
    userGuidance: input.userGuidance,
  });
  return { ok: true, runId: usable.id };
}
