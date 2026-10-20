import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";

/** Only the platform-owned binding may delegate to its human. A normal Agent's owner confers
 * no authority; a departed member confers none even if a native session remains running. */
export async function workspaceAssistantUser(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
) {
  const agent = await db.agent.findFirst({
    where: { workspaceId, id: agentId, deletedAt: null },
    select: {
      systemKind: true,
      workspaceAssistantSession: {
        select: {
          userId: true,
          user: {
            select: {
              username: true,
              memberships: { where: { workspaceId }, select: { role: true } },
            },
          },
        },
      },
    },
  });
  if (agent?.systemKind !== WORKSPACE_ASSISTANT_KIND) return undefined;
  const session = agent.workspaceAssistantSession;
  if (!session) throw new AppError("ACCESS_DENIED");
  if (!session.user.memberships.length) throw new AppError("ACCESS_DENIED");
  return { userId: session.userId, username: session.user.username };
}
