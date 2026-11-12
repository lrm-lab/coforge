import { getLogger } from "@logtape/logtape";
import type { AgentConfigSync, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { RestartRuntimeFields } from "#src/agent-runtime/agent-process-manager";
import { runtimeFieldsOf } from "./runtime-launch-intent";
import type { ColdIdleAgent } from "./cold-idle-sweep";
import { scheduleUnrefTimer, type UnrefTimerSchedule } from "./unref-timer";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How long a pending apply waits before it looks at its Agent again. Background tasks end
 * without a turn end, so a turn end alone cannot be the only trigger. */
export const CONFIG_APPLY_RETRY_MS = 5_000;

/** How `stopIdle` ended: the runtime is down, the Agent was no longer idle, or it would not exit. */
export type IdleStopResult = "stopped" | "busy" | "failed";

export type AgentConfigApplyPorts = Readonly<{
  /** The Agent's live runtime judged by the cold idle sweep's guards; `undefined` with none. */
  agent(agentId: string): ColdIdleAgent | undefined;
  /** A launch is in flight, so a runtime is about to exist that has not read this config. */
  launching(agentId: string): boolean;
  /** The identity of the Agent's current launch, in flight or live: the same value for the whole
   * life of one launch, a different one for the next; `undefined` with none. */
  launchOf(agentId: string): object | undefined;
  /** The provider the Agent's restart config would wake; `undefined` without a restart config. */
  restartProvider(agentId: string): RuntimeProvider | undefined;
  replaceRestartRuntime(agentId: string, fields: RestartRuntimeFields): void;
  /** Ends the idle runtime, keeping the Agent active and wakeable, after judging it once more. */
  stopIdle(agentId: string): Promise<IdleStopResult>;
  schedule?: UnrefTimerSchedule;
}>;

/** A sync waiting for its Agent to idle. */
type Pending = {
  sync: AgentConfigSync;
  /** The launch the sync met when it arrived: it began on the configuration before the sync. */
  acceptedLaunch: object | undefined;
  /** A Start with an older revision launched from its own, older, fields since the sync arrived,
   * so no launch seen from now on is known to have read the sync. */
  launchedOldFields: boolean;
};

/**
 * Applies an Agent's pushed runtime configuration when the Agent is next idle, never by cutting
 * a turn short. Pushes are ordered per Agent by `revision`: one not newer than the highest
 * revision held (pushed, or launched with by a Start) is dropped. An accepted newer revision
 * always means a restart at idle, even when its fields equal the running ones, because variables
 * and credentials changed with it and are only read at launch.
 */
export class AgentConfigApply {
  readonly #ports: AgentConfigApplyPorts;
  readonly #schedule: UnrefTimerSchedule;
  /** The highest revision held per Agent: pushed, or launched with by a Start. */
  readonly #held = new Map<string, number>();
  readonly #pending = new Map<string, Pending>();
  /** Agents whose idle runtime is being stopped for a push right now. */
  readonly #stopping = new Set<string>();
  #cancelTimer: (() => void) | undefined;
  #disposed = false;

  constructor(ports: AgentConfigApplyPorts) {
    this.#ports = ports;
    this.#schedule = ports.schedule ?? scheduleUnrefTimer;
  }

  /** A pushed configuration arrived (the caller has checked it is for this Workspace). Settles
   * once the apply it started has; it never rejects. */
  accept(sync: AgentConfigSync): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const { agentId, revision } = sync;
    const held = this.#held.get(agentId);
    if (held !== undefined && revision <= held) {
      log("stale", sync, { held_revision: held });
      return Promise.resolve();
    }
    if (this.#mismatched(sync)) return Promise.resolve();
    this.#held.set(agentId, revision);
    const live = this.#ports.agent(agentId);
    if (live === undefined && !this.#ports.launching(agentId)) {
      this.#clear(agentId);
      this.#applyWithoutRuntime(sync);
      return Promise.resolve();
    }
    // A wake before the stop must already launch with the new fields.
    this.#replaceRestartRuntime(sync);
    if (live?.busyReason === "memory_agent") {
      this.#keepMemoryAgent(sync);
      return Promise.resolve();
    }
    this.#pending.set(agentId, {
      sync,
      acceptedLaunch: this.#ports.launchOf(agentId),
      launchedOldFields: false,
    });
    log("pending", sync);
    return this.settle(agentId);
  }

  /** A server Start is about to launch this Agent's process from its own fields, carrying
   * `agentConfigRevision` (absent from an older server). A revision is held, and a pending apply
   * at or below it is cancelled because the launch reads the whole configuration afresh. A Start
   * behind the pending apply launches the older fields and leaves it pending. */
  launched(agentId: string, agentConfigRevision: number | undefined): void {
    if (agentConfigRevision !== undefined)
      this.#held.set(agentId, Math.max(this.#held.get(agentId) ?? 0, agentConfigRevision));
    const pending = this.#pending.get(agentId);
    if (!pending) return;
    if (agentConfigRevision !== undefined && pending.sync.revision <= agentConfigRevision) {
      this.#clear(agentId);
      log("cancelled", pending.sync, { reason: "start" });
    } else pending.launchedOldFields = true;
  }

  /** A Stop ended the Agent: nothing is left to apply to. The revision stays held. */
  stopped(agentId: string): void {
    const pending = this.#pending.get(agentId);
    if (!pending) return;
    this.#clear(agentId);
    log("cancelled", pending.sync, { reason: "stop" });
  }

  /** Applies the Agent's pending configuration now if it can be: at a turn end, and from the
   * retry timer. Nothing happens for an Agent with nothing pending. Settles once the stop it
   * began has; it never rejects. */
  settle(agentId: string): Promise<void> {
    const entry = this.#pending.get(agentId);
    if (!entry || this.#stopping.has(agentId) || this.#disposed) return Promise.resolve();
    const pending = entry.sync;
    if (this.#mismatched(pending)) {
      this.#clear(agentId);
      return Promise.resolve();
    }
    const live = this.#ports.agent(agentId);
    if (live === undefined && !this.#ports.launching(agentId)) {
      // The runtime ended before it was idle: its next launch reads the configuration afresh.
      this.#clear(agentId);
      this.#applyWithoutRuntime(pending);
      return Promise.resolve();
    }
    if (live?.busyReason === "memory_agent") {
      // The launch the sync waited for turned out to be a Memory Agent.
      this.#replaceRestartRuntime(pending);
      this.#keepMemoryAgent(pending);
      return Promise.resolve();
    }
    const launch = this.#ports.launchOf(agentId);
    if (launch !== undefined && launch !== entry.acceptedLaunch && !entry.launchedOldFields) {
      // A launch that began after the sync, and not from a Start's older fields, read the
      // restart config the sync replaced.
      this.#clear(agentId);
      log("applied", pending);
      return Promise.resolve();
    }
    // Same guards as the cold idle sweep without its two cold conditions. An Agent whose session
    // was never reported cannot be resumed after a stop, so it is left running.
    if (live === undefined || live.busyReason !== undefined || live.sessionId === undefined) {
      this.#arm();
      return Promise.resolve();
    }
    return this.#stopIdle(agentId, pending);
  }

  /** The highest revision held per Agent, for the Daemon's ready request: what the server need not
   * send again. */
  appliedRevisions(): ReadonlyMap<string, number> {
    return this.#held;
  }

  /** Whether a configuration still waits for this Agent to go idle: a stop is coming. */
  pending(agentId: string): boolean {
    return this.#pending.has(agentId);
  }

  /** Cancels the retry timer; a stopped runtime applies nothing further. */
  dispose(): void {
    this.#disposed = true;
    this.#pending.clear();
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  #replaceRestartRuntime(sync: AgentConfigSync): void {
    if (this.#ports.restartProvider(sync.agentId) === sync.provider)
      this.#ports.replaceRestartRuntime(sync.agentId, runtimeFieldsOf(sync));
  }

  /** A Memory Agent is never stopped for a configuration: its next launch reads it. */
  #keepMemoryAgent(sync: AgentConfigSync): void {
    this.#clear(sync.agentId);
    log("memory_agent", sync);
  }

  /** A provider change is a Stop then a Start, never a push: a push for another provider than the
   * Agent runs or would wake is version skew or malformed, and is dropped (logged here, once). */
  #mismatched(sync: AgentConfigSync): boolean {
    const { agentId } = sync;
    const current = this.#ports.agent(agentId)?.provider ?? this.#ports.restartProvider(agentId);
    if (current === undefined || current === sync.provider) return false;
    log("provider_mismatch", sync);
    return true;
  }

  #applyWithoutRuntime(sync: AgentConfigSync): void {
    const { agentId } = sync;
    if (this.#ports.restartProvider(agentId) === undefined) {
      // Nothing to update: the server's next Start carries the configuration.
      log("no_restart_config", sync);
      return;
    }
    this.#ports.replaceRestartRuntime(agentId, runtimeFieldsOf(sync));
    log("applied", sync);
  }

  async #stopIdle(agentId: string, sync: AgentConfigSync): Promise<void> {
    this.#stopping.add(agentId);
    // A launch that finished meanwhile set the restart config from its own, older, fields.
    this.#replaceRestartRuntime(sync);
    log("idle_stop", sync);
    let result: IdleStopResult;
    let errorName: string | undefined;
    try {
      result = await this.#ports.stopIdle(agentId);
    } catch (error) {
      result = "failed";
      errorName = error instanceof Error ? error.name : "unknown";
    } finally {
      this.#stopping.delete(agentId);
    }
    const current = this.#pending.get(agentId)?.sync;
    if (result === "busy") {
      this.#arm();
      return;
    }
    if (result === "failed") {
      // The runtime would not exit; the launch is never judged again, so retrying cannot help.
      // The revision is released too, so the next ready reports it unapplied and the server
      // sends it again.
      if (current === sync) this.#clear(agentId);
      if (this.#held.get(agentId) === sync.revision) this.#held.delete(agentId);
      log("stop_failed", sync, errorName === undefined ? {} : { error_name: errorName });
      return;
    }
    // A newer push that arrived during the stop stays pending and is judged on the new state.
    if (current === sync) this.#clear(agentId);
    else if (current) await this.settle(agentId);
  }

  #clear(agentId: string): void {
    this.#pending.delete(agentId);
    if (this.#pending.size === 0) {
      this.#cancelTimer?.();
      this.#cancelTimer = undefined;
    }
  }

  /** One timer for every pending Agent, armed only while something is pending. */
  #arm(): void {
    if (this.#cancelTimer || this.#pending.size === 0 || this.#disposed) return;
    this.#cancelTimer = this.#schedule(async () => {
      this.#cancelTimer = undefined;
      await Promise.all([...this.#pending.keys()].map((agentId) => this.settle(agentId)));
      this.#arm();
    }, CONFIG_APPLY_RETRY_MS);
  }
}

/** Never carries the model, provider configuration, variables or credentials. */
function log(
  outcome:
    | "applied"
    | "stale"
    | "pending"
    | "idle_stop"
    | "no_restart_config"
    | "provider_mismatch"
    | "memory_agent"
    | "cancelled"
    | "stop_failed",
  sync: AgentConfigSync,
  extra: Record<string, unknown> = {},
): void {
  logger.info("Agent config push", {
    event: "agent.runtime.config_push",
    outcome,
    agent_id: sync.agentId,
    config_revision: sync.revision,
    ...extra,
  });
}
