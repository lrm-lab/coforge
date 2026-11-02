import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import {
  assertCanCreateAgents,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import type { AgentCreateInput } from "./manage-agents.server";
import type { AgentRuntimeSelection } from "./agent-runtime-availability.server";

type Principal = { userId: string; workspaceId: string; role: WorkspaceMemberRole };
type CreatedAgent = {
  id: string;
  ownerId: string;
  deletedAt: Date | null;
  stoppedAt?: Date | null;
};
const configuredPi = { provider: RUNTIME_PROVIDER.PI, model: "", modelProvider: "", reasoning: "" };

/** Retryable provisioning uses an ordinary Agent and its ordinary runtime validation/start. */
export class CreateCloudAgent {
  constructor(
    private readonly ports: {
      /** The Agent an earlier attempt of this request created, if one did. */
      findByRequest(workspaceId: string, requestId: string): Promise<CreatedAgent | null>;
      ensureComputer(
        principal: Principal,
      ): Promise<{ computerId: string; containerReady: boolean }>;
      canRun(
        principal: Principal,
        computerId: string,
        selection: AgentRuntimeSelection,
      ): Promise<boolean>;
      create(
        principal: Principal,
        input: AgentCreateInput,
      ): Promise<{ agent: { id: string }; startPublished: boolean }>;
      start(principal: Principal, agentId: string): Promise<void>;
    },
  ) {}

  /** `name` is the username the user typed, as a local Agent's is. A request answered late or
   * lost is retried with its `requestId`, stored on the Agent it created: the retry gets that
   * Agent back, whatever name it now carries, and another request for a held name is refused. */
  async execute(
    principal: Principal,
    input: { name: string; displayName?: string; requestId: string },
  ) {
    assertCanCreateAgents(principal.role);
    const existing = await this.ports.findByRequest(principal.workspaceId, input.requestId);
    if (existing) return this.result(principal, existing);
    const computer = await this.ports.ensureComputer(principal);
    if (!computer.containerReady) return { status: "preparing" as const };
    if (
      !(await this.ports.canRun(principal, computer.computerId, {
        ...configuredPi,
        hasApiKey: false,
      }))
    )
      return { status: "preparing" as const };
    try {
      const created = await this.ports.create(principal, {
        name: input.name,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        createRequestId: input.requestId,
        description: "",
        computerId: computer.computerId,
        // Inherit Pi's configured model, reasoning, and credentials on the cloud Computer.
        ...configuredPi,
        visibility: "private",
      });
      return {
        status: created.startPublished ? ("created" as const) : ("start-deferred" as const),
        agentId: created.agent.id,
      };
    } catch (error) {
      // A concurrent attempt of this request may have won the unique request-id write.
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
