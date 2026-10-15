import { AppError } from "#src/lib/app-error";
import {
  AgentMigrationSourceStopError,
  type AgentMigrationOrchestrator,
} from "./agent-migration-orchestrator.server";
import type { AgentMigrationRequestRefusal, AgentMigrations } from "./agent-migrations.server";

/**
 * A person's side of moving an Agent to another Computer: asking for the move, canceling it, and
 * seeing how it is going. Only the Agent's owner moves it, the same rule as changing its Computer
 * (`ManageAgents.update`); the owner and the Workspace's owners and admins, who manage the Agent,
 * see the move, and nobody else learns even that it exists. Each refusal is an `AppError` whose
 * `errorId` names the reason, so the dialog can say it.
 */

type Principal = { userId: string; workspaceId: string };

/** The `AppError` each refusal of a request reaches its asker as. */
function refusalError(code: AgentMigrationRequestRefusal) {
  switch (code) {
    case "agent_not_found":
      return new AppError("NOT_FOUND");
    case "agent_unplaced":
      return new AppError("INVALID_INPUT", { errorId: "agent-migration-unplaced" });
    case "same_computer":
      return new AppError("INVALID_INPUT", { errorId: "agent-migration-same-computer" });
    case "target_unavailable":
      return new AppError("INVALID_INPUT", { errorId: "agent-migration-target-unavailable" });
    case "already_migrating":
      return new AppError("CONFLICT", { errorId: "agent-migrating" });
  }
}

export class AgentMigrationRequests {
  constructor(
    private readonly deps: {
      migrations: AgentMigrations;
      /**
       * Built only to start or cancel a move: it publishes to the Computers, which reading how a
       * move is going never does, so a deployment that cannot publish still shows the move.
       */
      orchestrator: () => Pick<AgentMigrationOrchestrator, "request" | "cancel">;
      /** The owner of a live Agent in the Workspace, or undefined when there is none. */
      agentOwner(workspaceId: string, agentId: string): Promise<string | undefined>;
      /** Whether the person is one of the Workspace's owners or admins. */
      isWorkspaceAdmin(workspaceId: string, userId: string): Promise<boolean>;
      /** A Computer's name as people see it, or null when it has none. */
      computerName(computerId: string): Promise<string | null>;
      /** Whether the Computer can run the Agent's runtime for its owner. */
      canRunAgent(workspaceId: string, agentId: string, computerId: string): Promise<boolean>;
      /** Whether this deployment has the migration bucket a move needs. */
      available(): Promise<boolean>;
    },
  ) {}

  /** The Agent's latest migration, and whether a new one can be asked for at all. */
  async status(principal: Principal, agentId: string) {
    const owner = await this.deps.agentOwner(principal.workspaceId, agentId);
    if (
      !owner ||
      (owner !== principal.userId &&
        !(await this.deps.isWorkspaceAdmin(principal.workspaceId, principal.userId)))
    )
      throw new AppError("NOT_FOUND");
    const [available, latest] = await Promise.all([
      this.deps.available(),
      this.deps.migrations.latestForAgent(principal.workspaceId, agentId),
    ]);
    return {
      available,
      migration: latest
        ? {
            id: latest.id,
            state: latest.state,
            sourceComputerId: latest.sourceComputerId,
            targetComputerId: latest.targetComputerId,
            targetComputerName: await this.deps.computerName(latest.targetComputerId),
            errorCode: latest.errorCode,
            updatedAt: latest.updatedAt.toISOString(),
          }
        : null,
    };
  }

  async request(principal: Principal, input: { agentId: string; targetComputerId: string }) {
    await this.#assertOwner(principal, input.agentId);
    if (!(await this.deps.available()))
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "agent-migration-unavailable" });
    // Before anything stops: an Agent moved where its runtime is missing could not start there.
    if (
      !(await this.deps.canRunAgent(principal.workspaceId, input.agentId, input.targetComputerId))
    )
      throw new AppError("INVALID_INPUT", { errorId: "agent-migration-runtime-unavailable" });
    let started: Awaited<ReturnType<AgentMigrationOrchestrator["request"]>>;
    try {
      started = await this.deps.orchestrator().request({
        workspaceId: principal.workspaceId,
        agentId: input.agentId,
        targetComputerId: input.targetComputerId,
        requestedByUserId: principal.userId,
      });
    } catch (error) {
      // The source never confirmed it stopped the Agent; the attempt has already been ended.
      if (error instanceof AgentMigrationSourceStopError)
        throw new AppError("TEMPORARILY_UNAVAILABLE", {
          errorId: "agent-migration-source-unreachable",
        });
      throw error;
    }
    if (started.status === "refused") throw refusalError(started.code);
    return { id: started.migration.id };
  }

  /** Cancels the move; one that has already ended is left as it is. */
  async cancel(principal: Principal, input: { agentId: string; migrationId: string }) {
    await this.#assertOwner(principal, input.agentId);
    const latest = await this.deps.migrations.latestForAgent(principal.workspaceId, input.agentId);
    if (latest?.id !== input.migrationId) throw new AppError("NOT_FOUND");
    await this.deps.orchestrator().cancel({
      workspaceId: principal.workspaceId,
      migrationId: input.migrationId,
    });
  }

  async #assertOwner(principal: Principal, agentId: string) {
    const owner = await this.deps.agentOwner(principal.workspaceId, agentId);
    if (!owner) throw new AppError("NOT_FOUND");
    if (owner !== principal.userId)
      throw new AppError("ACCESS_DENIED", { errorId: "agent-not-authorized" });
  }
}
