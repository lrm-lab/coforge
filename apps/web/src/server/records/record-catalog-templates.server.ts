import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import {
  isHourlySendTime,
  isValidTemplateName,
  normalizeReportContent,
} from "#src/features/records/records-content";
import {
  parseTemplateSections,
  type TemplateOutlineSection,
} from "#src/features/records/template-outline-sections";
import { requireMembership, requireWeeklyReportLeader } from "./record-catalog-access.server";
import { ensureFormatForSettings } from "./record-catalog-format.server";

type Db = PrismaClient;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function templateListItem(template: {
  id: string;
  name: string;
  frequency: string;
  sendTime: string;
  sendWeekday: number;
  dimensions: unknown;
  mainTitles: unknown;
  allMembers: boolean;
  applied: boolean;
  scheduleEnabled: boolean;
  updatedAt: Date;
  recipients: Array<{
    user: { id: string; username: string; displayName: string | null };
  }>;
}) {
  return {
    id: template.id,
    name: template.name,
    frequency: template.frequency,
    sendTime: template.sendTime,
    sendWeekday: template.sendWeekday,
    dimensions: asStringArray(template.dimensions),
    mainTitles: asStringArray(template.mainTitles),
    sections: parseTemplateSections(template.dimensions),
    allMembers: template.allMembers,
    active: template.applied,
    scheduleEnabled: template.scheduleEnabled,
    updatedAt: template.updatedAt.toISOString(),
    recipients: template.recipients.map((row) => ({
      userId: row.user.id,
      username: row.user.username,
      displayName: humanLabel(row.user),
    })),
  };
}

type TemplateInput = {
  name: string;
  frequency: "weekly";
  sendTime: string;
  sendWeekday: number;
  scheduleEnabled: boolean;
  sections: TemplateOutlineSection[];
  allMembers: boolean;
  recipientUserIds: string[];
};

/** The columns a template create or update writes from validated input. */
function templateWriteData(input: TemplateInput, sections: TemplateOutlineSection[]) {
  return {
    name: input.name.trim(),
    frequency: input.frequency,
    sendTime: input.sendTime,
    sendWeekday: input.sendWeekday,
    applied: input.scheduleEnabled,
    scheduleEnabled: input.scheduleEnabled,
    dimensions: sections as unknown as Prisma.InputJsonValue,
    mainTitles: [] as string[],
    allMembers: input.allMembers,
    recipients: input.allMembers
      ? undefined
      : { create: input.recipientUserIds.map((userId) => ({ userId })) },
  };
}

