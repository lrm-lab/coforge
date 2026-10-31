import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";

import { recordCatalog } from "#src/server/records/record-catalog.server";
import { normalizeReportContent, type ReportContent } from "./records-content";

export const loadRecordsNavAttention = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadNavAttention({ workspaceId, userId: user.id });
  });

const reportContentSchema: z.ZodType<ReportContent> = z.object({
  tabs: z.record(z.string(), z.object({ markdown: z.string() })),
  markdown: z.string().optional(),
  assignment: z.object({ unread: z.boolean() }).optional(),
});

export const loadRecordsCatalog = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadCatalog({ workspaceId, userId: user.id });
  });

export const deleteMemberWeeklyReport = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteMemberReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const setWeeklyReportFavorite = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      favorited: z.boolean(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).setReportFavorite({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      favorited: data.favorited,
    });
  });

/** Deletes the Leader overview week node without removing member or favorited reports. */
export const deleteOverviewReport = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteOverviewReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

/** Deletes the viewer's member-week node (templates + submissions). */
export const deleteMemberWeek = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ cycleId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteMemberWeek({
      workspaceId,
      userId: user.id,
      cycleId: data.cycleId,
    });
  });

export const loadRecordSubject = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).getSubject({ workspaceId, userId: user.id, id: data.id });
  });

export const loadWeeklyReportAssistantContext = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      subjectType: z.enum(["report", "cycle"]),
      subjectId: z.uuid(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadAssistantContextManifest({
      workspaceId,
      userId: user.id,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
    });
  });

export const createRecordNote = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ title: z.string().trim().max(200).optional() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).createNote({
      workspaceId,
      userId: user.id,
      title: data.title,
    });
  });

export const saveRecordNote = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      noteId: z.uuid(),
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveNote({
      workspaceId,
      userId: user.id,
      noteId: data.noteId,
      title: data.title,
      body: data.body,
    });
  });

export const deleteRecordNote = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ noteId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteNote({
      workspaceId,
      userId: user.id,
      noteId: data.noteId,
    });
  });

export const saveWeeklyReportContent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      content: reportContentSchema,
      status: z.enum(["draft", "submitted", "shared"]).optional(),
      askToSend: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveReportContent({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      content: normalizeReportContent(data.content),
      status: data.status,
      askToSend: data.askToSend,
    });
  });

export const updateFormatReportMeta = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      title: z.string().trim().min(1),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).updateFormatReportMeta({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      title: data.title,
    });
  });

export const markWeeklyAssignmentOpened = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).markAssignmentOpened({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const confirmWeeklyReportSend = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).confirmPromptedSend({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const sendWeeklyReportAssignments = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      sourceReportId: z.uuid(),
      content: z.unknown().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).sendWeeklyAssignments({
      workspaceId,
      userId: user.id,
      sourceReportId: data.sourceReportId,
      content: data.content === undefined ? undefined : normalizeReportContent(data.content),
    });
  });

export const applyConfirmedWeeklyReportBody = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      content: reportContentSchema,
      sourceMessageId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).applyConfirmedReportBody({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      content: normalizeReportContent(data.content),
      sourceMessageId: data.sourceMessageId,
    });
  });

export const switchWeeklyReportBodyVersion = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).switchWeeklyReportBodyVersion({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const applyConfirmedKeyPointMarkdown = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      reportId: z.uuid(),
      markdown: z.string().trim().min(1).max(100_000),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).applyConfirmedKeyPointMarkdown({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
      markdown: data.markdown,
    });
  });

export const dismissKeyPointConfirmDraft = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).dismissKeyPointConfirmDraft({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const loadWeeklyTemplates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).listTemplates({ workspaceId, userId: user.id });
  });

export const loadWeeklyTemplateForReport = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadTemplateForReport({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const loadKeyPointPrompts = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadKeyPointPrompts({ workspaceId, userId: user.id });
  });

export const saveKeyPointPrompts = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      slot: z.enum(["team", "personal"]),
      text: z.string(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).saveKeyPointPrompts({
      workspaceId,
      userId: user.id,
      slot: data.slot,
      text: data.text,
    });
  });

export const deleteKeyPointPromptHistory = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      slot: z.enum(["team", "personal"]),
      historyIndex: z.number().int().min(0),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteKeyPointPromptHistory({
      workspaceId,
      userId: user.id,
      slot: data.slot,
      historyIndex: data.historyIndex,
    });
  });

export const restartPersonalKeyPointExtraction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ reportId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).restartPersonalKeyPointExtraction({
      workspaceId,
      userId: user.id,
      reportId: data.reportId,
    });
  });

export const startTeamKeyPointExtraction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      overviewReportId: z.uuid(),
      force: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).startTeamKeyPointExtraction({
      workspaceId,
      userId: user.id,
      overviewReportId: data.overviewReportId,
      force: data.force,
    });
  });

export const applyWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ templateId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).applyTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
  });

const templateSectionSchema = z.object({
  title: z.string(),
  children: z.array(z.string()),
});

export const createWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      name: z.string().trim().min(1),
      frequency: z.literal("weekly"),
      sendTime: z.string().min(1),
      sendWeekday: z.number().int().min(1).max(7),
      scheduleEnabled: z.boolean(),
      sections: z.array(templateSectionSchema),
      allMembers: z.boolean(),
      recipientUserIds: z.array(z.uuid()),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).createTemplate({ workspaceId, userId: user.id, ...data });
  });

export const updateWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      templateId: z.uuid(),
      name: z.string().trim().min(1),
      frequency: z.literal("weekly"),
      sendTime: z.string().min(1),
      sendWeekday: z.number().int().min(1).max(7),
      scheduleEnabled: z.boolean(),
      sections: z.array(templateSectionSchema),
      allMembers: z.boolean(),
      recipientUserIds: z.array(z.uuid()),
    }),
  )
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).updateTemplate({
      workspaceId,
      userId: user.id,
      ...data,
    });
  });

export const deleteWeeklyTemplate = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ templateId: z.uuid() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).deleteTemplate({
      workspaceId,
      userId: user.id,
      templateId: data.templateId,
    });
  });

export const loadWeeklyReportStats = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadStats({
      workspaceId,
      userId: user.id,
      year: data.year,
      month: data.month,
    });
  });

export const loadWeeklyReportDashboard = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ limit: z.number().int().min(2).max(12).optional() }))
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    return recordCatalog(db).loadWeeklyReportDashboard({
      workspaceId,
      userId: user.id,
      limit: data.limit,
    });
  });
