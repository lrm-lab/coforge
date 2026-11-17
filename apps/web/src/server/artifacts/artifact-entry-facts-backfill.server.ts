import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { artifactOpenableKind } from "#src/features/artifacts/artifact-path-kind";
import { errorType } from "#src/server/errors/error-type.server";
import type { ArtifactDocuments } from "./artifact-documents.server";

export async function backfillArtifactEntryFacts(input: {
  db: PrismaClient;
  documents: Pick<ArtifactDocuments, "refreshCard">;
  dryRun: boolean;
  batchSize: number;
  after?: string;
  onBatch?: (checkpoint: { lastId: string; pending: number; filled: number }) => void;
}) {
  let after = input.after;
  let pending = 0;
  let filled = 0;
  let failed = 0;
  for (;;) {
    const rows = await input.db.artifact.findMany({
      where: {
        deletedAt: null,
        currentVersion: { gt: 0 },
        entryFacts: { equals: Prisma.DbNull },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: "asc" },
      take: input.batchSize,
      select: { id: true, workspaceId: true, entryPath: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (artifactOpenableKind(row.entryPath) !== null) continue;
      pending++;
      if (input.dryRun) continue;
      try {
        await input.documents.refreshCard(row.workspaceId, row.id);
        filled++;
      } catch (error) {
        failed++;
        console.warn(
          JSON.stringify({
            event: "artifacts:entry_facts_backfill_failed",
            artifact_id: row.id,
            error_type: errorType(error),
          }),
        );
      }
    }
    after = rows.at(-1)!.id;
    input.onBatch?.({ lastId: after, pending, filled });
  }
  return { pending, filled, failed, lastId: after ?? null };
}
