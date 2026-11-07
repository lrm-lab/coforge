import type { AgentControlResult } from "@lrm/coforge-sdk/internal";
import type { AgentControlDriver } from "./agent-control-driver.server";
import type { AgentControlSignal } from "./agent-control-signal.server";
import {
  commands,
  current,
  requireCurrentAgentScope,
  terminal,
  type AgentControlAgent,
  type AgentControlMentions,
  type AgentControlState,
  type AgentControlStore,
} from "./agent-control-types.server";

export type AgentLaunchClaim = {
  agentId: string;
  workspaceId: string;
  computerId: string;
  controlEpoch?: number;
  requestId?: string;
  launchId?: string;
};

/** Records why a settled control operation failed onto the Agent's display state, so every
 * managed path that lands in a terminal failure explains it — including launches whose
 * runtime_error Activity never reached the display. */
export type AgentStopReasonRecorder = (
  agent: Pick<AgentControlAgent, "id" | "workspaceId" | "computerId" | "visibility">,
  reason: string,
) => Promise<void>;

/** What the Daemon sends back about a control operation: launch checks and command results. */
export class AgentControlReceiver {
  constructor(
    private readonly store: AgentControlStore,
    private readonly signal: AgentControlSignal,
    private readonly driver: AgentControlDriver,
    /** Issues the tracked mentions again for a launch that started with its session. */
    private readonly mentions?: AgentControlMentions,
    private readonly stopReasons?: AgentStopReasonRecorder,
  ) {}

  /**
   * Verifies a launch before minting its credential; never accepts user-selected Session IDs.
   *
   * `launchId` is minted and persisted by `begin()`/`advance()`/`publishCurrent()` the
   * moment the operation enters "starting" — before this is ever called. This method only
   * verifies the Daemon's claimed `launchId` matches that already-stored value; it performs no
   * write, so there is no compare-and-swap race left to retry here (a concurrent Session write,
   * e.g. an `agent:session:invalidate`-triggered clear, cannot make a read-only check lose a
   * race the way the old read-validate-write pass could).
   */
  async authorizeLaunch(input: AgentLaunchClaim): Promise<void> {
    const agent = await this.store.get(input.agentId);
    if (!agent || agent.workspaceId !== input.workspaceId || agent.computerId !== input.computerId)
      throw new Error("Agent launch is not authorized");
    // Whatever the control state says, a Computer never launches an Agent being moved off it.
    if (agent.migrating) throw new Error("Agent is moving to another Computer");
    const state = agent.state;
    if (!state) {
      if (input.controlEpoch || input.requestId || input.launchId)
        throw new Error("Unsolicited managed launch");
      return;
    }
    if (!current(agent, state)) throw new Error("Stale Agent launch");
    const sameScope =
      state.requestId === input.requestId &&
      state.epoch === input.controlEpoch &&
      !!input.launchId &&
      state.launchId === input.launchId;
    if (state.phase === "starting") {
      if (sameScope) return;
      throw new Error("Stale Agent launch");
    }
    // A daemon-initiated wake resends the same requestId/controlEpoch/launchId this
    // Agent's last managed operation completed under, instead of a fresh managed scope. Accepted
    // only when that operation finished a chain that ends in `start` under the exact same scope,
    // and the Agent is not user-stopped — never for a superseded, failed, or stopped
    // operation. A completed `stop` chain also ends in phase "completed" (`advance()` has no next
    // step); it carries no `launchId`, so `sameScope` already excludes it, but the action is
    // checked explicitly so this never depends on that.
    if (state.phase === "completed" && state.action !== "stop" && sameScope && !agent.stoppedAt)
      return;
    throw new Error("Stale Agent launch");
  }
  /** RPC ACK follows conditional persistence; never acquires the control waiter's lock. */
  async result(claim: { workspaceId: string; computerId: string }, result: AgentControlResult) {
    const agent = await requireCurrentAgentScope(this.store, claim, result);
    const state = agent.state;
    if (result.sequence <= state.controlSequence) return;
    const command = Object.values(commands).find((command) => command.result === result.phase);
    if (command && state.phase !== command.pending) throw new Error("Unexpected command result");
    if (result.phase === "started" && (!result.launchId || state.launchId !== result.launchId))
      throw new Error("Unexpected launch result");
    if (terminal(state)) throw new Error("Operation already finished");
    if (result.phase === "workspace-reset" && result.identity)
      throw new Error("Reset retained old Session");
    const { identity: oldIdentity, errorCode: _oldError, ...fields } = state;
    const identity =
      result.phase === "started" && state.sessionSequence > result.sequence
        ? oldIdentity
        : (result.identity ?? oldIdentity);
    const identityChanged =
      result.phase === "started" &&
      !!oldIdentity?.sessionId &&
      !!result.identity?.sessionId &&
      oldIdentity.sessionId !== result.identity.sessionId;
    if (identityChanged && state.launchIdentityBound)
      throw new Error("Native Session identity changed during launch");
    const next: AgentControlState = {
      ...fields,
      controlSequence: result.sequence,
      phase: command?.completed ?? "failed",
      ...(result.phase === "started" && result.identity ? { launchIdentityBound: true } : {}),
      ...(state.recovered || (identityChanged && oldIdentity?.state !== "empty")
        ? { recovered: true }
        : {}),
      ...(identity ? { identity } : {}),
      ...(result.errorCode || state.errorCode
        ? { errorCode: result.errorCode ?? state.errorCode }
        : {}),
      ...((command?.completed ?? "failed") === "failed"
        ? { failedAtMs: state.failedAtMs ?? Date.now() }
        : {}),
    };
    if (!(await this.store.replace(agent, next))) throw new Error("Control result lost its fence");
    // A terminal failure is the one settlement every managed launch path shares; the display's
    // stop reason must not depend on a runtime_error Activity that some paths never send.
    // Retried attempts never reach "failed" — they keep the operation in "starting" — so this
    // fires exactly when the Agent has landed in a failure nothing automatic will retry.
    // A failed Stop is not a runtime failure and records nothing.
    if (next.phase === "failed" && next.errorCode && next.action !== "stop")
      void this.stopReasons?.(agent, next.errorCode).catch(() => {});
    console.info(
      JSON.stringify({
        event: "agent_control:result_received",
        action: state.action,
        phase: result.phase,
        request_id: result.requestId,
        agent_id: result.agentId,
        workspace_id: result.workspaceId,
        computer_id: claim.computerId,
        epoch: result.epoch,
        sequence: result.sequence,
      }),
    );
    // A launch that started with its session binds the Agent's current identity, as an accepted
    // session report does. The result's reply does not wait for the re-send, which logs its own
    // failures (`MentionDeliveryReports`).
    if (result.phase === "started" && result.identity)
      void this.mentions?.resendForCurrentSession({
        workspaceId: agent.workspaceId,
        computerId: claim.computerId,
        agentId: agent.id,
      });
    if (next.phase === "stopped" || next.phase === "workspace-reset") {
      // Publish failure stays silent so the waiter's fallback re-read republishes the phase.
      const advanced = await this.driver.advance(agent.id, next.requestId).then(
        () => true,
        () => false,
      );
      if (!advanced) return;
    }
    await this.signal.notify(agent.id).catch(() => {});
  }
}
