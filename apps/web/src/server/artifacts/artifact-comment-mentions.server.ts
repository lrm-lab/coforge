import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { humanLabel } from "#src/lib/human-label";
import {
  agentsReadingArtifact,
  peopleReadingArtifact,
  type ArtifactAccessRow,
} from "./artifact-access.server";

type Db = Pick<PrismaClient, "agent" | "workspaceMembership" | "conversation">;

export type MentionCandidate = { id: string; handle: string; name: string };

export type MentionCandidates = { people: MentionCandidate[]; agents: MentionCandidate[] };

export async function mentionCandidates(
  db: Db,
  workspaceId: string,
  artifact: ArtifactAccessRow,
): Promise<MentionCandidates> {
  const [memberships, agents] = await Promise.all([
    db.workspaceMembership.findMany({
      where: { workspaceId },
      select: { user: { select: { id: true, username: true, displayName: true } } },
    }),
    db.agent.findMany({
      where: { workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { id: true, name: true, displayName: true },
    }),
  ]);
  const [peopleReading, agentsReading] = await Promise.all([
    peopleReadingArtifact(
      db,
      workspaceId,
      artifact,
      memberships.map(({ user }) => user.id),
    ),
    agentsReadingArtifact(
      db,
      workspaceId,
      artifact,
      agents.map(({ id }) => id),
    ),
  ]);
  return {
    people: memberships
      .filter(({ user }) => peopleReading.has(user.id))
      .map(({ user }) => ({ id: user.id, handle: user.username, name: humanLabel(user) })),
    agents: agents
      .filter(({ id }) => agentsReading.has(id))
      .map((agent) => ({
        id: agent.id,
        handle: agent.name,
        name: agent.displayName || agent.name,
      })),
  };
}
