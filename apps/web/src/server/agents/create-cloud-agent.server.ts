import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { nameToSlug } from "#src/lib/slug";
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
      find(workspaceId: string, name: string): Promise<CreatedAgent | null>;
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

  async execute(principal: Principal, input: { name: string; requestId: string }) {
    assertCanCreateAgents(principal.role);
    // Keep the visible name in any language, with a stable handle for response-loss retries.
    const name = `${nameToSlug(input.name, 20) || "bot"}-${input.requestId}`;
    const existing = await this.ports.find(principal.workspaceId, name);
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
        name,
        displayName: input.name.trim(),
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
      // A concurrent retry may have won the unique-name write.
      const committed = await this.ports.find(principal.workspaceId, name);
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
