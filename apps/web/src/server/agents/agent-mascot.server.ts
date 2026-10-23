import { appNotificationsPossible } from "#src/server/app-notifications/app-notifications.server";
import { recordAgentProfileUpdated } from "#src/server/app-notifications/agent-events.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { agentAvatarUrl, type AgentMascot } from "#src/features/agents/agent-mascot";

/**
 * The creator's pick of one Agent's platform mascot. Every Workspace member reads the picture
 * through `agentAvatarUrl`; only the creator may change the pick. A deleted Agent has none to change.
 */
export class AgentMascots {
  constructor(private readonly db: PrismaClient) {}

  /** `mascot` is validated at the Server Function boundary (`setAgentMascot`). */
  async set(workspaceId: string, userId: string, agentId: string, mascot: AgentMascot) {
    const current = await this.#owned(workspaceId, userId, agentId);
    if (
      current.avatarMascot !== mascot &&
      !(await this.#write(workspaceId, agentId, current.avatarMascot, mascot))
    ) {
      throw new AppError("CONFLICT");
    }
    return { avatarUrl: agentAvatarUrl(agentId, mascot) };
  }

  /** Compare-and-swap on the pick this change replaces; records `agent.profile_updated` for the
   * apps installed when it wins. Says whether it did. */
  async #write(
    workspaceId: string,
    agentId: string,
    replacing: string | null,
    mascot: AgentMascot,
  ) {
    const where = { id: agentId, avatarMascot: replacing };
    const data = { avatarMascot: mascot };
    if (!appNotificationsPossible())
      return (await this.db.agent.updateMany({ where, data })).count > 0;
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.agent.updateMany({ where, data });
      if (count) await recordAgentProfileUpdated(tx, workspaceId, agentId, ["avatar"]);
      return count > 0;
    });
  }

  async #owned(workspaceId: string, userId: string, agentId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { ownerId: true, avatarMascot: true },
    });
    if (!agent) throw new AppError("NOT_FOUND");
    if (agent.ownerId !== userId) throw new AppError("ACCESS_DENIED");
    return agent;
  }
}
