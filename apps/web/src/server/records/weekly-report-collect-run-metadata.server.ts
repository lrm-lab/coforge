import type { PrismaClient } from "#src/generated/prisma/client";

export type CollectorRunMetadata = { reportId: string; userId: string };

/** Reads each affected run's notification metadata once, with bounded fan-out. */
export async function loadCollectorRunMetadata(
  db: PrismaClient,
  input: { workspaceId: string; runIds: string[] },
): Promise<Map<string, CollectorRunMetadata | null>> {
  const runIds = [...new Set(input.runIds)];
  const metadata = new Map<string, CollectorRunMetadata | null>();
  const READ_CONCURRENCY = 8;
  for (let offset = 0; offset < runIds.length; offset += READ_CONCURRENCY) {
    const batch = runIds.slice(offset, offset + READ_CONCURRENCY);
    const rows = await Promise.all(
      batch.map((runId) =>
        db.weeklyReportCollectRun.findFirst({
          where: { id: runId, workspaceId: input.workspaceId },
          select: { reportId: true, userId: true },
        }),
      ),
    );
    for (const [index, runId] of batch.entries()) metadata.set(runId, rows[index] ?? null);
  }
  return metadata;
}
