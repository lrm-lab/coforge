import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import {
  activeMemoryCandidateIds,
  currentMemoryCandidate,
} from "#src/server/db/repositories/team-memory-head-filters.server";
import { teamMemoryAccess } from "#src/server/db/repositories/team-memory-access.repositories.server";
import { readableMemoryEvidence } from "#src/server/db/repositories/team-memory-evidence.server";
import { head, type Row } from "#src/server/db/repositories/team-memory-projections.server";
import { TeamMemoryError } from "./memory";
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
  const trigger = userId ? "manual" : "scheduled";
  try {
    const result = await scanWorkspaceMemory(db, workspaceId, userId, now);
    if (result.scanId)
      console.info(
        JSON.stringify({
          event: "team_memory.review_scanned",
          workspace_id: workspaceId,
          trigger,
          ...result,
        }),
      );
    return result;
  } catch (error) {
    const code =
      error instanceof TeamMemoryError || error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : undefined;
    console.error(
      JSON.stringify({
        event: "team_memory.review_scan_failed",
        workspace_id: workspaceId,
        trigger,
        error_type: error instanceof Error ? error.name : "unknown",
        code,
      }),
    );
    throw error;
  }
}

async function scanWorkspaceMemory(
  db: PrismaClient,
  workspaceId: string,
  userId: string | undefined,
  now: Date,
) {
  return db.$transaction(async (tx) => {
    if (userId) await teamMemoryAccess(tx, { workspaceId, userId }, true);
    else {
      const [workspace] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR SHARE`;
      if (!workspace) return { inspected: 0, suggested: 0 };
    }
    const cutoff = new Date(now.getTime() - TEAM_MEMORY_SCAN_INTERVAL_MS);
    const [scan] = await tx.$queryRaw<
      { cursorAt: Date | null; cursorId: string | null; cursorProjectId: string | null }[]
    >`
      INSERT INTO team_memory_review_scans (workspace_id, scanned_at)
      VALUES (${workspaceId}::uuid, ${now})
      ON CONFLICT (workspace_id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at
      WHERE ${!!userId} OR team_memory_review_scans.scanned_at <= ${cutoff}
      RETURNING cursor_at AS "cursorAt", cursor_id AS "cursorId", cursor_project_id AS "cursorProjectId"`;
    if (!scan) return { inspected: 0, suggested: 0 };
    const found = await tx.teamMemoryEntry.findMany({
      where: {
        workspaceId,
        status: "active",
        pinned: false,
        ...(scan.cursorAt && scan.cursorId
          ? {
              OR: [
                scan.cursorProjectId
                  ? { projectId: { gt: scan.cursorProjectId } }
                  : { projectId: { not: null } },
                {
                  projectId: scan.cursorProjectId,
                  OR: [
                    { updatedAt: { gt: scan.cursorAt } },
                    { updatedAt: scan.cursorAt, id: { gt: scan.cursorId } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [
        { projectId: { sort: "asc", nulls: "first" } },
        { updatedAt: "asc" },
        { id: "asc" },
      ],
      take: PAGE_SIZE + 1,
    });
    const projectId = found[0]?.projectId ?? null;
    const page = found.filter((row) => row.projectId === projectId).slice(0, PAGE_SIZE);
    const eligible = await activeMemoryCandidateIds(
      tx,
      workspaceId,
      page.map(({ id }) => id),
    );
    const window = page.filter(({ id }) => eligible.has(id));
    const entries = window.map((entry) => head(entry as Row));
    const withEvidence = entries.filter((entry) => entry.evidence?.length);
    const references = withEvidence.flatMap((entry) => entry.evidence ?? []);
    const readable = new Set(
      (await readableMemoryEvidence(tx, workspaceId, references)).map((ref) => JSON.stringify(ref)),
    );
    const stale = withEvidence.filter((entry) =>
      entry.evidence?.some((ref) => !readable.has(JSON.stringify(ref))),
    );
    const buckets = [
      ...new Set(
        window.map(({ content, kind, applicability }) =>
          JSON.stringify({
            hash: new Bun.CryptoHasher("md5")
              .update(normalizedMemoryContent(content))
              .digest("hex"),
            kind,
            applicability,
          }),
        ),
      ),
    ];
    const related = buckets.length
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
      SELECT peer.*
      FROM jsonb_to_recordset(${`[${buckets.join(",")}]`}::jsonb)
        AS bucket(hash text, kind text, applicability text)
      CROSS JOIN LATERAL (
        SELECT id, revision, title, content, kind, applicability, project_id AS "projectId", pinned
        FROM team_memory_entries candidate
        WHERE workspace_id = ${workspaceId}::uuid AND status = 'active' AND NOT pinned
          AND ${currentMemoryCandidate}
          AND COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid) =
            COALESCE(${projectId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND kind = bucket.kind AND applicability = bucket.applicability
          AND md5(trim(regexp_replace(normalize(content, NFKC), '[[:space:]]+', ' ', 'g'))) = bucket.hash
        ORDER BY id ASC LIMIT 2
      ) peer`
      : [];
    const records = [...new Map([...window, ...related].map((row) => [row.id, row])).values()].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    const duplicates = duplicateMemorySuggestions(records, records.length);
    const scanId = crypto.randomUUID();
    const candidates = [
      ...stale.map((entry) => ({
        workspaceId,
        scanId,
        sourceKey: `evidence:${entry.id}:${entry.revision}`,
        kind: "evidence",
        payload: { id: entry.id, revision: entry.revision, title: entry.title },
      })),
      ...duplicates.map(({ key, ...payload }) => ({
        workspaceId,
        scanId,
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
    const last = found.length > page.length ? page.at(-1) : undefined;
    await tx.teamMemoryReviewScan.update({
      where: { workspaceId },
      data: {
        cursorAt: last?.updatedAt ?? null,
        cursorId: last?.id ?? null,
        cursorProjectId: last?.projectId ?? null,
      },
    });
    return { inspected: window.length, suggested, scanId, projectId };
  });
}
