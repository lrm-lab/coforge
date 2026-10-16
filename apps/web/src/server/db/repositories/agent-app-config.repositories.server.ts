import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type {
  AgentAppConfigRepository,
  StoredAgentAppConfig,
} from "#src/server/agent-app-configs/agent-app-configs.server";

/** Agent App configuration rows; which Apps exist and their rules stay in
 * `server/agent-app-configs/`. */
export class PrismaAgentAppConfigRepository implements AgentAppConfigRepository {
  constructor(private readonly db: PrismaClient) {}

  async placement(agentId: string) {
    return (
      (await this.db.agent.findFirst({
        where: { id: agentId, ...ACTIVE_AGENT_WHERE },
        select: { workspaceId: true, computerId: true },
      })) ?? undefined
    );
  }

  async list(agentId: string): Promise<StoredAgentAppConfig[]> {
    return this.db.agentAppConfig.findMany({
      where: { agentId },
      select: { appId: true, revision: true, config: true },
    });
  }
}
