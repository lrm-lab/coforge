import type { RuntimeModelWindow, RuntimeModelWindowAvailable } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import {
  buildRuntimeErrorActivity,
  fingerprintRuntimeError,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClassification,
} from "#src/agent-runtime/runtime-error-classification";
import {
  isZeroEvidenceReason,
  RUNTIME_ERROR_FENCE_EXEMPT_CLASSES,
  RUNTIME_ERROR_RECOVERY_EFFECTS,
  RuntimeErrorDeliveryBackoff,
  RuntimeErrorFingerprintFence,
  RuntimeErrorClassFence,
  ZERO_EVIDENCE_CRASH_STREAK_CAP,
  type RuntimeErrorClassFenceState,
  type RuntimeErrorFingerprintFenceState,
  type RuntimeErrorRecoverySignal,
} from "#src/agent-runtime/runtime-error-recovery";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import type { CredentialInvalidHolds } from "./credential-invalid-holds";

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const MAX_MODEL_WINDOW_MS = 8 * 24 * 60 * 60_000;

type ModelWait = {
  launch: object;
  modelWindow: RuntimeModelWindow;
  observedAtMs: number;
  untilMs: number;
  timer: ReturnType<typeof setTimeout>;
};

function matchingModelWindow(
  launch: { provider?: string; model?: string },
  event: RuntimeErrorEvent,
  now: number,
): { modelWindow: RuntimeModelWindow; untilMs: number } | undefined {
  const limit = event.providerLimit;
  const model = limit?.modelWindow?.model;
  if (
    launch.provider !== "claude-code" ||
    limit?.kind !== "window_limit" ||
    limit.modelWindow?.window !== "weekly" ||
    !model ||
    !launch.model
  )
    return;
  if (model !== "fable" && model !== "opus" && model !== "sonnet") return;
  if (
    model !== launch.model &&
    !new RegExp(`^claude-${model}-[0-9]+(?:-[0-9]+)*(?:\\[1m\\])?$`).test(launch.model)
  )
    return;
  const untilMs = Date.parse(limit.resetsAt ?? "");
  if (untilMs > now && untilMs - now <= MAX_MODEL_WINDOW_MS)
    return { modelWindow: limit.modelWindow, untilMs };
}

export type RuntimeErrorBackoffPersistence = Readonly<{
  save(
    agentId: string,
    state: Readonly<{
      untilMs: number;
      reason: "rate_limit_backoff" | "runtime_error_backoff";
      provider?: string;
    }>,
  ): void;
  clear(agentId: string): void;
}>;

export type RuntimeErrorDeliveryHoldPorts = Readonly<{
  deliveryGate: Pick<
    AgentDeliveryGate,
    "hold" | "release" | "endHoldForNextLaunch" | "explicitHold" | "credentialHeld" | "pending"
  >;
  flush(agentId: string, held: AgentMessageDelivery[]): void;
  backoffEnded?(agentId: string): void;
  store?: RuntimeErrorBackoffPersistence;
  credential?: Pick<CredentialInvalidHolds, "modelOutput" | "forget" | "dispose">;
}>;

const logger = getLogger(["coforge", "daemon", "runtime"]);

export class RuntimeErrorDeliveryHold {
  readonly #ports: RuntimeErrorDeliveryHoldPorts;
  readonly #backoff = new RuntimeErrorDeliveryBackoff();
  readonly #fence = new RuntimeErrorFingerprintFence();
  readonly #zeroEvidence = new RuntimeErrorFingerprintFence(ZERO_EVIDENCE_CRASH_STREAK_CAP);
  readonly #turnProgress = new Set<string>();
  readonly #modelWaits = new Map<string, ModelWait>();

