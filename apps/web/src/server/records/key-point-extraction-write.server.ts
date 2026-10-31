import type { PrismaClient } from "#src/generated/prisma/client";
import {
  withKeyPointExtraction,
  type KeyPointExtractionMeta,
  type ReportContent,
} from "#src/features/records/records-content";

/** Persist extraction meta onto a report (member personal or overview team). */
export async function writeKeyPointExtraction(
  db: PrismaClient,
  input: { reportId: string; content: ReportContent; extraction: KeyPointExtractionMeta },
): Promise<ReportContent> {
  const next = withKeyPointExtraction(input.content, input.extraction);
  await db.weeklyReport.update({
    where: { id: input.reportId },
    data: { content: next as never },
  });
  return next;
}
