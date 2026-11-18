import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { teamMemoryAccess } from "#src/server/db/repositories/team-memory-access.repositories.server";
import { readableMemoryEvidence } from "#src/server/db/repositories/team-memory-evidence.server";
import { head, type Row } from "#src/server/db/repositories/team-memory-projections.server";
import { duplicateMemorySuggestions } from "./suggestions";

export const TEAM_MEMORY_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 64;
const SUGGESTION_LIMIT = 5;

export async function scanTeamMemorySuggestions(
  db: PrismaClient,
  workspaceId: string,
  userId?: string,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    if (userId) await teamMemoryAccess(tx, { workspaceId, userId });
    const cutoff = new Date(now.getTime() - TEAM_MEMORY_SCAN_INTERVAL_MS);
    const [scan] = await tx.$queryRaw<{ cursorAt: Date | null; cursorId: string | null }[]>`
      INSERT INTO team_memory_review_scans (workspace_id, scanned_at)
      VALUES (${workspaceId}::uuid, ${now})
      ON CONFLICT (workspace_id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at
      WHERE ${!!userId} OR team_memory_review_scans.scanned_at <= ${cutoff}
      RETURNING cursor_at AS "cursorAt", cursor_id AS "cursorId"`;
    if (!scan) return { inspected: 0, suggested: 0 };
    const where = { workspaceId, status: "active", pinned: false };
    const read = (range: Prisma.TeamMemoryEntryWhereInput) =>
      tx.teamMemoryEntry.findMany({
        where: { ...where, ...range },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: PAGE_SIZE,
      });
    const window =
      scan.cursorAt && scan.cursorId
        ? await read({
            OR: [
              { updatedAt: { gt: scan.cursorAt } },
              { updatedAt: scan.cursorAt, id: { gt: scan.cursorId } },
            ],
          })
        : await read({});
    const entries = window.map((entry) => head(entry as Row));
    const withEvidence = entries.filter((entry) => entry.evidence?.length);
    const references = withEvidence.flatMap((entry) => entry.evidence ?? []);
    const readable = new Set(
      (await readableMemoryEvidence(tx, workspaceId, references)).map((ref) => JSON.stringify(ref)),
    );
    const stale = withEvidence
      .filter((entry) => entry.evidence?.some((ref) => !readable.has(JSON.stringify(ref))))
      .slice(0, SUGGESTION_LIMIT);
    const duplicates =
      stale.length < SUGGESTION_LIMIT
        ? duplicateMemorySuggestions(window, SUGGESTION_LIMIT - stale.length)
        : [];
    const candidates = [
      ...stale.map((entry) => ({
        workspaceId,
        sourceKey: `evidence:${entry.id}:${entry.revision}`,
        kind: "evidence",
        payload: { id: entry.id, revision: entry.revision, title: entry.title },
      })),
      ...duplicates.map(({ key, ...payload }) => ({
        workspaceId,
        sourceKey: key,
        kind: "duplicate",
        payload,
      })),
    ];
    const suggested = candidates.length
      ? (await tx.teamMemorySuggestion.createMany({ data: candidates, skipDuplicates: true })).count
      : 0;
    const last = window.length === PAGE_SIZE ? window.at(-1) : undefined;
    await tx.teamMemoryReviewScan.update({
      where: { workspaceId },
      data: { cursorAt: last?.updatedAt ?? null, cursorId: last?.id ?? null },
    });
    return { inspected: window.length, suggested };
  });
}
