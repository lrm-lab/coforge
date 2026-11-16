import { AppError } from "#src/lib/app-error";
import {
  assertCanCreateAgents,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import type { AgentCreateInput } from "./manage-agents.server";
import { CLOUD_AGENT_RUNTIME, type CloudAgentComputer } from "./cloud-agent-computer.server";

type Principal = { userId: string; workspaceId: string; role: WorkspaceMemberRole };
type CreatedAgent = {
  id: string;
  ownerId: string;
  deletedAt: Date | null;
  stoppedAt?: Date | null;
};

export class CreateCloudAgent {
  constructor(
    private readonly ports: {
      findByRequest(workspaceId: string, requestId: string): Promise<CreatedAgent | null>;
      cloudComputer(principal: Principal): Promise<CloudAgentComputer>;
      create(
        principal: Principal,
        input: AgentCreateInput,
      ): Promise<{ agent: { id: string }; startPublished: boolean }>;
      start(principal: Principal, agentId: string): Promise<void>;
    },
  ) {}

  async execute(
    principal: Principal,
    input: { name: string; displayName?: string; requestId: string },
  ) {
    assertCanCreateAgents(principal.role);
    const existing = await this.ports.findByRequest(principal.workspaceId, input.requestId);
    if (existing) return this.result(principal, existing);
    const computer = await this.ports.cloudComputer(principal);
    if (computer.state !== "ready") return { status: "unavailable" as const };
    try {
      const created = await this.ports.create(principal, {
        name: input.name,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        createRequestId: input.requestId,
        description: "",
        computerId: computer.computerId,
        ...CLOUD_AGENT_RUNTIME,
        visibility: "private",
      });
      return {
        status: created.startPublished ? ("created" as const) : ("start-deferred" as const),
        agentId: created.agent.id,
      };
    } catch (error) {
      const committed = await this.ports.findByRequest(principal.workspaceId, input.requestId);
      if (committed) return this.result(principal, committed);
      throw error;
    }
  }

  private async result(principal: Principal, agent: CreatedAgent) {
    if (agent.ownerId !== principal.userId) throw new AppError("ACCESS_DENIED");
    if (agent.deletedAt) throw new AppError("NOT_FOUND");
    if (agent.stoppedAt) return { status: "created" as const, agentId: agent.id };
    try {
      await this.ports.start(principal, agent.id);
    } catch {
      return { status: "start-deferred" as const, agentId: agent.id };
    }
    return { status: "created" as const, agentId: agent.id };
  }
}
