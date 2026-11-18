import { Prisma } from "#src/generated/prisma/client";

export const supersededMemoryCandidate = Prisma.sql`EXISTS (
  SELECT 1 FROM team_memory_entries replacement
  WHERE replacement.workspace_id = candidate.workspace_id AND replacement.status = 'active'
    AND replacement.project_id IS NOT DISTINCT FROM candidate.project_id
    AND replacement.applicability = candidate.applicability
    AND (replacement.effective_at IS NULL OR replacement.effective_at <= CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    AND replacement.relations @> jsonb_build_array(
      jsonb_build_object('kind', 'supersedes', 'id', candidate.id, 'revision', candidate.revision))
)`;

export const currentMemoryCandidate = Prisma.sql`
  (candidate.effective_at IS NULL OR candidate.effective_at <= CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  AND NOT ${supersededMemoryCandidate}
`;

export async function activeMemoryCandidateIds(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  ids: string[],
) {
  if (!ids.length) return new Set<string>();
  const eligible = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM team_memory_entries candidate
      WHERE workspace_id = ${workspaceId}::uuid AND id = ANY(${ids}::uuid[])
        AND status = 'active' AND NOT pinned AND ${currentMemoryCandidate}`;
  return new Set(eligible.map(({ id }) => id));
}
