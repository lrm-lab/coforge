import type { PrismaClient } from "#src/generated/prisma/client";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { RecordChangedEvent } from "#src/features/records/record-realtime";
import {
  withKeyPointExtraction,
  type KeyPointExtractionMeta,
  type ReportContent,
} from "#src/features/records/records-content";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { reportReaders, type ReportAccess } from "./report-readers.server";

type Broadcast = Pick<CentrifugoServerApi, "broadcast">;

/**
 * Persist extraction meta onto a report (member personal or overview team), and tell each page
 * that may show it (`announceReportChanged`): a page waiting on its key points reads it again then,
 * instead of polling.
 */
export async function writeKeyPointExtraction(
  db: PrismaClient,
  input: { reportId: string; content: ReportContent; extraction: KeyPointExtractionMeta },
  centrifugo?: Broadcast,
): Promise<ReportContent> {
  const next = withKeyPointExtraction(input.content, input.extraction);
  const report = await db.weeklyReport.update({
    where: { id: input.reportId },
    data: { content: next as never },
    select: {
      id: true,
      workspaceId: true,
      kind: true,
      authorId: true,
      hiddenFromAuthor: true,
      sourceTemplate: { select: { authorId: true } },
    },
  });
  await announceReportChanged(
    db,
    { ...report, sourceTemplateAuthorId: report.sourceTemplate?.authorId ?? null },
    centrifugo,
  );
  return next;
}

/**
 * Sends `record.changed.v1` to the own channel of everyone who may read the report, in one
 * Centrifugo `broadcast`. Best effort: the write already happened, and a page that misses the
 * signal reads the report again when its subscription comes back (`missedBySubscribe`).
 */
async function announceReportChanged(
  db: PrismaClient,
  report: ReportAccess & { workspaceId: string },
  centrifugo?: Broadcast,
) {
  try {
    const userIds = [...(await reportReaders(db, report.workspaceId, report))];
    if (userIds.length === 0) return;
    const event: RecordChangedEvent = {
      type: "record.changed.v1",
      workspaceId: report.workspaceId,
      reportId: report.id,
    };
    await (centrifugo ?? createCentrifugoServerApi()).broadcast(
      userIds.map((userId) => userConversationChannel(userId)),
      event,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "records:report_changed_announce_failed",
        workspace_id: report.workspaceId,
        report_id: report.id,
        error_type: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}
