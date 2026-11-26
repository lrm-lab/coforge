import {
  TEAM_MEMORY_MAINTENANCE_COMMAND,
  TEAM_MEMORY_MAINTENANCE_GUIDANCE,
} from "@lrm/coforge-sdk/agent";
import { Prisma } from "#src/generated/prisma/client";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";
import type { TeamMemoryHead, TeamMemoryResult, TeamMemoryWrite } from "@lrm/coforge-sdk/agent";
import { TeamMemoryError, type TeamMemoryActor } from "#src/server/team-memory/memory";
import { supersededMemoryCandidate } from "./team-memory-head-filters.server";
import { teamMemoryAccess } from "./team-memory-access.repositories.server";
import { head, PREVIEW_WHITESPACE, type Row } from "./team-memory-projections.server";

const DAY_MS = 24 * 60 * 60_000;
const BATCH_MS = 2 * 60_000;
const ENTRY_LIMIT = 64;
const BYTE_LIMIT = 128 * 1024;
const scope = (projectId: string | null) =>
  projectId ? Prisma.sql`project_id = ${projectId}::uuid` : Prisma.sql`project_id IS NULL`;

async function observePressure(
  db: DatabaseScope,
  workspaceId: string,
  projectId: string | null,
): Promise<NonNullable<TeamMemoryResult["maintenanceHint"]>> {
  const [observed] = await db.$queryRaw<
    { observedEntries: number; observedBytes: number }[]
  >(Prisma.sql`
    SELECT count(*)::integer AS "observedEntries", COALESCE(sum(bytes),0)::integer AS "observedBytes" FROM (
      SELECT octet_length(title) + octet_length(content) + octet_length(source) + octet_length(applicability) AS bytes
      FROM team_memory_entries candidate WHERE workspace_id = ${workspaceId}::uuid AND status = 'active' AND pinned = false AND ${scope(projectId)} AND NOT ${supersededMemoryCandidate}
      ORDER BY updated_at ASC, id ASC LIMIT 65
    ) candidates`);
  return {
    ...observed!,
    projectId,
    incomplete: observed!.observedEntries === 65,
    nextCommand: TEAM_MEMORY_MAINTENANCE_COMMAND,
    guidance: TEAM_MEMORY_MAINTENANCE_GUIDANCE,
  };
}

export async function suggestTeamMemoryMaintenance(
  db: DatabaseScope,
  actor: TeamMemoryActor,
  entry: TeamMemoryHead,
  requestId: string,
): Promise<TeamMemoryResult["maintenanceHint"]> {
  if (!actor.agentId || actor.includeMaintenance === false) return;
  const previous = await db.teamMemoryMaintenance.findUnique({
    where: { workspaceId: actor.workspaceId },
  });
  const now = new Date();
  if (previous && now.getTime() - previous.suggestedAt.getTime() < DAY_MS) return;
  const projectId = entry.projectId ?? null;
  const hint = await observePressure(db, actor.workspaceId, projectId);
  if (hint.observedEntries < ENTRY_LIMIT && hint.observedBytes < BYTE_LIMIT) return;
  const cutoff = new Date(now.getTime() - DAY_MS);
  const claimed = await db.$queryRaw<{ workspaceId: string }[]>`
    INSERT INTO team_memory_maintenance (workspace_id, agent_id, project_id, suggested_at, token, expires_at, remaining)
    VALUES (${actor.workspaceId}::uuid, ${actor.agentId}::uuid, ${projectId}::uuid, ${now}, ${requestId}::uuid, NULL, 0)
    ON CONFLICT (workspace_id) DO UPDATE SET
      agent_id = EXCLUDED.agent_id,
      project_id = EXCLUDED.project_id,
      suggested_at = EXCLUDED.suggested_at,
      token = EXCLUDED.token,
      expires_at = NULL,
      remaining = 0
    WHERE team_memory_maintenance.suggested_at <= ${cutoff}
      AND (team_memory_maintenance.expires_at IS NULL OR team_memory_maintenance.expires_at <= ${now})
    RETURNING workspace_id AS "workspaceId"`;
  return claimed.length ? hint : undefined;
}

export async function replayTeamMemoryMaintenanceHint(
  db: DatabaseScope,
  actor: TeamMemoryActor,
  command: TeamMemoryWrite,
): Promise<TeamMemoryResult["maintenanceHint"]> {
  if (!actor.agentId || actor.includeMaintenance === false || command.maintenanceToken) return;
  const pending = await db.teamMemoryMaintenance.findUnique({
    where: {
      workspaceId: actor.workspaceId,
      agentId: actor.agentId,
      token: command.requestId,
      expiresAt: null,
      suggestedAt: { gt: new Date(Date.now() - DAY_MS) },
    },
    select: { projectId: true },
  });
  if (pending) return observePressure(db, actor.workspaceId, pending.projectId);
}