  readonly #releaseTimers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      reason: "rate_limit_backoff" | "runtime_error_backoff";
      provider?: string;
    }
  >();

  constructor(ports: RuntimeErrorDeliveryHoldPorts) {
    this.#ports = ports;
  }

  noteFailure(
    agentId: string,
    classification: RuntimeErrorClassification,
    fingerprint: string,
    provider?: string,
  ): RuntimeErrorFingerprintFenceState | undefined {
    const fence = isZeroEvidenceReason(classification.errorReason)
      ? this.#zeroEvidence.note(agentId, "zero_evidence_turn_completed")
      : RUNTIME_ERROR_FENCE_EXEMPT_CLASSES.has(classification.errorClass)
        ? undefined
        : this.#fence.note(agentId, fingerprint);
    if (fence?.fenced) {
      this.#holdFenced(agentId);
      return fence;
    }
    // A known-invalid credential holds until it is usable again, whatever this failure would add.
    if (this.#ports.deliveryGate.credentialHeld(agentId)) return undefined;
    if (classification.retryDecision !== RUNTIME_ERROR_RETRY_DECISION.RETRY) {
      this.#endBackoff(agentId);
      return undefined;
    }
    const backoff = this.#backoff.recordFailure(
      agentId,
      classification.errorClass,
      Date.now(),
      classification.retryNotBefore,
    );
    const reason =
      classification.errorClass === RUNTIME_ERROR_CLASS.RATE_LIMIT
        ? "rate_limit_backoff"
        : "runtime_error_backoff";
    this.#ports.deliveryGate.hold(agentId, reason);
    this.#ports.store?.save(agentId, {
      untilMs: backoff.untilMs,
      reason,
      ...(provider ? { provider } : {}),
    });
    this.#scheduleRelease(agentId, backoff.untilMs, reason, provider);
    logger.info("Held deliveries for a retrying runtime", {
      event: "agent.runtime.delivery_held",
      agent_id: agentId,
      error_class: classification.errorClass,
      attempt: backoff.attempts,
      retry_in_ms: backoff.delayMs,
      held: this.#ports.deliveryGate.pending(agentId).length,
      reason,
      outcome: "held",
    });
    return undefined;
  }

  holdCredentialInvalid(agentId: string): boolean {
    if (this.#isFenced(agentId)) return false;
    this.#clearReleaseTimer(agentId);
    this.#clearModelWait(agentId);
    this.#backoff.reset(agentId);
    this.#ports.store?.clear(agentId);
    this.#ports.deliveryGate.hold(agentId, "credential_invalid");
    return true;
  }

  restore(
    records: readonly Readonly<{
      agentId: string;
      untilMs: number;
      reason: "rate_limit_backoff" | "runtime_error_backoff";
      provider?: string;
    }>[],
  ): void {
    const now = Date.now();
    for (const record of records) {
      if (record.untilMs <= now) {
        this.#ports.store?.clear(record.agentId);
        continue;
      }
      this.#ports.deliveryGate.hold(record.agentId, record.reason);
      this.#scheduleRelease(record.agentId, record.untilMs, record.reason, record.provider);
      // A restarted Daemon says which waits it picked up: the only line that shows a usage limit
      // surviving the process without a live failure to point at.
      logger.info("Runtime backoff restored", {
        event: "agent.runtime.backoff_restored",
        agent_id: record.agentId,
        until_ms: record.untilMs,
        reason: record.reason,
      });
    }
  }

  noteRuntimeFailure(
    agentId: string,
    launch: { runtimeErrorClassFence?: RuntimeErrorClassFence; provider?: string; model?: string },
    event: RuntimeErrorEvent,
    classification: RuntimeErrorClassification,
  ): {
    built: ReturnType<typeof buildRuntimeErrorActivity>;
    fence?: (RuntimeErrorFingerprintFenceState | RuntimeErrorClassFenceState) & { event: string };
  } {
    const built = buildRuntimeErrorActivity(event, classification);
    if (classification.errorClass === RUNTIME_ERROR_CLASS.MODEL_REFUSAL) return { built };
    const classFence = (launch.runtimeErrorClassFence ??= new RuntimeErrorClassFence()).note(
      classification,
    );
    const modelWait = matchingModelWindow(launch, event, Date.now());
    if (
      modelWait !== undefined &&
      classification.retryDecision === RUNTIME_ERROR_RETRY_DECISION.RETRY
    ) {
      if (!this.#isFenced(agentId) && !this.#ports.deliveryGate.credentialHeld(agentId))
        this.#holdModelWindow(agentId, launch, modelWait.modelWindow, modelWait.untilMs);
    }
    const fingerprintFence =
      modelWait === undefined
        ? this.noteFailure(
            agentId,
            classification,
            built.runtimeError?.fingerprint ?? fingerprintRuntimeError(event.message),
            launch.provider,
          )
        : undefined;
    if (fingerprintFence)
      return {
        built,
        fence: { ...fingerprintFence, event: "agent_runtime:fingerprint_fence_tripped" },
      };
    if (!classFence?.fenced) return { built };
    this.#holdFenced(agentId);
    return { built, fence: { ...classFence, event: "agent_runtime:class_fence_tripped" } };
  }

  resetZeroEvidence(agentId: string): void {
    this.#zeroEvidence.reset(agentId);
  }

  noteRecoverySignal(
    agentId: string,
    signal: RuntimeErrorRecoverySignal,
    classFence?: RuntimeErrorClassFence,
    turnStartedAtMs?: number,
  ): void {
    // Model output of the Agent's own turn shows its credential works (a turn begun since the
    // credential was found invalid; the failing turn's own output never counts).
    if (signal === "output") this.#ports.credential?.modelOutput(agentId, turnStartedAtMs);
    const effects = RUNTIME_ERROR_RECOVERY_EFFECTS[signal];
    if (effects.resetsFence) {
      this.#turnProgress.add(agentId);
      this.#fence.reset(agentId);
      classFence?.reset();
    }
    if (this.#backoff.attempts(agentId) === 0) return;
    const rateLimited = this.#backoff.latestClass(agentId) === RUNTIME_ERROR_CLASS.RATE_LIMIT;
    if (rateLimited ? effects.endsRateLimitBackoff : effects.endsBackoff) this.#endBackoff(agentId);
  }

  releaseRateLimitBackoffs(provider: string, hasSession: (agentId: string) => boolean): number {
    let released = 0;
    for (const [agentId, waiting] of Array.from(this.#releaseTimers)) {
      if (waiting.provider !== provider) continue;
      if (waiting.reason !== "rate_limit_backoff") continue;
      this.#endBackoff(agentId, hasSession(agentId));
      released += 1;
    }
    return released;
  }

  noteTurnEnd(agentId: string): void {
    if (this.#turnProgress.delete(agentId)) this.#fence.reset(agentId);
    if (this.#backoff.latestClass(agentId) === RUNTIME_ERROR_CLASS.RUNTIME)
      this.#endBackoff(agentId);
  }

  forget(agentId: string): void {
    this.#ports.credential?.forget(agentId);
    this.#clearModelWait(agentId);
    this.#clearReleaseTimer(agentId);
    this.#backoff.reset(agentId);
    this.#fence.reset(agentId);
    this.#turnProgress.delete(agentId);
    this.#ports.store?.clear(agentId);
  }

  disposeAll(): void {
    this.#ports.credential?.dispose();
    for (const agentId of this.#modelWaits.keys()) {
      this.#clearModelWait(agentId);
      if (!this.#releaseTimers.has(agentId)) this.#ports.deliveryGate.release(agentId);
    }
    for (const [agentId, { timer }] of this.#releaseTimers) {
      clearTimeout(timer);
      this.#ports.deliveryGate.release(agentId);
    }
    this.#releaseTimers.clear();
  }

  #endBackoff(agentId: string, flush = true): void {
    this.#clearReleaseTimer(agentId);
    const fenced = this.#isFenced(agentId);
    if (!fenced && this.#modelWaits.has(agentId))
      this.#ports.deliveryGate.hold(agentId, "rate_limit_backoff");
    else if (!fenced) {
      if (flush) this.#releaseHeld(agentId);
      else this.#ports.deliveryGate.endHoldForNextLaunch(agentId);
    }
    this.#backoff.reset(agentId);
    this.#ports.store?.clear(agentId);
    if (!fenced && !this.#modelWaits.has(agentId)) this.#ports.backoffEnded?.(agentId);
  }

  #holdFenced(agentId: string): void {
    this.#clearReleaseTimer(agentId);
    this.#clearModelWait(agentId);
    this.#ports.deliveryGate.hold(agentId, "fingerprint_fence");
  }

  #isFenced(agentId: string): boolean {
    return this.#ports.deliveryGate.explicitHold(agentId) === "fingerprint_fence";
  }

  #scheduleRelease(
    agentId: string,
    untilMs: number,
    reason: "rate_limit_backoff" | "runtime_error_backoff",
    provider?: string,
  ): void {
    this.#clearReleaseTimer(agentId);
    const remainingMs = untilMs - Date.now();
    const timer = setTimeout(
      () => {
        if (remainingMs > MAX_TIMER_DELAY_MS) {
          this.#scheduleRelease(agentId, untilMs, reason, provider);
          return;
        }
        this.#releaseTimers.delete(agentId);
        if (this.#modelWaits.has(agentId)) {
          this.#ports.deliveryGate.hold(agentId, "rate_limit_backoff");
        } else {
          this.#releaseHeld(agentId);
          this.#ports.backoffEnded?.(agentId);
        }
        this.#ports.store?.clear(agentId);
      },
      Math.min(Math.max(0, remainingMs), MAX_TIMER_DELAY_MS),
    );
    this.#releaseTimers.set(agentId, { timer, reason, ...(provider ? { provider } : {}) });
  }

  #holdModelWindow(
    agentId: string,
    launch: object,
    modelWindow: RuntimeModelWindow,
    untilMs: number,
  ): void {
    const previous = this.#modelWaits.get(agentId);
    if (previous?.launch === launch && previous.untilMs >= untilMs) {
      if (previous.untilMs === untilMs) previous.observedAtMs = Date.now();
      return;
    }
    this.#clearModelWait(agentId);
    const timer = setTimeout(() => this.#endModelWait(agentId, true), untilMs - Date.now());
    this.#modelWaits.set(agentId, {
      launch,
      modelWindow,
      observedAtMs: Date.now(),
      untilMs,
      timer,
    });
    if (!this.#releaseTimers.has(agentId))
      this.#ports.deliveryGate.hold(agentId, "rate_limit_backoff");
  }

  noteModelWindowAvailable(
    agentId: string,
    launch: object,
    event: RuntimeModelWindowAvailable,
  ): boolean {
    const wait = this.#modelWaits.get(agentId);
    const observedAtMs = Date.parse(event.occurredAt);
    if (
      !wait ||
      wait.launch !== launch ||
      wait.modelWindow.model !== event.modelWindow.model ||
      wait.modelWindow.window !== event.modelWindow.window ||
      Date.parse(event.resetsAt) !== wait.untilMs ||
      !(observedAtMs > wait.observedAtMs && observedAtMs <= Date.now())
    )
      return false;
    this.#endModelWait(agentId, true);
    return true;
  }

  endLaunchModelWait(agentId: string, launch: object): void {
    if (this.#modelWaits.get(agentId)?.launch === launch) this.#endModelWait(agentId, false);
  }

  #endModelWait(agentId: string, flush: boolean): void {
    this.#clearModelWait(agentId);
    if (
      this.#releaseTimers.has(agentId) ||
      this.#isFenced(agentId) ||
      this.#ports.deliveryGate.credentialHeld(agentId)
    )
      return;
    if (flush) {
      this.#releaseHeld(agentId);
      this.#ports.backoffEnded?.(agentId);
    } else {
      this.#ports.deliveryGate.endHoldForNextLaunch(agentId);
    }
  }

  #clearModelWait(agentId: string): void {
    const wait = this.#modelWaits.get(agentId);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.#modelWaits.delete(agentId);
  }

  #clearReleaseTimer(agentId: string): void {
    const timer = this.#releaseTimers.get(agentId)?.timer;
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#releaseTimers.delete(agentId);
  }

  #releaseHeld(agentId: string): void {
    const held = this.#ports.deliveryGate.release(agentId);
    if (held.length) this.#ports.flush(agentId, held);
  }
}
