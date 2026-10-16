import { AppError } from "#src/lib/app-error";
import {
  AgentMigrationSourceStopError,
  type AgentMigrationOrchestrator,
} from "./agent-migration-orchestrator.server";
import type { AgentRuntimeSelectionRefusal } from "#src/server/agents/agent-runtime-availability.server";
import type { AgentMigrationRequestRefusal, AgentMigrations } from "./agent-migrations.server";

/**
 * A person's side of moving an Agent to another Computer: asking for the move, canceling it, and
 * seeing how it is going. Whoever manages the Agent moves it, as in the reference Computer: its
 * owner and the Workspace's owners and admins, who also see the move; nobody else learns even that
 * it exists. Each refusal is an `AppError` whose
 * `errorId` names the reason, so the dialog can say it.
 */

type Principal = { userId: string; workspaceId: string };

/**
 * Whether a Computer can take part in a move now: connected and running a daemon that moves
 * Agents (`agent-migration:v1`), connected but too old to, or not connected.
 */
export type AgentMigrationReadiness = "ready" | "outdated" | "offline";

const READINESS_REFUSALS = {
  source: {
    outdated: "agent-migration-source-outdated",
    offline: "agent-migration-source-offline",
  },
  target: {
    outdated: "agent-migration-target-outdated",
    offline: "agent-migration-target-offline",
  },
} as const;

/** Why the target cannot run the Agent, as the dialog names it; one Computer page fixes each. */
const RUNTIME_REFUSALS: Record<AgentRuntimeSelectionRefusal, string> = {
  not_connected: "agent-migration-target-unavailable",
  runtime_unconfirmed: "agent-migration-runtime-unconfirmed",
  runtime_missing: "agent-migration-runtime-missing",
  runtime_not_shared: "agent-migration-runtime-not-shared",
  model_missing: "agent-migration-model-missing",
};

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
      /** Why the Computer cannot run the Agent's runtime for its owner, or null when it can. */
      runtimeRefusal(
        workspaceId: string,
        agentId: string,
        computerId: string,
      ): Promise<AgentRuntimeSelectionRefusal | null>;
      /** The Computer the Agent is placed on now, or null when it has none. */
      agentComputer(workspaceId: string, agentId: string): Promise<string | null>;
      computerReadiness(workspaceId: string, computerId: string): Promise<AgentMigrationReadiness>;
      /** The Workspace's Computers other than this one, by name. */
      otherComputers(
        workspaceId: string,
        exceptComputerId: string | null,
      ): Promise<{ id: string; name: string }[]>;
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
            sourceComputerName: await this.deps.computerName(latest.sourceComputerId),
            errorCode: latest.errorCode,
            updatedAt: latest.updatedAt.toISOString(),
          }
        : null,
    };
  }

  async request(principal: Principal, input: { agentId: string; targetComputerId: string }) {
    await this.#assertManager(principal, input.agentId);
    if (!(await this.deps.available()))
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "agent-migration-unavailable" });
    // Before anything stops: an old daemon on either side would ignore the move, leaving the
    // Agent stopped until its lease ran out. This is the only check: the dialog lists every
    // Computer, as Raft does, and says what this refusal names.
    const source = await this.#agentComputerReadiness(principal.workspaceId, input.agentId);
    if (source && source !== "ready")
      throw new AppError("TEMPORARILY_UNAVAILABLE", {
        errorId: READINESS_REFUSALS.source[source],
      });
    const target = await this.deps.computerReadiness(principal.workspaceId, input.targetComputerId);
    if (target !== "ready")
      throw new AppError("TEMPORARILY_UNAVAILABLE", {
        errorId: READINESS_REFUSALS.target[target],
      });
    // Before anything stops: an Agent moved where its runtime is missing could not start there.
    const runtimeRefusal = await this.deps.runtimeRefusal(
      principal.workspaceId,
      input.agentId,
      input.targetComputerId,
    );
    if (runtimeRefusal)
      throw new AppError("INVALID_INPUT", { errorId: RUNTIME_REFUSALS[runtimeRefusal] });
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
    await this.#assertManager(principal, input.agentId);
    const latest = await this.deps.migrations.latestForAgent(principal.workspaceId, input.agentId);
    if (latest?.id !== input.migrationId) throw new AppError("NOT_FOUND");
    await this.deps.orchestrator().cancel({
      workspaceId: principal.workspaceId,
      migrationId: input.migrationId,
    });
  }

  /**
   * The Computers the Agent could be moved to: every other one, unmarked. Whether one can
   * take part is decided when the move is asked for (`request`).
   */
  async targets(principal: Principal, agentId: string) {
    await this.#assertManager(principal, agentId);
    const current = await this.deps.agentComputer(principal.workspaceId, agentId);
    return this.deps.otherComputers(principal.workspaceId, current);
  }

  async #agentComputerReadiness(workspaceId: string, agentId: string) {
    const computerId = await this.deps.agentComputer(workspaceId, agentId);
    return computerId ? this.deps.computerReadiness(workspaceId, computerId) : null;
  }

  async #assertManager(principal: Principal, agentId: string) {
    const owner = await this.deps.agentOwner(principal.workspaceId, agentId);
    if (!owner) throw new AppError("NOT_FOUND");
    if (
      owner !== principal.userId &&
      !(await this.deps.isWorkspaceAdmin(principal.workspaceId, principal.userId))
    )
      throw new AppError("ACCESS_DENIED", { errorId: "agent-not-authorized" });
  }
}
