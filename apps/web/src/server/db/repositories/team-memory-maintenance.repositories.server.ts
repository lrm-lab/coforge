import {
  TEAM_MEMORY_MAINTENANCE_COMMAND,
  TEAM_MEMORY_MAINTENANCE_GUIDANCE,
} from "@lrm/coforge-sdk/agent";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import type { TeamMemoryHead, TeamMemoryResult, TeamMemoryWrite } from "@lrm/coforge-sdk/agent";
import { TeamMemoryError, type TeamMemoryActor } from "#src/server/team-memory/memory";
import { teamMemoryAccess } from "./team-memory-access.repositories.server";
import { head, type Row } from "./team-memory-projections.server";

const DAY_MS = 24 * 60 * 60_000;
const BATCH_MS = 2 * 60_000;
const ENTRY_LIMIT = 64;
const BYTE_LIMIT = 128 * 1024;
const scope = (projectId: string | null) =>
  projectId ? Prisma.sql`project_id = ${projectId}::uuid` : Prisma.sql`project_id IS NULL`;

export async function suggestTeamMemoryMaintenance(
  tx: Prisma.TransactionClient,
  actor: TeamMemoryActor,
  entry: TeamMemoryHead,
): Promise<TeamMemoryResult["maintenanceHint"]> {
  if (!actor.agentId || actor.includeMaintenance === false) return;
  const previous = await tx.teamMemoryMaintenance.findUnique({
    where: { workspaceId: actor.workspaceId },
  });
  const now = new Date();
  if (previous && now.getTime() - previous.suggestedAt.getTime() < DAY_MS) return;
  const projectId = entry.projectId ?? null;
  const [observed] = await tx.$queryRaw<
    { observedEntries: number; observedBytes: number }[]
  >(Prisma.sql`
    SELECT count(*)::integer AS "observedEntries", COALESCE(sum(bytes),0)::integer AS "observedBytes" FROM (
      SELECT octet_length(title) + octet_length(content) + octet_length(source) + octet_length(applicability) AS bytes
      FROM team_memory_entries WHERE workspace_id = ${actor.workspaceId}::uuid AND status = 'active' AND pinned = false AND ${scope(projectId)}
      ORDER BY updated_at ASC, id ASC LIMIT 65
    ) candidates`);
  if (!observed || (observed.observedEntries < ENTRY_LIMIT && observed.observedBytes < BYTE_LIMIT))
    return;
  const data = {
    agentId: actor.agentId,
    projectId,
    suggestedAt: now,
    token: null,
    expiresAt: null,
    remaining: 0,
  };
  await tx.teamMemoryMaintenance.upsert({
    where: { workspaceId: actor.workspaceId },
    create: { workspaceId: actor.workspaceId, ...data },
    update: data,
  });
  return {
    ...observed,
    projectId,
    incomplete: observed.observedEntries === 65,
    nextCommand: TEAM_MEMORY_MAINTENANCE_COMMAND,
    guidance: TEAM_MEMORY_MAINTENANCE_GUIDANCE,
  };
}

export async function beginTeamMemoryMaintenance(
  db: PrismaClient,
  actor: TeamMemoryActor,
): Promise<TeamMemoryResult> {
  if (!actor.agentId) throw new TeamMemoryError("forbidden");
  return db.$transaction(async (tx) => {
    await teamMemoryAccess(tx, actor, true);
    await tx.$queryRaw`SELECT revision FROM team_memory_states WHERE workspace_id = ${actor.workspaceId}::uuid FOR UPDATE`;
    const state = await tx.teamMemoryMaintenance.findUnique({
      where: { workspaceId: actor.workspaceId },
    });
    const now = Date.now();
    if (!state || state.agentId !== actor.agentId) throw new TeamMemoryError("forbidden");
    if (
      now - state.suggestedAt.getTime() >= DAY_MS ||
      (state.token && (!state.expiresAt || state.expiresAt.getTime() <= now))
    )
      throw new TeamMemoryError("conflict");
    const token = state.token ?? crypto.randomUUID();
    const expiresAt = state.expiresAt ?? new Date(now + BATCH_MS);
    const remaining = state.token ? state.remaining : 5;
    if (!state.token)
      await tx.teamMemoryMaintenance.update({
        where: { workspaceId: actor.workspaceId },
        data: { token, expiresAt, remaining },
      });
    const rows = remaining
      ? await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT id, workspace_id AS "workspaceId", title, left(content,600) AS content, left(source,200) AS source, kind, applicability, status, revision, author_agent_id AS "authorAgentId", author_user_id AS "authorUserId", project_id AS "projectId", pinned, updated_at AS "updatedAt"
      FROM team_memory_entries WHERE workspace_id = ${actor.workspaceId}::uuid AND status = 'active' AND pinned = false AND ${scope(state.projectId)}
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
  await tx.teamMemoryMaintenance.update({
    where: { workspaceId: actor.workspaceId },
    data: { remaining: { decrement: 1 + sources.length } },
  });
}