export async function beginTeamMemoryMaintenance(
  db: DatabaseScope,
  actor: TeamMemoryActor,
): Promise<TeamMemoryResult> {
  if (!actor.agentId) throw new TeamMemoryError("forbidden");
  return inTransaction(db, async (tx) => {
    await teamMemoryAccess(tx, actor, true);
    await tx.$queryRaw`SELECT revision FROM team_memory_states WHERE workspace_id = ${actor.workspaceId}::uuid FOR UPDATE`;
    const state = await tx.teamMemoryMaintenance.findUnique({
      where: { workspaceId: actor.workspaceId },
    });
    const now = Date.now();
    if (!state || state.agentId !== actor.agentId) throw new TeamMemoryError("forbidden");
    if (
      now - state.suggestedAt.getTime() >= DAY_MS ||
      (state.expiresAt && (!state.token || state.expiresAt.getTime() <= now))
    )
      throw new TeamMemoryError("conflict");
    const token = state.expiresAt ? state.token! : crypto.randomUUID();
    const expiresAt = state.expiresAt ?? new Date(now + BATCH_MS);
    const remaining = state.expiresAt ? state.remaining : 5;
    if (!state.expiresAt)
      await tx.teamMemoryMaintenance.update({
        where: { workspaceId: actor.workspaceId },
        data: { token, expiresAt, remaining },
      });
    const rows = remaining
      ? await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT id, workspace_id AS "workspaceId", title, left(ltrim(content, ${PREVIEW_WHITESPACE}),600) AS content, left(ltrim(source, ${PREVIEW_WHITESPACE}),200) AS source, kind, applicability, status, revision, author_agent_id AS "authorAgentId", author_user_id AS "authorUserId", project_id AS "projectId", pinned, updated_at AS "updatedAt"
      FROM team_memory_entries candidate WHERE workspace_id = ${actor.workspaceId}::uuid AND status = 'active' AND pinned = false AND ${scope(state.projectId)} AND NOT ${supersededMemoryCandidate}
      ${actor.includeHumanAuthors === false ? Prisma.sql`AND author_agent_id IS NOT NULL` : Prisma.empty}
      ORDER BY updated_at ASC, id ASC LIMIT ${remaining}`)
      : [];
    return {
      status: "ok",
      entries: rows
        .map(head)
        .reduce<TeamMemoryHead[]>(
          (entries, entry) =>
            Buffer.byteLength(JSON.stringify([...entries, entry])) <= 11000
              ? [...entries, entry]
              : entries,
          [],
        ),
      maintenance: {
        token,
        expiresAt: expiresAt.toISOString(),
        remaining,
        projectId: state.projectId,
      },
    };
  });
}

export async function consumeTeamMemoryMaintenance(
  tx: Prisma.TransactionClient,
  actor: TeamMemoryActor,
  command: TeamMemoryWrite,
  target: Row | null | undefined,
  sources: Row[],
): Promise<void> {
  if (!actor.agentId || !["update", "merge", "archive"].includes(command.operation) || !target)
    throw new TeamMemoryError("forbidden");
  if (
    ("relations" in command && command.relations !== undefined) ||
    ("effectiveAt" in command && command.effectiveAt !== undefined) ||
    [target, ...sources].some(
      (entry) => Array.isArray(entry.relations) && entry.relations.length > 0,
    )
  )
    throw new TeamMemoryError("forbidden");
  const state = await tx.teamMemoryMaintenance.findUnique({
    where: { workspaceId: actor.workspaceId },
  });
  if (!state || state.agentId !== actor.agentId || state.token !== command.maintenanceToken)
    throw new TeamMemoryError("forbidden");
  if (
    !state.expiresAt ||
    state.expiresAt.getTime() <= Date.now() ||
    state.remaining < 1 + sources.length
  )
    throw new TeamMemoryError("conflict");
  if (
    [target, ...sources].some(
      (entry) =>
        entry.pinned || entry.status !== "active" || (entry.projectId ?? null) !== state.projectId,
    )
  )
    throw new TeamMemoryError("forbidden");
  if (
    "projectId" in command &&
    command.projectId !== undefined &&
    command.projectId !== state.projectId
  )
    throw new TeamMemoryError("forbidden");
  const [old] = await tx.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM team_memory_entries candidate
      WHERE candidate.workspace_id = ${actor.workspaceId}::uuid
        AND candidate.id = ANY(${[target, ...sources].map(({ id }) => id)}::uuid[])
        AND ${supersededMemoryCandidate}
    ) AS found`;
  if (old?.found) throw new TeamMemoryError("forbidden");
  await tx.teamMemoryMaintenance.update({
    where: { workspaceId: actor.workspaceId },
    data: { remaining: { decrement: 1 + sources.length } },
  });
}
