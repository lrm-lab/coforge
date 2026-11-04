import { AppError } from "#src/lib/app-error";
import { errorType } from "#src/server/errors/error-type.server";
import type { AgentControlAccess } from "./agent-control-access.server";
import {
  agentControlRevision,
  current,
  operationFence,
  type AgentControlAction,
  type AgentControlAgent,
  type AgentControlMentions,
  type AgentControlState,
  type AgentControlStore,
} from "./agent-control-types.server";

/** Writes the one current control operation on the Agent record. */
export class AgentControlOperations {
  constructor(
    private readonly store: AgentControlStore,
    private readonly access: AgentControlAccess,
    /** Settles the tracked mentions a person's Stop leaves undelivered. */
    private readonly mentions?: AgentControlMentions,
  ) {}

  /** A person stopped the Agent: its pending tracked mentions will not be launched. The stop is
   * already recorded, so a failure here is logged and never fails it. */
  private async settleStoppedMentions(agent: AgentControlAgent, stoppedAt: Date) {
    try {
      await this.mentions?.settleStopped({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        stoppedAt,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_control:stopped_mentions_failed",
          agent_id: agent.id,
          workspace_id: agent.workspaceId,
          error_type: errorType(error),
        }),
      );
    }
  }
  async begin(
    agent: AgentControlAgent,
    action: AgentControlAction,
    requestId: string,
    attempt = 1,
    /** `undefined` leaves the Agent's persisted stopped state unchanged (every caller
     * except `execute()` — `recover`, and `begin`'s own CAS retries, must never touch it). */
    stoppedAt?: Date | null,
  ): Promise<AgentControlState> {
    // Every Start, Restart and Reset begins here; a Stop is what a migration itself needs.
    if (action !== "stop" && agent.migrating)
      throw new AppError("CONFLICT", { errorId: "agent-migrating" });
    const old = agent.state;
    if (old?.requestId === requestId) {
      if (old.action !== action || !current(agent, old)) throw new Error("Operation scope changed");
      return old;
    }
    // Latest requestId supersedes every state, including Full Reset clearing: increment epoch,
    // retain identity under the Computer/provider rule, and drop launchId/launchIdentityBound.
    // Supersession is normal, logged once at info; there is no pending refusal or abandoned state.
    if (old)
      console.info(
        JSON.stringify({
          event: "agent_control:operation_superseded",
          agent_id: agent.id,
          workspace_id: agent.workspaceId,
          computer_id: agent.computerId,
          previous_action: old.action,
          previous_phase: old.phase,
          previous_epoch: old.epoch,
          previous_request_id: old.requestId,
          new_action: action,
          request_id: requestId,
          outcome: "superseded",
        }),
      );
    const retain =
      old && old.computerId === agent.computerId && old.provider === agent.runtimeConfig.runtime;
    const identity = retain ? old.identity : !old ? agent.identity : undefined;
    // The server mints one launchId per operation's start step, the moment the
    // operation enters phase "starting", in this same compare-and-swap write — never later, and
    // never re-minted for a republish of the same operation (`state.requestId === requestId`
    // stays idempotent above and never reaches here; `advance()` mints its own when a chain's
    // stop/clear steps finish and it moves into "starting"). The Daemon no longer mints its own.
    const state: AgentControlState = {
      version: 1,
      protocolMajor: 1,
      requestId,
      workspaceId: agent.workspaceId,
      computerId: agent.computerId,
      agentId: agent.id,
      provider: agent.runtimeConfig.runtime,
      epoch: (old?.epoch ?? 0) + 1,
      action,
      phase: action === "start" ? "starting" : "stopping",
      configRevision: agentControlRevision(agent.runtimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      ...(identity ? { identity } : {}),
      ...(action === "start" ? { launchId: crypto.randomUUID() } : {}),
    };
    if (
      await this.store.replace(agent, state, stoppedAt !== undefined ? { stoppedAt } : undefined)
    ) {
      if (stoppedAt) await this.settleStoppedMentions(agent, stoppedAt);
      return state;
    }

    // Session reports do not take the runtime lock. Reauthorize and rebuild from
    // their fresh identity, but never absorb a configuration or operation change.
    const refreshed = await this.access.authorized(agent.ownerId, agent.workspaceId, agent.id);
    if (
      refreshed.computerId !== agent.computerId ||
      !Bun.deepEquals(refreshed.runtimeConfig, agent.runtimeConfig, true) ||
      !Bun.deepEquals(
        refreshed.storedRuntimeConfig ?? refreshed.runtimeConfig,
        agent.storedRuntimeConfig ?? agent.runtimeConfig,
        true,
      ) ||
      !Bun.deepEquals(operationFence(refreshed.state), operationFence(old), true) ||
      (refreshed.state?.sessionSequence ?? 0) < (old?.sessionSequence ?? 0)
    )
      throw new Error("Agent configuration or control operation changed");
    if (attempt === 3)
      throw new Error("Agent control could not begin after 3 compare-and-swap attempts");
    return this.begin(refreshed, action, requestId, attempt + 1, stoppedAt);
  }
}
