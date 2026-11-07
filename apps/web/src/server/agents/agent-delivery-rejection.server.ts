import type { AgentMessageDeliveryRejection } from "@lrm/coforge-sdk/internal";
import {
  controlOperationState,
  isEligibleForTransientRetry,
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
 * The start decision is the one `AgentControl.recover` applies: never a stopped or deleted
 * Agent, and a failed latest operation retried only inside the bounded transient window
 * (`isEligibleForTransientRetry`), so a launch that keeps failing is not retried for every
 * message. Unlike `ready` recovery it never republishes an operation already in flight — that
 * Start is left to finish or fail on its own.
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
