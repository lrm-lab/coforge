import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { ArtifactOrigins } from "#src/server/artifacts/artifact-origins.server";

const DEFAULTS = { scanWindow: 5000, batchSize: 500, maxMinutes: 12, pauseMs: 100 };

export type ArtifactOriginBackfillOptions = {
  dryRun?: boolean;
  fromMessageId?: string;
  workspaceId?: string;
  scanWindow?: number;
  batchSize?: number;
  maxMinutes?: number;
  pauseMs?: number;
};

export type ArtifactOriginBackfillSummary = {
  scanned: number;
  candidates: number;
  written: number;
  cursor: string | undefined;
  finished: boolean;
};

type Candidate = {
  id: string;
  workspaceId: string;
  conversationId: string;
  body: string;
  createdAt: Date;
};

export async function backfillArtifactOrigins(
  db: PrismaClient,
  options: ArtifactOriginBackfillOptions = {},
): Promise<ArtifactOriginBackfillSummary> {
  const { scanWindow, batchSize, maxMinutes, pauseMs } = { ...DEFAULTS, ...options };
  const origins = new ArtifactOrigins(db);
  const deadline = Date.now() + maxMinutes * 60_000;
  const scope = options.workspaceId
    ? Prisma.sql`AND "workspaceId" = ${options.workspaceId}::uuid`
    : Prisma.empty;
  const summary: ArtifactOriginBackfillSummary = {
    scanned: 0,
    candidates: 0,
    written: 0,
    cursor: options.fromMessageId,
    finished: false,
  };
  while (Date.now() < deadline) {
    const last = summary.cursor ?? "00000000-0000-0000-0000-000000000000";
    const [window] = await db.$queryRaw<{ last: string | null; size: bigint }[]>`
      SELECT w."id"::text AS "last", w."size" FROM (
        SELECT "id", count(*) OVER () AS "size" FROM (
          SELECT "id" FROM "messages" WHERE "id" > ${last}::uuid ORDER BY "id" LIMIT ${scanWindow}
        ) s
      ) w ORDER BY w."id" DESC LIMIT 1`;
    if (!window?.last) {
      summary.finished = true;
      break;
    }
    const found = await db.$queryRaw<Candidate[]>`
      SELECT "id", "workspaceId", "conversationId", "body", "createdAt" FROM "messages"
      WHERE "id" > ${last}::uuid AND "id" <= ${window.last}::uuid ${scope}
        AND ("body" LIKE '%artifacts/%' OR "body" LIKE '%doc=%')
      ORDER BY "id"`;
    summary.candidates += found.length;
    if (!options.dryRun)
      for (let from = 0; from < found.length; from += batchSize)
        for (const message of found.slice(from, from + batchSize))
          summary.written += await origins.noteMessage({
            workspaceId: message.workspaceId,
            conversationId: message.conversationId,
            messageId: message.id,
            body: message.body,
            createdAt: message.createdAt,
            replaceLater: true,
          });
    summary.scanned += Number(window.size);
    summary.cursor = window.last;
    if (Number(window.size) < scanWindow) {
      summary.finished = true;
      break;
    }
    if (pauseMs > 0) await Bun.sleep(pauseMs);
  }
  return summary;
}