export function recordTemplates(db: Db) {
  async function resolvePromptFormatDoc(input: { workspaceId: string; userId: string }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const settings = await db.weeklyReportTemplate.findFirst({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      select: { id: true, name: true, dimensions: true },
    });
    if (!settings) return null;
    const linked = await ensureFormatForSettings(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: settings.id,
      settingsName: settings.name,
      sections: parseTemplateSections(settings.dimensions),
    });
    return db.weeklyReport.findFirst({
      where: { id: linked.id },
      select: { id: true, content: true },
    });
  }

  async function validateTemplateInput(input: TemplateInput & { workspaceId: string }) {
    if (!isValidTemplateName(input.name)) throw new AppError("INVALID_INPUT");
    if (input.sendWeekday < 1 || input.sendWeekday > 7) throw new AppError("INVALID_INPUT");
    if (!isHourlySendTime(input.sendTime)) throw new AppError("INVALID_INPUT");
    if (!input.allMembers && input.recipientUserIds.length > 0) {
      const members = await db.workspaceMembership.count({
        where: {
          workspaceId: input.workspaceId,
          userId: { in: input.recipientUserIds },
        },
      });
      if (members !== input.recipientUserIds.length) throw new AppError("INVALID_INPUT");
    }
    return { sections: parseTemplateSections(input.sections), enabled: input.scheduleEnabled };
  }

  async function listTemplates(input: { workspaceId: string; userId: string }) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const templates = await db.weeklyReportTemplate.findMany({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      include: {
        recipients: {
          include: { user: { select: { id: true, username: true, displayName: true } } },
        },
      },
    });
    return templates.map((template) => templateListItem(template));
  }

  /** Settings row behind a viewer's own format, for the template-detail dialog. */

  async function loadTemplateForReport(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        authorId: input.userId,
        kind: "template",
      },
      select: { settingsId: true },
    });
    if (!report?.settingsId) throw new AppError("NOT_FOUND");
    const template = await db.weeklyReportTemplate.findFirst({
      where: {
        id: report.settingsId,
        workspaceId: input.workspaceId,
        ownerId: input.userId,
      },
      include: {
        recipients: {
          include: { user: { select: { id: true, username: true, displayName: true } } },
        },
      },
    });
    if (!template) throw new AppError("NOT_FOUND");
    return templateListItem(template);
  }

  /**
   * Leader-owned team/personal key-point prompts (stored on a live format document).
   * Uses the newest applied settings stream, else the newest owned settings row.
   */

  async function loadKeyPointPrompts(input: { workspaceId: string; userId: string }) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const { emptyKeyPointPrompts } = await import("#src/features/records/records-content");
    const format = await resolvePromptFormatDoc(input);
    if (!format) return emptyKeyPointPrompts();
    return normalizeReportContent(format.content).keyPointPrompts ?? emptyKeyPointPrompts();
  }

  async function saveKeyPointPrompts(input: {
    workspaceId: string;
    userId: string;
    slot: "team" | "personal";
    text: string;
  }) {
    const { emptyKeyPointPrompts, withKeyPointPrompts } =
      await import("#src/features/records/records-content");
    const { mergeKeyPointPromptSlot } = await import("./weekly-report-key-points.server");
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const settings = await db.weeklyReportTemplate.findFirst({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      select: { id: true, name: true, dimensions: true },
    });
    if (!settings) throw new AppError("NOT_FOUND");
    const format = await ensureFormatForSettings(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: settings.id,
      settingsName: settings.name,
      sections: parseTemplateSections(settings.dimensions),
    });
    const row = await db.weeklyReport.findFirst({
      where: { id: format.id },
      select: { content: true },
    });
    if (!row) throw new AppError("NOT_FOUND");
    const content = normalizeReportContent(row.content);
    const current = content.keyPointPrompts ?? emptyKeyPointPrompts();
    // Preserve the caller's text exactly (including empty / trailing newlines).
    const nextPrompts = mergeKeyPointPromptSlot(current, input.slot, input.text);
    const next = withKeyPointPrompts(content, nextPrompts);
    const updated = await db.weeklyReport.update({
      where: { id: format.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
      select: { content: true },
    });
    return normalizeReportContent(updated.content).keyPointPrompts ?? nextPrompts;
  }

  async function deleteKeyPointPromptHistory(input: {
    workspaceId: string;
    userId: string;
    slot: "team" | "personal";
    historyIndex: number;
  }) {
    const { emptyKeyPointPrompts, removeKeyPointPromptHistoryEntry, withKeyPointPrompts } =
      await import("#src/features/records/records-content");
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const settings = await db.weeklyReportTemplate.findFirst({
      where: { workspaceId: input.workspaceId, ownerId: input.userId },
      orderBy: [{ applied: "desc" }, { updatedAt: "desc" }],
      select: { id: true, name: true, dimensions: true },
    });
    if (!settings) throw new AppError("NOT_FOUND");
    const format = await ensureFormatForSettings(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: settings.id,
      settingsName: settings.name,
      sections: parseTemplateSections(settings.dimensions),
    });
    const row = await db.weeklyReport.findFirst({
      where: { id: format.id },
      select: { content: true },
    });
    if (!row) throw new AppError("NOT_FOUND");
    const content = normalizeReportContent(row.content);
    const current = content.keyPointPrompts ?? emptyKeyPointPrompts();
    const nextPrompts = {
      ...current,
      [input.slot]: removeKeyPointPromptHistoryEntry(current[input.slot], input.historyIndex),
    };
    await db.weeklyReport.update({
      where: { id: format.id },
      data: {
        content: withKeyPointPrompts(content, nextPrompts) as unknown as Prisma.InputJsonValue,
      },
    });
    return nextPrompts;
  }

  /** Leader-only: force a new personal key-point extraction run for a member report. */

  async function restartPersonalKeyPointExtraction(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: {
        id: input.reportId,
        workspaceId: input.workspaceId,
        kind: "member",
      },
      select: {
        id: true,
        status: true,
        sourceTemplate: { select: { authorId: true } },
      },
    });
    if (!report?.sourceTemplate) throw new AppError("NOT_FOUND");
    if (report.sourceTemplate.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    if (report.status !== "submitted" && report.status !== "shared") {
      throw new AppError("INVALID_INPUT");
    }
    const { startPersonalKeyPointExtraction } = await import("./weekly-report-key-points.server");
    return startPersonalKeyPointExtraction(db, {
      workspaceId: input.workspaceId,
      memberReportId: report.id,
      force: true,
    });
  }

  /** Leader-only: start or re-run team key-point extraction for an overview week parent. */

  async function startTeamKeyPointExtraction(input: {
    workspaceId: string;
    userId: string;
    overviewReportId: string;
    force?: boolean;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const overview = await db.weeklyReport.findFirst({
      where: {
        id: input.overviewReportId,
        workspaceId: input.workspaceId,
        kind: "template",
        authorId: input.userId,
      },
      select: { id: true },
    });
    if (!overview) throw new AppError("NOT_FOUND");
    const assignmentCount = await db.weeklyReport.count({
      where: {
        workspaceId: input.workspaceId,
        sourceTemplateId: overview.id,
        kind: "member",
      },
    });
    if (assignmentCount === 0) throw new AppError("NOT_FOUND");
    const { startTeamKeyPointExtraction } = await import("./weekly-report-key-points.server");
    return startTeamKeyPointExtraction(db, {
      workspaceId: input.workspaceId,
      overviewReportId: overview.id,
      force: input.force ?? true,
    });
  }

  /** Toggle whether this send-settings row is an active send stream (multiple allowed).
   * Product「是否启用」keeps `applied` and `scheduleEnabled` in lockstep (WR-33). */
  async function applyTemplate(input: { workspaceId: string; userId: string; templateId: string }) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const template = await db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      select: { id: true, name: true, applied: true, dimensions: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    if (template.applied) {
      await db.weeklyReportTemplate.update({
        where: { id: template.id },
        data: { applied: false, scheduleEnabled: false },
      });
      return { id: template.id, active: false as const };
    }
    await db.weeklyReportTemplate.update({
      where: { id: template.id },
      data: { applied: true, scheduleEnabled: true },
    });
    await ensureFormatForSettings(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      settingsId: template.id,
      settingsName: template.name,
      sections: parseTemplateSections(template.dimensions),
      alignContent: true,
    });
    return { id: template.id, active: true as const };
  }

  /** Rejects a malformed template or recipients outside the Workspace; returns the parsed parts. */
  async function createTemplate(
    input: TemplateInput & { workspaceId: string; userId: string; id?: string },
  ) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const { sections, enabled } = await validateTemplateInput(input);
    return db.$transaction(async (tx) => {
      const created = await tx.weeklyReportTemplate.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          workspaceId: input.workspaceId,
          ownerId: input.userId,
          ...templateWriteData(input, sections),
        },
      });
      if (enabled) {
        await ensureFormatForSettings(tx, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          settingsId: created.id,
          settingsName: input.name.trim(),
          sections,
          alignContent: true,
        });
      }
      return { id: created.id };
    });
  }

  async function updateTemplate(
    input: TemplateInput & { workspaceId: string; userId: string; templateId: string },
  ) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const template = await db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      select: { id: true, applied: true, name: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    const { sections, enabled } = await validateTemplateInput(input);
    await db.$transaction(async (tx) => {
      await tx.weeklyReportTemplateRecipient.deleteMany({ where: { templateId: template.id } });
      await tx.weeklyReportTemplate.update({
        where: { id: template.id },
        data: templateWriteData(input, sections),
      });
    });
    const liveFormat = !enabled
      ? await db.weeklyReport.findFirst({
          where: {
            workspaceId: input.workspaceId,
            authorId: input.userId,
            settingsId: template.id,
            kind: "template",
            submissions: { none: { kind: "member" } },
          },
          select: { id: true },
        })
      : null;
    // Disabling the schedule must not leave a stale format for manual sends.
    if (enabled || liveFormat) {
      await ensureFormatForSettings(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        settingsId: template.id,
        settingsName: input.name.trim(),
        sections,
        alignContent: true,
      });
    }
    return { id: template.id };
  }

  async function deleteTemplate(input: {
    workspaceId: string;
    userId: string;
    templateId: string;
  }) {
    await requireWeeklyReportLeader(db, input.workspaceId, input.userId);
    const template = await db.weeklyReportTemplate.findFirst({
      where: { id: input.templateId, workspaceId: input.workspaceId, ownerId: input.userId },
      select: { id: true },
    });
    if (!template) throw new AppError("NOT_FOUND");
    await db.weeklyReportTemplate.delete({ where: { id: template.id } });
    return { ok: true as const };
  }

  return {
    listTemplates,
    loadTemplateForReport,
    loadKeyPointPrompts,
    saveKeyPointPrompts,
    deleteKeyPointPromptHistory,
    restartPersonalKeyPointExtraction,
    startTeamKeyPointExtraction,
    applyTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
  };
}
