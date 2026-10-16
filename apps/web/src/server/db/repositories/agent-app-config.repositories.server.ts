import type { PrismaClient } from "#src/generated/prisma/client";
import type { AppConfigValues } from "@lrm/coforge-sdk/internal";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
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

  async get(agentId: string, appId: string): Promise<StoredAgentAppConfig | undefined> {
    return (
      (await this.db.agentAppConfig.findUnique({
        where: { agentId_appId: { agentId, appId } },
        select: { appId: true, revision: true, config: true },
      })) ?? undefined
    );
  }

  /** A compare-and-set on the row's revision; the first write creates the row at revision 1, and
   * a concurrent first write loses on the `(agentId, appId)` unique key. */
  async write(agentId: string, appId: string, expectedRevision: number, config: AppConfigValues) {
    if (expectedRevision === 0) {
      try {
        await this.db.agentAppConfig.create({ data: { agentId, appId, revision: 1, config } });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    }
    const { count } = await this.db.agentAppConfig.updateMany({
      where: { agentId, appId, revision: expectedRevision },
      data: { revision: expectedRevision + 1, config },
    });
    return count === 1;
  }
}
