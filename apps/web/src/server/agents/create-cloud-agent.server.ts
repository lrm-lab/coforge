import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { nameToSlug } from "#src/lib/slug";
import {
  assertCanCreateAgents,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import type { AgentCreateInput } from "./manage-agents.server";

type Principal = { userId: string; workspaceId: string; role: WorkspaceMemberRole };
type CreatedAgent = {
  id: string;
  ownerId: string;
  deletedAt: Date | null;
  stoppedAt?: Date | null;
};
type Model = { id: string; modelProvider: string; name?: string };

/** Retryable provisioning uses an ordinary Agent and its ordinary runtime validation/start. */
export class CreateCloudAgent {
  constructor(
    private readonly ports: {
      find(workspaceId: string, name: string): Promise<CreatedAgent | null>;
      ensureComputer(
        principal: Principal,
      ): Promise<{ computerId: string; containerReady: boolean }>;
      /** Null until Pi has reported; an empty report means no models are configured. */
      models(principal: Principal, computerId: string): Promise<Model[] | null>;
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
    const models = await this.ports.models(principal, computer.computerId);
    if (models === null) return { status: "preparing" as const };
    const model = models.find((model) => /deepseek/i.test(`${model.id} ${model.name ?? ""}`));
    if (!model)
      throw new AppError("INVALID_INPUT", { errorId: "cloud-agent-deepseek-unavailable" });
    try {
      const created = await this.ports.create(principal, {
        name,
        displayName: input.name.trim(),
        description: "",
        computerId: computer.computerId,
        provider: RUNTIME_PROVIDER.PI,
        model: model.id,
        modelProvider: model.modelProvider,
        reasoning: "",
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
