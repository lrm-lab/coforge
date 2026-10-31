import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AppError } from "#src/lib/app-error";
import { recordCatalog } from "#src/server/records/record-catalog.server";
import {
  ensureWeeklyReportAssistant,
  WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
} from "#src/server/records/weekly-report-assistant.server";
import { openWeeklyReportAssistantChat } from "#src/server/records/weekly-report-assistant-chat.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { looksLikeMemberReportRuleIntent } from "./weekly-highlight-extract";

// The Records side chat's server functions: the viewer's weekly report assistant, the chat's
// sessions and messages, and the suggestions it makes.

export const loadWeeklyReportAssistantStatus = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return readWeeklyReportAssistantStatus(db, user.id, workspaceId);
  });

async function readWeeklyReportAssistantStatus(
  db: Parameters<typeof recordCatalog>[0],
  userId: string,
  workspaceId: string,
) {
  const assistant = await ensureWeeklyReportAssistant(db, {
    workspaceId,
    userId,
  });
  const agent = await db.agent.findUnique({
    where: { id_workspaceId: { id: assistant.agentId, workspaceId } },
    select: { ownerId: true, computerId: true, runtimeConfig: true },
  });
  if (!agent || agent.ownerId !== userId) throw new AppError("ACCESS_DENIED");
  const runtimeConfig = normalizeAgentRuntimeConfig(agent.runtimeConfig);
  return {
    assistantId: assistant.id,
    agentId: assistant.agentId,
    displayName: WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
    computerConfigured: Boolean(agent.computerId),
    runtimeConfigured:
      runtimeConfig.runtime !== "coforge" ||
      (runtimeConfig.provider.kind === "coforge" && Boolean(runtimeConfig.provider.apiKey)),
    runtime: runtimeConfig.runtime,
  };
}

function normalizeAgentRuntimeConfig(value: unknown) {
  try {
    return parseAgentRuntimeConfig(value);
  } catch {
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  }
}

export const addRecordComment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.uuid(),
      body: z.string().trim().min(1).max(4000),
      assistantSessionId: z.uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).postSideChat({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      body: data.body,
      assistantSessionId: data.assistantSessionId,
    });
  });

function weeklyReportAssistantChat(db: Parameters<typeof recordCatalog>[0]) {
  return openWeeklyReportAssistantChat(db);
}

export const ensureWeeklyReportAssistantChatSessions = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { ensureWeeklyReportAssistantChatSession } =
      await import("#src/server/records/weekly-report-assistant-chat-session.server");
    return ensureWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
    });
  });

export const createWeeklyReportAssistantChatSessionFn = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.uuid(),
      title: z.string().max(80).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { createWeeklyReportAssistantChatSession } =
      await import("#src/server/records/weekly-report-assistant-chat-session.server");
    return createWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      title: data.title,
    });
  });

export const renameWeeklyReportAssistantChatSessionFn = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      sessionId: z.uuid(),
      title: z.string().trim().min(1).max(80),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { renameWeeklyReportAssistantChatSession } =
      await import("#src/server/records/weekly-report-assistant-chat-session.server");
    return renameWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
      title: data.title,
    });
  });

export const archiveWeeklyReportAssistantChatSessionFn = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ sessionId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { archiveWeeklyReportAssistantChatSession } =
      await import("#src/server/records/weekly-report-assistant-chat-session.server");
    return archiveWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
    });
  });

export const postWeeklyReportAssistantRequest = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.uuid(),
      sessionId: z.uuid(),
      body: z.string().trim().min(1).max(4000),
      requestId: z.uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const { requireOwnedChatSession, touchWeeklyReportAssistantChatSession } =
      await import("#src/server/records/weekly-report-assistant-chat-session.server");
    await requireOwnedChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
    });
    if (data.subjectType === "report" && looksLikeMemberReportRuleIntent(data.body)) {
      const comments = await recordCatalog(db).postMemberReportRuleSideChatIfApplicable({
        workspaceId,
        userId: user.id,
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        body: data.body,
        assistantSessionId: data.sessionId,
      });
      if (comments) {
        await touchWeeklyReportAssistantChatSession(db, {
          workspaceId,
          userId: user.id,
          sessionId: data.sessionId,
          title: data.body,
        });
        return { kind: "rule" as const, comments };
      }
    }
    const status = await readWeeklyReportAssistantStatus(db, user.id, workspaceId);
    if (!status.computerConfigured || !status.runtimeConfigured) {
      return { kind: "needs_setup" as const, status };
    }
    const posted = await weeklyReportAssistantChat(db).postRequest({
      workspaceId,
      userId: user.id,
      requestId: data.requestId,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      sessionId: data.sessionId,
      body: data.body,
    });
    await touchWeeklyReportAssistantChatSession(db, {
      workspaceId,
      userId: user.id,
      sessionId: data.sessionId,
      title: data.body,
    });
    return { kind: "agent" as const, ...posted };
  });

export const loadWeeklyReportAssistantMessages = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.uuid(),
      sessionId: z.uuid(),
      includeLegacyUnscoped: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return weeklyReportAssistantChat(db).listMessages({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      sessionId: data.sessionId,
      includeLegacyUnscoped: data.includeLegacyUnscoped,
    });
  });

export const ensureRecordAssistantIntro = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.uuid(),
      assistantSessionId: z.uuid(),
      surface: z.enum(["format", "member-leader", "member-assignee", "plain"]),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).ensureAssistantIntro({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      assistantSessionId: data.assistantSessionId,
      surface: data.surface,
    });
  });

export const dismissWeeklyFormatSend = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      assistantSessionId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).dismissWeeklyFormatSend({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
    });
  });

export const acceptMemberGenerateHelp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      assistantSessionId: z.uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).acceptMemberGenerateHelp({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
    });
  });

export const confirmMemberReportIntent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      assistantSessionId: z.uuid(),
      intent: z.enum(["collect-again", "synthesize"]),
      userGuidance: z.string().max(4000).optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).confirmMemberReportIntent({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
      intent: data.intent,
      userGuidance: data.userGuidance,
    });
  });

export const declineMemberReportIntent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      assistantSessionId: z.uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const declined = await recordCatalog(db).declineMemberReportIntent({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      assistantSessionId: data.assistantSessionId,
    });
    let forwarded = false;
    const original = declined.originalUserText?.trim();
    if (original) {
      const status = await readWeeklyReportAssistantStatus(db, user.id, workspaceId);
      if (status.computerConfigured && status.runtimeConfigured) {
        const { touchWeeklyReportAssistantChatSession } =
          await import("#src/server/records/weekly-report-assistant-chat-session.server");
        await weeklyReportAssistantChat(db).postRequest({
          workspaceId,
          userId: user.id,
          requestId: crypto.randomUUID(),
          subjectType: "report",
          subjectId: data.reportId,
          sessionId: data.assistantSessionId,
          body: original,
        });
        await touchWeeklyReportAssistantChatSession(db, {
          workspaceId,
          userId: user.id,
          sessionId: data.assistantSessionId,
          title: original,
        });
        forwarded = true;
      }
    }
    return { comments: declined.comments, forwarded };
  });
