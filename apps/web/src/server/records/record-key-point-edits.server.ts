import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { normalizeReportContent } from "#src/features/records/records-content";
import { canEditWeeklyReportContent } from "./weekly-report-editability.server";
import { requireMembership } from "./record-catalog-access.server";
import { writeKeyPointExtraction } from "./key-point-extraction-write.server";

type Db = PrismaClient;

export function recordKeyPointEdits(db: Db) {
  async function applyConfirmedKeyPointMarkdown(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    markdown: string;
    promptSnapshot?: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const markdown = input.markdown.trim();
    if (!markdown) throw new AppError("INVALID_INPUT");

    const report = await db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: {
        id: true,
        authorId: true,
        content: true,
        kind: true,
        workspace: { select: { slug: true } },
      },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (
      !canEditWeeklyReportContent({
        viewerUserId: input.userId,
        authorUserId: report.authorId,
      })
    ) {
      throw new AppError("ACCESS_DENIED");
    }

    const { loadSubmittedTeamKeyPointSources, linkifyTeamKeyPointMarkdown } =
      await import("./weekly-report-key-points.server");
    const { DEFAULT_PERSONAL_KEY_POINT_PROMPT, DEFAULT_TEAM_KEY_POINT_PROMPT } =
      await import("#src/features/records/records-content");
    const content = normalizeReportContent(report.content);
    const promptSnapshot =
      input.promptSnapshot ??
      content.keyPointExtraction?.promptSnapshot ??
      (report.kind === "template"
        ? DEFAULT_TEAM_KEY_POINT_PROMPT
        : DEFAULT_PERSONAL_KEY_POINT_PROMPT);
    const linkedMarkdown =
      report.kind === "template"
        ? linkifyTeamKeyPointMarkdown(
            markdown,
            await loadSubmittedTeamKeyPointSources(db, {
              workspaceId: input.workspaceId,
              overviewReportId: report.id,
            }),
            { workspaceSlug: report.workspace.slug, overviewReportId: report.id },
          )
        : markdown;
    const next = await writeKeyPointExtraction(db, {
      reportId: report.id,
      content,
      extraction: {
        status: "ready",
        promptSnapshot,
        markdown: linkedMarkdown,
        generatedAt: new Date().toISOString(),
      },
    });
    return { id: report.id, content: next };
  }

  /**
   * Side-chat Ignore for a key-point-edit card: drop the pending draft and
   * restore `ready` with the previously published markdown (unchanged).
   */
  async function dismissKeyPointConfirmDraft(input: {
    workspaceId: string;
    userId: string;
    reportId: string;
  }) {
    await requireMembership(db, input.workspaceId, input.userId);
    const report = await db.weeklyReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      select: { id: true, authorId: true, content: true, kind: true },
    });
    if (!report) throw new AppError("NOT_FOUND");
    if (
      !canEditWeeklyReportContent({
        viewerUserId: input.userId,
        authorUserId: report.authorId,
      })
    ) {
      throw new AppError("ACCESS_DENIED");
    }

    const content = normalizeReportContent(report.content);
    const existing = content.keyPointExtraction;
    if (!existing || existing.status !== "awaiting_confirm") {
      return { id: report.id, content };
    }

    const { DEFAULT_PERSONAL_KEY_POINT_PROMPT, DEFAULT_TEAM_KEY_POINT_PROMPT } =
      await import("#src/features/records/records-content");
    const promptSnapshot =
      existing.promptSnapshot ||
      (report.kind === "template"
        ? DEFAULT_TEAM_KEY_POINT_PROMPT
        : DEFAULT_PERSONAL_KEY_POINT_PROMPT);
    const next = await writeKeyPointExtraction(db, {
      reportId: report.id,
      content,
      extraction: {
        status: existing.markdown ? "ready" : "failed",
        promptSnapshot,
        ...(existing.markdown ? { markdown: existing.markdown } : {}),
        ...(existing.markdown ? {} : { error: "dismissed_without_published_draft" }),
        ...(existing.generatedAt ? { generatedAt: existing.generatedAt } : {}),
      },
    });
    return { id: report.id, content: next };
  }

  return { applyConfirmedKeyPointMarkdown, dismissKeyPointConfirmDraft };
}
