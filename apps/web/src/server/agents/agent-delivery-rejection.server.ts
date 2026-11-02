import type { AgentMessageDeliveryRejection } from "@lrm/coforge-sdk/internal";
import {
  controlOperationState,
  type AgentControl,
  type AgentControlAgent,
  type AgentControlRecoveryReader,
  type AgentControlStore,
} from "./agent-control.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import { agentStartIntent } from "./manage-agents.server";

/** What the server did about one rejected delivery. */
export type AgentDeliveryRejectionOutcome =
  | "woken"
  | "stopped"
  | "deleted"
  | "start_failed"
  | "operation_in_flight";

/** The rejecting Computer does not host this Agent in this Workspace. */
export class AgentDeliveryRejectionScopeError extends Error {
  constructor() {
    super("delivery rejection is not authorized");
    this.name = "AgentDeliveryRejectionScopeError";
  }
}

/**
 * A Daemon rejects a delivery (`no_process`) when the Agent has no process, no launch in
 * progress, and nothing the Daemon can relaunch it from. The delivery stays unread, so the server
 * decides whether to start the Agent, with the same recovery Start a Daemon `ready` sends.
 *
 * Unlike `ready` recovery it never starts an Agent whose latest Start ended failed, whatever the
 * failure: a launch that keeps failing would otherwise be retried for every message. That Agent
 * waits for a person's Start or the Daemon's next `ready`. It never starts a stopped Agent, and
 * leaves an operation already in flight alone instead of republishing it.
 */
export class AgentDeliveryRejections {
  constructor(
    private readonly store: Pick<AgentControlStore, "get">,
    private readonly conversations: AgentControlRecoveryReader,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly control: Pick<AgentControl, "recover">,
  ) {}

  async receive(
    scope: { workspaceId: string; computerId: string },
    rejection: AgentMessageDeliveryRejection,
  ): Promise<AgentDeliveryRejectionOutcome> {
    // Most rejections start nothing; only one that might start the Agent takes its lock.
    const unlocked = settledOutcome(await this.#read(scope, rejection));
    const outcome =
      unlocked ??
      (await this.runtimeLock.run(rejection.agentId, async () => {
        const agent = await this.#read(scope, rejection);
        return settledOutcome(agent) ?? (await this.#wake(agent));
      }));
    log("agent_delivery:rejected", scope, rejection, { outcome });
    return outcome;
  }

  async #read(
    scope: { workspaceId: string; computerId: string },
    rejection: AgentMessageDeliveryRejection,
  ): Promise<AgentControlAgent> {
    const agent = await this.store.get(rejection.agentId);
    if (
      !agent ||
      agent.workspaceId !== scope.workspaceId ||
      agent.computerId !== scope.computerId
    ) {
      log("agent_delivery:rejection_refused", scope, rejection, {
        refused_because: agent ? "scope_mismatch" : "agent_not_found",
      });
      throw new AgentDeliveryRejectionScopeError();
    }
    return agent;
  }

  async #wake(agent: AgentControlAgent): Promise<AgentDeliveryRejectionOutcome> {
    const recovery = await this.conversations.readAgentRecoveryContext(agent.workspaceId, agent.id);
    // `agent` is this rejection's read under the lock, so recovery does not read it again.
    await this.control.recover(
      { ...agentStartIntent(agent, agent.computerId), ...recovery },
      agent.ownerId,
      agent,
    );
    return "woken";
  }
}

const NON_RETRYABLE_ERROR_CODES = new Set([
  "runtime_private",
  "runtime_not_installed",
  "runtime_unusable",
  "runtime_unavailable",
  "runtime_login_required",
  "agent_environment_invalid",
  "model_provider_not_configured",
]);

/** Minimum wait before a transient launch failure is allowed to retry on incoming message (10 min). */
export const TRANSIENT_FAILURE_RETRY_INTERVAL_MS = 10 * 60 * 1_000;
/** Maximum window for automatic low-frequency retry before giving up permanently (24 hours). */
export const TRANSIENT_FAILURE_MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

function isEligibleForTransientRetry(agent: AgentControlAgent, now: number): boolean {
  const state = agent.state;
  if (!state || state.phase !== "failed") return false;
  if (state.errorCode && NON_RETRYABLE_ERROR_CODES.has(state.errorCode)) return false;
  if (!state.failedAtMs) return false;
  const elapsed = now - state.failedAtMs;
  return (
    elapsed >= TRANSIENT_FAILURE_RETRY_INTERVAL_MS && elapsed <= TRANSIENT_FAILURE_MAX_WINDOW_MS
  );
}

/** The outcome for an Agent this rejection must not start, or `undefined` when it may. */
function settledOutcome(
  agent: AgentControlAgent,
  now = Date.now(),
): AgentDeliveryRejectionOutcome | undefined {
  if (agent.deletedAt) return "deleted";
  if (agent.stoppedAt) return "stopped";
  switch (controlOperationState(agent)) {
    case "in_flight":
      return "operation_in_flight";
    case "failed":
      if (isEligibleForTransientRetry(agent, now)) return undefined;
      return "start_failed";
    case "settled":
      return undefined;
  }
}

function log(
  event: string,
  scope: { workspaceId: string; computerId: string },
  rejection: AgentMessageDeliveryRejection,
  fields: Record<string, string>,
) {
  console.info(
    JSON.stringify({
      event,
      workspace_id: scope.workspaceId,
      computer_id: scope.computerId,
      agent_id: rejection.agentId,
      delivery_id: rejection.deliveryId,
      rejection_reason: rejection.reason,
      ...fields,
    }),
  );
}
