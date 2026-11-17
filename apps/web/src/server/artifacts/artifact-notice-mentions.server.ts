import { readMessageReferences } from "@lrm/coforge-sdk/internal/message-references";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

export type MentionedAgent = { id: string; name: string };
export type MentionedPerson = { id: string; username: string };

export const mentionHandles = (text: string, max = Number.POSITIVE_INFINITY) =>
  readMessageReferences(text).candidates.handles.slice(0, max);

export async function peopleNamed(
  db: Pick<PrismaClient, "workspaceMembership">,
  workspaceId: string,
  handles: readonly string[],
): Promise<MentionedPerson[]> {
  if (handles.length === 0) return [];
  const memberships = await db.workspaceMembership.findMany({
    where: { workspaceId, user: { username: { in: [...handles] } } },
    select: { user: { select: { id: true, username: true } } },
  });
  return memberships.map((membership) => membership.user);
}

export async function mentionedIn(
  db: Pick<PrismaClient, "agent" | "workspaceMembership">,
  workspaceId: string,
  texts: readonly string[],
  handlesPerText = Number.POSITIVE_INFINITY,
): Promise<{ agents: MentionedAgent[]; people: MentionedPerson[] }> {
  const handles = [...new Set(texts.flatMap((text) => mentionHandles(text, handlesPerText)))];
  if (handles.length === 0) return { agents: [], people: [] };
  const [agents, people] = await Promise.all([
    db.agent.findMany({
      where: { workspaceId, name: { in: handles }, ...ACTIVE_AGENT_WHERE },
      select: { id: true, name: true },
    }),
    peopleNamed(db, workspaceId, handles),
  ]);
  return { agents, people };
}
