import { readMessageReferences } from "@lrm/coforge-sdk/internal/message-references";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

export type MentionedAgent = { id: string; name: string };

export async function mentionedIn(
  db: Pick<PrismaClient, "agent" | "workspaceMembership">,
  workspaceId: string,
  texts: readonly string[],
): Promise<{ agents: MentionedAgent[]; people: string[] }> {
  const handles = [
    ...new Set(texts.flatMap((text) => readMessageReferences(text).candidates.handles)),
  ];
  if (handles.length === 0) return { agents: [], people: [] };
  const [agents, memberships] = await Promise.all([
    db.agent.findMany({
      where: { workspaceId, name: { in: handles }, ...ACTIVE_AGENT_WHERE },
      select: { id: true, name: true },
    }),
    db.workspaceMembership.findMany({
      where: { workspaceId, user: { username: { in: handles } } },
      select: { user: { select: { username: true } } },
    }),
  ]);
  return { agents, people: memberships.map((membership) => membership.user.username) };
}
