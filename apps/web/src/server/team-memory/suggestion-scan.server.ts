import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { teamMemoryAccess } from "#src/server/db/repositories/team-memory-access.repositories.server";
import { readableMemoryEvidence } from "#src/server/db/repositories/team-memory-evidence.server";
import { head, type Row } from "#src/server/db/repositories/team-memory-projections.server";
import { duplicateMemorySuggestions, normalizedMemoryContent } from "./suggestions";

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
    const stale = withEvidence.filter((entry) =>
      entry.evidence?.some((ref) => !readable.has(JSON.stringify(ref))),
    );
    const fingerprints = [
      ...new Set(
        window.map(({ content }) =>
          new Bun.CryptoHasher("md5").update(normalizedMemoryContent(content)).digest("hex"),
        ),
      ),
    ];
    const related = fingerprints.length
      ? await tx.$queryRaw<
          {
            id: string;
            revision: number;
            title: string;
            content: string;
            kind: string;
            applicability: string;
            projectId: string | null;
            pinned: boolean;
          }[]
        >`
      SELECT id, revision, title, content, kind, applicability, project_id AS "projectId", pinned
      FROM team_memory_entries
      WHERE workspace_id = ${workspaceId}::uuid AND status = 'active' AND NOT pinned
        AND md5(trim(regexp_replace(normalize(content, NFKC), '[[:space:]]+', ' ', 'g'))) = ANY(${fingerprints}::text[])
      ORDER BY id ASC LIMIT 128`
      : [];
    const records = [...new Map([...window, ...related].map((row) => [row.id, row])).values()].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    const duplicates = duplicateMemorySuggestions(records, records.length);
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
    const recorded = new Set(
      candidates.length
        ? (
            await tx.teamMemorySuggestion.findMany({
              where: {
                workspaceId,
                sourceKey: { in: candidates.map(({ sourceKey }) => sourceKey) },
              },
              select: { sourceKey: true },
              take: candidates.length,
            })
          ).map(({ sourceKey }) => sourceKey)
        : [],
    );
    const fresh = candidates
      .filter(({ sourceKey }) => !recorded.has(sourceKey))
      .slice(0, SUGGESTION_LIMIT);
    const suggested = fresh.length
      ? (await tx.teamMemorySuggestion.createMany({ data: fresh, skipDuplicates: true })).count
      : 0;
    const last = window.length === PAGE_SIZE ? window.at(-1) : undefined;
    await tx.teamMemoryReviewScan.update({
      where: { workspaceId },
      data: { cursorAt: last?.updatedAt ?? null, cursorId: last?.id ?? null },
    });
    return { inspected: window.length, suggested };
  });
}
