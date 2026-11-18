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
import type { AgentWakeBlockReason, AgentWakeBlockWriter } from "./agent-wake-block.server";
import { agentStartIntent } from "./manage-agents.server";

/** What the server did about one rejected delivery. */
export type AgentDeliveryRejectionOutcome =
  | "woken"
  | "stopped"
  | "deleted"
  | "start_failed"
  | "operation_in_flight";

type SettledOutcome = {
  outcome: AgentDeliveryRejectionOutcome;
  /** When this round of not waking began: the Stop, or the failed Start, the messages wait on. */
  roundStart?: Date;
};

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
    private readonly wakeBlocks?: AgentWakeBlockWriter,
  ) {}

  async receive(
    scope: { workspaceId: string; computerId: string },
    rejection: AgentMessageDeliveryRejection,
  ): Promise<AgentDeliveryRejectionOutcome> {
    // Most rejections start nothing; only one that might start the Agent takes its lock.
    const unlocked = settledOutcome(await this.#read(scope, rejection));
    const settled =
      unlocked ??
      (await this.runtimeLock.run(rejection.agentId, async () => {
        const agent = await this.#read(scope, rejection);
        const underLock = settledOutcome(agent);
        if (underLock) return underLock;
        await this.#wake(agent);
        return { outcome: "woken" as const };
      }));
    log("agent_delivery:rejected", scope, rejection, { outcome: settled.outcome });
    await this.#recordWakeBlock(scope, rejection, settled);
    return settled.outcome;
  }

  async #recordWakeBlock(
    scope: { workspaceId: string; computerId: string },
    rejection: AgentMessageDeliveryRejection,
    settled: SettledOutcome,
  ): Promise<void> {
    const reason = wakeBlockReason(settled.outcome);
    if (!this.wakeBlocks || !reason) return;
    await this.wakeBlocks
      .record(rejection.agentId, reason, settled.roundStart)
      .catch((error: unknown) => {
        log("agent_delivery:wake_block_write_failed", scope, rejection, { error: String(error) });
      });
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
function settledOutcome(agent: AgentControlAgent, now = Date.now()): SettledOutcome | undefined {
  if (agent.deletedAt) return { outcome: "deleted" };
  if (agent.stoppedAt) return { outcome: "stopped", roundStart: new Date(agent.stoppedAt) };
  switch (controlOperationState(agent)) {
    case "in_flight":
      return { outcome: "operation_in_flight" };
    case "failed": {
      if (isEligibleForTransientRetry(agent, now)) return undefined;
      const failedAtMs = agent.state?.failedAtMs;
      return {
        outcome: "start_failed",
        ...(typeof failedAtMs === "number" ? { roundStart: new Date(failedAtMs) } : {}),
      };
    }
    case "settled":
      return undefined;
  }
}

function wakeBlockReason(outcome: AgentDeliveryRejectionOutcome): AgentWakeBlockReason | undefined {
  return outcome === "stopped" || outcome === "start_failed" || outcome === "operation_in_flight"
    ? outcome
    : undefined;
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
