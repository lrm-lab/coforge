import type { PrismaClient } from "#src/generated/prisma/client";
import type { AgentDetailSource } from "#src/server/agents/agent-detail.server";
import {
  assertAgentVisible,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";

/**
 * The Agent profile's row, for a viewer who belongs to the Workspace. A deleted Agent is
 * included, marked `deletedAt`: its profile stays readable, as its message history does. Who may
 * see it does not change with the delete; a private Agent stays its creator's.
 */
export class PrismaAgentDetailSource implements AgentDetailSource {
  constructor(
    private readonly db: PrismaClient,
    private readonly viewer: AgentVisibilityViewer,
  ) {}

  async findAuthorized(workspaceId: string, id: string, userId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id, workspaceId, workspace: { members: { some: { userId } } } },
      select: {
        deletedAt: true,
        deletedBy: { select: { id: true, username: true, displayName: true } },
        id: true,
        workspaceId: true,
        name: true,
        displayName: true,
        description: true,
        role: true,
        visibility: true,
        createdAt: true,
        computerId: true,
        computer: {
          select: {
            id: true,
            ownerId: true,
            name: true,
            displayName: true,
            kind: true,
            computerVersion: true,
          },
        },
        runtimeConfig: true,
        stoppedAt: true,
        weeklyReportAssistant: { select: { id: true } },
        owner: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarObjectKey: true,
          },
        },
        avatarObjectKey: true,
      },
    });
    if (!agent) return undefined;
    // An existing-but-invisible Agent answers a stable "not visible" result, never its details —
    // distinct from the plain absence above so the profile panel can render the specific
    // "not visible" copy instead of a generic "not found".
    assertAgentVisible(this.viewer, { visibility: agent.visibility, ownerId: agent.owner.id });
    return agent;
  }
}
