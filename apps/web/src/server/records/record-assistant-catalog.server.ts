import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import {
  isAssignmentUnread,
  normalizeReportContent,
  withAssignmentUnread,
} from "#src/features/records/records-content";
import { parseTemplateSections } from "#src/features/records/template-outline-sections";
import { requireMembership } from "./record-catalog-access.server";

type Db = PrismaClient;

export function recordAssistantCatalog(db: Db) {
  async function listAssistantTemplateFormats(input: {
    workspaceId: string;
    userId: string;
    query?: string;
    cursor?: string;
    limit?: number;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
    const rows = await db.weeklyReportTemplate.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.query ? { name: { contains: input.query, mode: "insensitive" as const } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: {
        owner: { select: { displayName: true, username: true } },
        recipients: { select: { userId: true } },
      },
    });
    return {
      templates: rows.slice(0, limit).map((template) => ({
        id: template.id,
        name: template.name,
        sections: parseTemplateSections(template.dimensions),
        active: template.applied,
        owner: humanLabel(template.owner),
        updatedAt: template.updatedAt.toISOString(),
        canManage: template.ownerId === input.userId,
        ...(template.ownerId === input.userId
          ? {
              scheduleEnabled: template.scheduleEnabled,
              sendWeekday: template.sendWeekday,
              sendTime: template.sendTime,
              timeZone: "Asia/Shanghai",
              allMembers: template.allMembers,
              recipientUserIds: template.recipients.map((recipient) => recipient.userId),
            }
          : {}),
      })),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  async function listAssistantVisibleReports(input: {
    workspaceId: string;
    userId: string;
    cycleId?: string;
    cursor?: string;
    limit?: number;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
    const rows = await db.weeklyReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
        kind: "member",
        status: { in: ["submitted", "shared"] },
        OR: [{ authorId: input.userId }, { sourceTemplate: { authorId: input.userId } }],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
      take: limit + 1,
      select: {
        id: true,
        cycleId: true,
        authorId: true,
        title: true,
        status: true,
        submittedAt: true,
        updatedAt: true,
        author: { select: { username: true, displayName: true } },
        cycle: { select: { year: true, week: true, title: true } },
      },
    });
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    return {
      reports: visible.map((row) => ({
        id: row.id,
        cycleId: row.cycleId,
        title: row.title,
        status: row.status,
        submittedAt: row.submittedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        author: {
          username: row.author.username,
          displayName: humanLabel(row.author),
        },
        cycle: row.cycle,
        source: {
          kind: "weekly_report",
          reportId: row.id,
          userId: row.authorId,
        },
      })),
      nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
    } as const;
  }

  async function createNote(input: { workspaceId: string; userId: string; title?: string }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const title = (input.title?.trim() || "Untitled").slice(0, 200);
    const note = await db.recordNote.create({
      data: {
        workspaceId: input.workspaceId,
        authorId: input.userId,
        title,
        body: "",
      },
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt.toISOString(),
      created: true as const,
    };
  }
  async function saveNote(input: {
    workspaceId: string;
    userId: string;
    noteId: string;
    title?: string;
    body?: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const note = await db.recordNote.findFirst({
      where: { id: input.noteId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true },
    });
    if (!note) throw new AppError("NOT_FOUND");
    if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    const data: { title?: string; body?: string } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new AppError("INVALID_INPUT");
      data.title = title.slice(0, 200);
    }
    if (input.body !== undefined) data.body = input.body;
    if (!Object.keys(data).length) {
      const current = await db.recordNote.findUniqueOrThrow({
        where: { id: note.id },
        select: { id: true, title: true, updatedAt: true },
      });
      return {
        id: current.id,
        title: current.title,
        updatedAt: current.updatedAt.toISOString(),
      };
    }
    const updated = await db.recordNote.update({
      where: { id: note.id },
      data,
      select: { id: true, title: true, updatedAt: true },
    });
    return {
      id: updated.id,
      title: updated.title,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
  async function deleteNote(input: { workspaceId: string; userId: string; noteId: string }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const note = await db.recordNote.findFirst({
      where: { id: input.noteId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true },
    });
    if (!note) throw new AppError("NOT_FOUND");
    if (note.authorId !== input.userId) throw new AppError("ACCESS_DENIED");
    await db.recordNote.delete({ where: { id: note.id } });
    return { ok: true as const };
  }
  async function markAssignmentOpened(input: {
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
        authorId: input.userId,
      },
      select: { id: true, content: true, sourceTemplateId: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (!report.sourceTemplateId) return { id: report.id, unread: false as const };
    const content = normalizeReportContent(report.content);
    if (!isAssignmentUnread(content)) return { id: report.id, unread: false as const };
    const next = withAssignmentUnread(content, false);
    await db.weeklyReport.update({
      where: { id: report.id },
      data: { content: next as unknown as Prisma.InputJsonValue },
    });
    return { id: report.id, unread: false as const };
  }

  return {
    listAssistantTemplateFormats,
    listAssistantVisibleReports,
    createNote,
    saveNote,
    deleteNote,
    markAssignmentOpened,
  };
}
