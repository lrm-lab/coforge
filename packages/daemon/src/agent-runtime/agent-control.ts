import { getLogger } from "@logtape/logtape";
import type {
  AgentControlScope,
  AgentStartIntent,
  AgentWorkspaceResetRequest,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeState } from "./agent-runtime-state";
import type { AgentSessions } from "./agent-session";
import type { AgentControlContext, AgentControlRuntime } from "./agent-control-runtime";
import { ManagedLaunches } from "./agent-control-launch";
import {
  assertPhaseInvariants,
  fence,
  repairStaleRecord,
  requireRecord,
} from "./agent-control-fence";
import { rebindRunning } from "./agent-control-rebind";
import { replayAgentControlResults, withoutStartPrompts } from "./agent-control-replay";
import { systemLaunchRetryScheduler, type LaunchRetryScheduler } from "./launch-retry-scheduler";

export type { LaunchRetryScheduler };

const logger = getLogger(["coforge", "daemon", "agent-control"]);

/** Owns separate stop, workspace reset, and start primitives. */
export class AgentControl {
  readonly #known = new Set<string>();
  readonly #context: AgentControlContext;
  readonly #launches: ManagedLaunches;
  constructor(
    instanceId: string,
    state: AgentRuntimeState,
    sessions: AgentSessions,
    runtime: AgentControlRuntime,
    launchRetryScheduler: LaunchRetryScheduler = systemLaunchRetryScheduler,
  ) {
    this.#context = { instanceId, state, sessions, runtime };
    this.#launches = new ManagedLaunches(this.#context, launchRetryScheduler);
  }
  managed(agentId: string) {
    return this.#known.has(agentId);
  }
  stop(scope: AgentControlScope): Promise<void> {
    const known = this.#known.has(scope.agentId);
    this.#known.add(scope.agentId);
    return this.#context.state.run(scope.agentId, async () => {
      let record = await this.#context.state.store.read(scope.agentId);
      await requireRecord(record, known);
      record = await repairStaleRecord(this.#context, scope.agentId, record);
      fence(record, scope);
      if (record?.scope.epoch === scope.epoch && record.stopResult) {
        if (record.stopResult.requestId !== scope.requestId)
          throw new Error("control_request_mismatch");
        await this.#context.runtime.result(record.stopResult).catch(() => {});
        return;
      }
      if (record?.scope.epoch === scope.epoch && record.phase === "failed")
        throw new Error("previous_control_not_completed");
      // An accepted Stop supersedes any pending automatic launch retry: the streak and the armed
      // retry both belong to the launch operation this Stop is ending. Cleared only after every
      // validation above passed, so a stale/out-of-scope Stop cannot disarm a live retry.
      this.#launches.supersede(scope.agentId);
      this.#context.runtime.stopAccepted?.(scope.agentId);
      const resetWorkspaceRequired =
        record?.action === "reset-workspace" && record.phase !== "workspace-reset";
      record = {
        version: 1,
        scope,
        action: resetWorkspaceRequired ? "reset-workspace" : "stop",
        phase: "stopping",
        daemonInstanceId: this.#context.instanceId,
        sequence: record?.scope.epoch === scope.epoch ? record.sequence : 0,
        ...(record?.identity ? { identity: record.identity } : {}),
      };
      await this.#context.state.store.write(scope.agentId, record);
      try {
        const identity = await this.#context.runtime.stop(scope.agentId);
        this.#context.sessions.capture(record, identity ?? record.identity);
        // A Stop receipt proves exit, not completion of interrupted deletion.
        record.phase = resetWorkspaceRequired ? "clearing" : "stopped";
        record.stopResult = {
          ...scope,
          phase: "stopped",
          sequence: ++record.sequence,
          ...(record.identity ? { identity: record.identity } : {}),
        };
        record.lastResult = record.stopResult;
      } catch (error) {
        // A process that will not exit does not reach here: the runtime's stop completes without
        // it. Only a defect does, and its receipt is terminal for this request.
        record.phase = "stopping";
        record.stopResult = {
          ...scope,
          phase: "failed",
          sequence: ++record.sequence,
          errorCode: "stop_failed",
        };
        record.lastResult = record.stopResult;
        logger.warning("Agent Stop failed", {
          event: "agent_control:stop_failed",
          agent_id: scope.agentId,
          error_code: diagnosticErrorCode(error),
        });
      }
      await this.#context.state.store.write(scope.agentId, record);
      await this.#context.runtime.result(record.lastResult).catch(() => {});
      assertPhaseInvariants(this.#context, scope.agentId, record);
    });
  }
  resetWorkspace(scope: AgentWorkspaceResetRequest): Promise<void> {
    return this.#context.state.run(scope.agentId, async () => {
      let record = await this.#context.state.store.read(scope.agentId);
      record = await repairStaleRecord(this.#context, scope.agentId, record);
      fence(record, scope);
      if (!record || record.scope.epoch !== scope.epoch || record.stopResult?.phase !== "stopped")
        throw new Error("confirmed_stop_required");
      this.#known.add(scope.agentId);
      if (record.workspaceResetResult) {
        if (record.workspaceResetResult.requestId !== scope.requestId)
          throw new Error("control_request_mismatch");
        await this.#context.runtime.result(record.workspaceResetResult).catch(() => {});
        return;
      }
      if (
        !["stopped", "clearing"].includes(record.phase) ||
        record.startResult ||
        this.#context.runtime.running(scope.agentId)
      )
        throw new Error("confirmed_stop_required");
      record.action = "reset-workspace";
      record.phase = "clearing";
      await this.#context.state.store.write(scope.agentId, record);
      // A clear failure is non-fatal (liveness over durable receipts): it never latches the
      // Agent into a terminal state only an explicit reset retry could leave. The session
      // association is still cleared locally and the chain still proceeds to Start. The failure
      // is only logged: there is no result field, state, or anything else that blocks a later
      // agent:start.
      let workspaceClearError = false;
      try {
        await this.#context.state.store.clearWorkspace(scope.agentId);
      } catch (error) {
        workspaceClearError = true;
        logger.error("Agent workspace clear did not complete", {
          event: "agent_control:workspace_clear_failed",
          request_id: scope.requestId,
          workspace_id: scope.workspaceId,
          computer_id: scope.computerId,
          agent_id: scope.agentId,
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
      }
      this.#context.sessions.clear(record);
      record.phase = "workspace-reset";
      record.workspaceResetResult = {
        ...scope,
        phase: "workspace-reset",
        sequence: ++record.sequence,
        ...(workspaceClearError ? { errorCode: "workspace_clear_failed" } : {}),
      };
      record.lastResult = record.workspaceResetResult;
      await this.#context.state.store.write(scope.agentId, record);
      await this.#context.runtime.result(record.lastResult).catch(() => {});
    });
  }
  /** Whether a Start is pending for this Agent: from the synchronous `start` call, through every
   * launch attempt and the cooldown before each automatic retry, until it launches or ends;
   * `runtime.startSettled` fires once when it turns false. */
  startPending(agentId: string): boolean {
    return this.#launches.startPending(agentId);
  }

  start(intent: AgentStartIntent): Promise<void> {
    return this.#launches.track(intent.agentId, () => this.#start(intent));
  }

  #start(intent: AgentStartIntent): Promise<void> {
    const known = this.#known.has(intent.agentId);
    this.#known.add(intent.agentId);
    return this.#context.state.run(intent.agentId, async () => {
      if (!intent.controlEpoch) throw new Error("control_epoch_required");
      const scope: AgentControlScope = {
        protocolMajor: 1,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        computerId: intent.computerId,
        agentId: intent.agentId,
        provider: intent.provider,
        epoch: intent.controlEpoch,
      };
      let record = await this.#context.state.store.read(intent.agentId);
      await requireRecord(record, known);
      record = await repairStaleRecord(this.#context, intent.agentId, record);
      fence(record, scope);
      if (record?.scope.epoch === scope.epoch && record.startResult) {
        if (record.startResult.requestId !== scope.requestId)
          throw new Error("control_request_mismatch");
        if (
          record.phase === "running" &&
          this.#context.runtime.running(intent.agentId) &&
          intent.wakeMessage
        )
          // A replay of the same Start: its prompts were already delivered.
          await this.#context.runtime.wake?.(withoutStartPrompts(intent));
        await this.#context.runtime.result(record.startResult).catch(() => {});
        return;
      }
      // A newer operation supersedes our own pending launch retry. The record still says
      // "starting" because that retry has not given up yet, but the retry is a daemon-side timer,
      // never a concurrent launch — so refusing the fresher operation would block a user's
      // Start/Restart for the whole retry window for no reason. Drop the retry (and its streak)
      // and let this operation launch, exactly as a record the previous failure had marked
      // "failed" did before retries existed.
      const supersededRetry =
        record !== undefined &&
        record.phase === "starting" &&
        record.scope.epoch < scope.epoch &&
        this.#launches.hasRetry(scope.agentId);
      if (supersededRetry) {
        this.#launches.supersede(scope.agentId);
      } else if (
        record &&
        (["stopping", "clearing", "starting"].includes(record.phase) ||
          (record.phase === "failed" && record.scope.epoch === scope.epoch))
      )
        throw new Error("previous_control_not_completed");
      if (!intent.launchId) {
        // The server mints and supplies launchId for every managed start; the SDK
        // decode step already rejects a controlEpoch-carrying intent with none, so this is a
        // defensive, should-not-happen guard. Checked before the running-process branch below:
        // a rebind needs a launchId to adopt just as much as a fresh launch needs one to use.
        await this.#context.runtime
          .result({
            ...scope,
            phase: "failed",
            sequence: (record?.scope.epoch === scope.epoch ? record.sequence : 0) + 1,
            errorCode: "agent_launch_id_required",
          })
          .catch(() => {});
        throw new Error("agent_launch_id_required");
      }
      if (this.#context.runtime.running(intent.agentId)) {
        const runningSessionId = record?.identity?.sessionId;
        // A different native session must not keep the previous process. Rebind
        // only adopts a new control scope for the session already running.
        if (intent.sessionId && runningSessionId && intent.sessionId !== runningSessionId) {
          await this.#context.runtime.stop(intent.agentId);
        } else if (
          // Same native session, older terminal operation — adopt the new scope
          // instead of spawning. A different sessionId is handled above and must not rebind.
          record &&
          record.phase === "running" &&
          record.launchId &&
          record.scope.provider === scope.provider &&
          scope.epoch > record.scope.epoch
        )
          return rebindRunning(this.#context, record, scope, intent);
        else {
          // The process is running but there is no matching running record to rebind to (the
          // record is missing, or claims a different phase — should not happen). Send a failed
          // result so the server's new operation terminates instead of hanging forever, then
          // still throw so this stays diagnosable (`control_code` logging).
          const sequence = (record?.scope.epoch === scope.epoch ? record.sequence : 0) + 1;
          await this.#context.runtime
            .result({ ...scope, phase: "failed", sequence, errorCode: "agent_already_running" })
            .catch(() => {});
          throw new Error("agent_already_running");
        }
      }
      if (!record || record.scope.epoch !== scope.epoch)
        record = {
          version: 1,
          scope,
          action: "start",
          phase: "stopped",
          sequence: 0,
          daemonInstanceId: this.#context.instanceId,
        };
      await this.#launches.attempt(intent, scope, record, intent.launchId, 1);
    });
  }

