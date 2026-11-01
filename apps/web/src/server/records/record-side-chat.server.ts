import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  looksLikeCollectAgainRequest,
  looksLikeMemberGenerateOfferAccept,
  looksLikeMemberReportRuleIntent,
  looksLikeSynthesizeWeeklyReportRequest,
  parseRecordAssistantPayload,
  type RecordAssistantPayload,
} from "#src/features/records/weekly-highlight-extract";
import { requireMembership } from "./record-catalog-access.server";
import { REPORT_PERSON_SELECT, reportPersonView } from "./record-member-weeks.server";

type Db = PrismaClient;

export function recordSideChat(db: Db) {
  async function writeAssistantComment(input: {
    workspaceId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    payload?: RecordAssistantPayload;
    assistantSessionId?: string | null;
  }) {
    return db.recordComment.create({
      data: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        authorType: "assistant",
        authorUserId: null,
        body: input.body,
        assistantSessionId: input.assistantSessionId ?? null,
        ...(input.payload ? { payload: input.payload as unknown as Prisma.InputJsonValue } : {}),
        reportId: input.subjectType === "report" ? input.subjectId : null,
        cycleId: input.subjectType === "cycle" ? input.subjectId : null,
      },
    });
  }

  async function postSideChat(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    assistantSessionId: string;
  }) {
    await addUserComment(input);
    if (input.subjectType === "report" && looksLikeMemberGenerateOfferAccept(input.body)) {
      const assignment = await db.weeklyReport.findFirst({
        where: {
          id: input.subjectId,
          workspaceId: input.workspaceId,
          kind: "member",
          authorId: input.userId,
        },
        select: {
          id: true,
          cycle: { select: { year: true, week: true } },
        },
      });
      if (assignment) {
        await writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: "好的，请确认数据采集的相关设置，以帮助你生成更全面的周报。",
          payload: {
            kind: "collect-plan",
            reportId: assignment.id,
            year: assignment.cycle.year,
            week: assignment.cycle.week,
          },
        });
      }
    } else if (input.subjectType === "report" && looksLikeCollectAgainRequest(input.body)) {
      const assignment = await loadMemberAssignmentForSideChat(input);
      if (assignment) {
        await writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: "要重新采集一遍工作证据吗？确认后会打开采集设置卡。",
          payload: {
            kind: "confirm-intent",
            intent: "collect-again",
            reportId: assignment.id,
            year: assignment.year,
            week: assignment.week,
            userGuidance: input.body.trim(),
          },
        });
      }
    } else if (
      input.subjectType === "report" &&
      looksLikeSynthesizeWeeklyReportRequest(input.body)
    ) {
      const assignment = await loadMemberAssignmentForSideChat(input);
      if (assignment) {
        await writeAssistantComment({
          workspaceId: input.workspaceId,
          subjectType: "report",
          subjectId: input.subjectId,
          assistantSessionId: input.assistantSessionId,
          body: "要根据已有采集包整理一份周报草稿吗？",
          payload: {
            kind: "confirm-intent",
            intent: "synthesize",
            reportId: assignment.id,
            year: assignment.year,
            week: assignment.week,
            userGuidance: input.body.trim(),
          },
        });
      }
    }
    return listComments(input);
  }

  /**
   * Applies member-assignee platform rules only when the subject is that user's
   * member report. Overview / other subjects return null so the caller can fall
   * through to the Agent DM (e.g. 「重新整理」 for team key points).
   */
  async function postMemberReportRuleSideChatIfApplicable(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    assistantSessionId: string;
  }) {
    if (input.subjectType !== "report") return null;
    if (!looksLikeMemberReportRuleIntent(input.body)) return null;
    const assignment = await loadMemberAssignmentForSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectId: input.subjectId,
    });
    if (!assignment) return null;
    return postSideChat(input);
  }

  async function loadMemberAssignmentForSideChat(input: {
    workspaceId: string;
    userId: string;
    subjectId: string;
  }) {
    const assignment = await db.weeklyReport.findFirst({
      where: {
        id: input.subjectId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: {
        id: true,
        cycle: { select: { year: true, week: true } },
      },
    });
    if (!assignment) return null;
    return {
      id: assignment.id,
      year: assignment.cycle.year,
      week: assignment.cycle.week,
    };
  }

  /** User confirms a regex-matched side-chat intent (collect-again / synthesize). */
  async function confirmMemberReportIntent(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId: string;
    intent: "collect-again" | "synthesize";
    userGuidance?: string | null;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const assignment = await loadMemberAssignmentForSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectId: input.reportId,
    });
    if (!assignment) throw new AppError("NOT_FOUND");

    await addUserComment({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      body: "确认",
      assistantSessionId: input.assistantSessionId,
    });

    if (input.intent === "collect-again") {
      await writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        body: "好的，请确认采集设置后提交。",
        payload: {
          kind: "collect-plan",
          reportId: assignment.id,
          year: assignment.year,
          week: assignment.week,
        },
      });
      return listComments({
        workspaceId: input.workspaceId,
        userId: input.userId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
      });
    }

    const guidance =
      input.userGuidance?.trim() ||
      (await latestConfirmIntentOriginalText({
        workspaceId: input.workspaceId,
        reportId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        intent: "synthesize",
      }));

    const { requestWeeklyReportSynthesis } =
      await import("./weekly-report-collect-orchestrate.server");
    const synthesis = await requestWeeklyReportSynthesis(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      reportId: assignment.id,
      sessionId: input.assistantSessionId,
      userGuidance: guidance,
    });
    if (synthesis.ok) {
      await writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        body: "好的，正在根据已有采集包整理周报草稿，请稍候确认。",
      });
    } else {
      await writeAssistantComment({
        workspaceId: input.workspaceId,
        subjectType: "report",
        subjectId: input.reportId,
        assistantSessionId: input.assistantSessionId,
        body: "目前还没有可用的采集包。请先确认采集设置；采集完成后再整理。",
        payload: {
          kind: "collect-plan",
          reportId: assignment.id,
          year: assignment.year,
          week: assignment.week,
        },
      });
    }
    return listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      assistantSessionId: input.assistantSessionId,
    });
  }

  /**
   * Recover the original user utterance for a confirm-intent card.
   * Prefer stored `userGuidance`; otherwise the preceding user comment.
   */
  async function latestConfirmIntentOriginalText(input: {
    workspaceId: string;
    reportId: string;
    assistantSessionId: string;
    intent?: "collect-again" | "synthesize";
  }): Promise<string | null> {
    const rows = await db.recordComment.findMany({
      where: {
        workspaceId: input.workspaceId,
        reportId: input.reportId,
        assistantSessionId: input.assistantSessionId,
      },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { authorType: true, body: true, payload: true },
    });
    let seekingPrecedingUser = false;
    for (const row of rows) {
      if (!seekingPrecedingUser) {
        if (row.authorType !== "assistant") continue;
        const payload = parseRecordAssistantPayload(row.payload);
        if (payload?.kind !== "confirm-intent") continue;
        if (input.intent && payload.intent !== input.intent) continue;
        const guided = payload.userGuidance?.trim();
        if (guided) return guided;
        seekingPrecedingUser = true;
        continue;
      }
      if (row.authorType !== "user") continue;
      const body = row.body.trim();
      if (!body || body === "确认" || body === "不是") continue;
      return body;
    }
    return null;
  }

  /**
   * User declines a regex-matched side-chat intent.
   * Recover the original utterance so the caller can forward it to the Agent
   * (bypass rule path) instead of ending the turn.
   */
  async function declineMemberReportIntent(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const assignment = await loadMemberAssignmentForSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectId: input.reportId,
    });
    if (!assignment) throw new AppError("NOT_FOUND");

    const originalUserText = await latestConfirmIntentOriginalText({
      workspaceId: input.workspaceId,
      reportId: input.reportId,
      assistantSessionId: input.assistantSessionId,
    });

    await addUserComment({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      body: "不是",
      assistantSessionId: input.assistantSessionId,
    });
    await writeAssistantComment({
      workspaceId: input.workspaceId,
      subjectType: "report",
      subjectId: input.reportId,
      assistantSessionId: input.assistantSessionId,
      body: originalUserText
        ? "好的，我按你刚才的问题继续回答。"
        : "好的。需要采集或整理周报时再说一声。",
      payload: { kind: "intent-declined" },
    });
    const comments = await listComments({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: input.reportId,
      assistantSessionId: input.assistantSessionId,
    });
    return { comments, originalUserText };
  }

  async function listComments(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    assistantSessionId?: string | null;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const where =
      input.subjectType === "report" ? { reportId: input.subjectId } : { cycleId: input.subjectId };
    const rows = await db.recordComment.findMany({
      where: {
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        ...where,
        ...(input.assistantSessionId ? { assistantSessionId: input.assistantSessionId } : {}),
      },
      orderBy: { createdAt: "asc" },
      include: {
        authorUser: {
          select: REPORT_PERSON_SELECT,
        },
      },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      authorType: row.authorType,
      body: row.body,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
      author: row.authorUser ? reportPersonView(input.workspaceId, row.authorUser) : null,
    }));
  }

  async function acceptMemberGenerateHelp(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    assistantSessionId: string;
  }) {
    /** Assignee's 「需要」 choice posts the E2 clarifying reply and collect-plan card. */
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
        authorId: input.userId,
      },
      select: { id: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    return postSideChat({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: "report",
      subjectId: report.id,
      assistantSessionId: input.assistantSessionId,
      body: "需要",
    });
  }

  async function postAssistantCollectComment(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    payload?: RecordAssistantPayload;
    assistantSessionId?: string | null;
  }) {
    /** Platform-owned progress bubble for collector progress and packs. */
    const { resolveLatestChatSessionId } =
      await import("./weekly-report-assistant-chat-session.server");
    const assistantSessionId =
      input.assistantSessionId ??
      (await resolveLatestChatSessionId(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      }));
    await writeAssistantComment({ ...input, assistantSessionId });
    return listComments({ ...input, assistantSessionId });
  }

  async function addUserComment(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    body: string;
    assistantSessionId?: string | null;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const body = input.body.trim();
    if (!body) throw new AppError("INVALID_INPUT");
    const data = {
      workspaceId: input.workspaceId,
      subjectType: input.subjectType,
      authorType: "user",
      authorUserId: input.userId,
      body,
      assistantSessionId: input.assistantSessionId ?? null,
      reportId: input.subjectType === "report" ? input.subjectId : null,
      cycleId: input.subjectType === "cycle" ? input.subjectId : null,
    };
    const created = await db.recordComment.create({ data });
    return { id: created.id, createdAt: created.createdAt.toISOString() };
  }

  return {
    postSideChat,
    postMemberReportRuleSideChatIfApplicable,
    confirmMemberReportIntent,
    declineMemberReportIntent,
    acceptMemberGenerateHelp,
    postAssistantCollectComment,
    listComments,
    addUserComment,
  };
}