  /** `provider`'s limit was lifted: its launches waiting on the quota reset retry now. */
  endQuotaLaunchWaits(provider: string): number {
    return this.#launches.endQuotaLaunchWaits(provider);
  }

  /** Drops every pending retry and every failure streak. Called on daemon shutdown: a pending
   * retry means nothing to the next daemon instance, which re-derives its work from the control
   * records. */
  dispose(): void {
    this.#launches.dispose();
  }
  stopped(agentId: string, launchId: string, identity?: SessionIdentity) {
    return this.#context.state.run(agentId, async () => {
      const record = await this.#context.state.store.read(agentId);
      if (!record || record.phase !== "running" || record.launchId !== launchId) return;
      record.phase = "stopped";
      this.#context.sessions.capture(record, identity ?? record.identity);
      await this.#context.state.store.write(agentId, record);
    });
  }
  /**
   * The mirror image of `stopped()`: a daemon-initiated (self-launched) wake
   * that reused this Agent's remembered `launchId` makes the on-disk record truthful again —
   * without it, a later server Start would find `phase: "stopped"` (or a stale `launchId`) and
   * either fail to rebind or spawn a second process. Never touches `scope`/`requestId`/`epoch`:
   * a wake carries no new server scope of its own, only the identity it reused, so the existing
   * fence in `start()`/`stop()` is unaffected. A no-op unless the record is exactly the one this
   * launch resumed (`phase === "stopped"` and the same `launchId`) — any other phase means a
   * concurrent server operation (Stop, a fresh Start, a rebind) already moved the record on, and
   * that operation's own writes must win, not this best-effort local wake.
   */
  wake(agentId: string, launchId: string, identity?: SessionIdentity) {
    return this.#context.state.run(agentId, async () => {
      const record = await this.#context.state.store.read(agentId);
      if (!record || record.phase !== "stopped" || record.launchId !== launchId) return;
      record.phase = "running";
      this.#context.sessions.capture(record, identity ?? record.identity);
      await this.#context.state.store.write(agentId, record);
    });
  }
  async replay() {
    return replayAgentControlResults(this.#known, this.#context.state, this.#context.runtime);
  }
}
