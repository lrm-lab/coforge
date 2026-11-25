import type { RuntimeModelWindow, RuntimeModelWindowAvailable } from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import {
  buildRuntimeErrorActivity,
  fingerprintRuntimeError,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import { RUNTIME_PROVIDER, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import {
  RUNTIME_ERROR_CLASS,
  RUNTIME_ERROR_RETRY_DECISION,
  type RuntimeErrorClassification,
} from "#src/agent-runtime/runtime-error-classification";
import {
  isZeroEvidenceReason,
  QUOTA_RESET_BACKOFF_MAX_MS,
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
import type {
  PersistedRuntimeBackoff,
  RuntimeBackoffWait,
} from "#src/persistence/agent-runtime-backoff-store";
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
    launch.provider !== RUNTIME_PROVIDER.CLAUDE_CODE ||
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

type ScheduledWait = RuntimeBackoffWait & { timer: ReturnType<typeof setTimeout> };

export type RuntimeErrorBackoffPersistence = Readonly<{
  save(agentId: string, state: Omit<PersistedRuntimeBackoff, "agentId">): void;
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

  readonly #releaseTimers = new Map<string, ScheduledWait>();
  readonly #accountTimers = new Map<string, ScheduledWait>();

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
    this.#scheduleRelease(this.#releaseTimers, agentId, {
      untilMs: backoff.untilMs,
      reason,
      ...(provider ? { provider } : {}),
      ...(provider === RUNTIME_PROVIDER.CLAUDE_CODE && classification.errorReason === "rate_limited"
        ? { claudeScope: "transient_rate_limit" }
        : {}),
    });
    this.#persistWaits(agentId);
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
    this.#clearTimer(this.#releaseTimers, agentId);
    this.#clearTimer(this.#accountTimers, agentId);
    this.#clearModelWait(agentId);
    this.#backoff.reset(agentId);
    this.#ports.store?.clear(agentId);
    this.#ports.deliveryGate.hold(agentId, "credential_invalid");
    return true;
  }

  restore(records: readonly PersistedRuntimeBackoff[]): void {
    const now = Date.now();
    for (const { agentId, companion, ...primary } of records) {
      for (const wait of [primary, companion]) {
        if (!wait || wait.untilMs <= now) continue;
        const timers =
          wait.claudeScope === "account_window" ? this.#accountTimers : this.#releaseTimers;
        this.#scheduleRelease(timers, agentId, wait);
        logger.info("Runtime backoff restored", {
          event: "agent.runtime.backoff_restored",
          agent_id: agentId,
          until_ms: wait.untilMs,
          reason: wait.reason,
        });
      }
      if (!this.#projectWait(agentId)) this.#ports.store?.clear(agentId);
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
    const now = Date.now();
    const modelWait = matchingModelWindow(launch, event, now);
    const limit = event.providerLimit;
    const accountUntilMs = Date.parse(limit?.resetsAt ?? "");
    const accountWindow =
      launch.provider === RUNTIME_PROVIDER.CLAUDE_CODE &&
      limit?.kind === "window_limit" &&
      (limit.accountWindow === "five_hour" || limit.accountWindow === "weekly") &&
      !limit.modelWindow &&
      accountUntilMs > now;
    const isScopedRetry =
      (modelWait !== undefined || accountWindow) &&
      classification.retryDecision === RUNTIME_ERROR_RETRY_DECISION.RETRY;
    if (
      isScopedRetry &&
      !this.#isFenced(agentId) &&
      !this.#ports.deliveryGate.credentialHeld(agentId)
    ) {
      if (modelWait)
        this.#holdModelWindow(agentId, launch, modelWait.modelWindow, modelWait.untilMs);
      else
        this.#holdAccountWindow(
          agentId,
          Math.min(accountUntilMs, now + QUOTA_RESET_BACKOFF_MAX_MS),
        );
    }
    const fingerprintFence = isScopedRetry
      ? undefined
      : this.noteFailure(
          agentId,
          classification,
          built.runtimeError?.fingerprint ?? fingerprintRuntimeError(event.message),
          launch.provider,
        );
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
    const matching = new Set<string>();
    for (const [agentId, wait] of this.#releaseTimers) {
      if (this.#canLiftProviderWait(wait, provider)) matching.add(agentId);
    }
    for (const [agentId, wait] of this.#accountTimers) {
      if (wait.provider === provider) matching.add(agentId);
    }
    for (const agentId of matching) {
      const account = this.#accountTimers.get(agentId);
      if (account?.provider === provider) this.#clearTimer(this.#accountTimers, agentId);
      const regular = this.#releaseTimers.get(agentId);
      if (regular && this.#canLiftProviderWait(regular, provider)) {
        this.#clearTimer(this.#releaseTimers, agentId);
        this.#backoff.reset(agentId);
      }
      this.#persistWaits(agentId);
      this.#finishWaitTransition(agentId, hasSession(agentId));
    }
    return matching.size;
  }

  #canLiftProviderWait(wait: RuntimeBackoffWait, provider: string): boolean {
    return (
      wait.provider === provider &&
      wait.reason === "rate_limit_backoff" &&
      wait.claudeScope !== "transient_rate_limit"
    );
  }

  noteTurnEnd(agentId: string): void {
    if (this.#turnProgress.delete(agentId)) this.#fence.reset(agentId);
    if (this.#backoff.latestClass(agentId) === RUNTIME_ERROR_CLASS.RUNTIME)
      this.#endBackoff(agentId);
  }

  forget(agentId: string): void {
    this.#ports.credential?.forget(agentId);
    this.#clearModelWait(agentId);
    this.#clearTimer(this.#releaseTimers, agentId);
    this.#clearTimer(this.#accountTimers, agentId);
    this.#backoff.reset(agentId);
    this.#fence.reset(agentId);
    this.#turnProgress.delete(agentId);
    this.#ports.store?.clear(agentId);
  }

  disposeAll(): void {
    this.#ports.credential?.dispose();
    const waiting = new Set([
      ...this.#modelWaits.keys(),
      ...this.#releaseTimers.keys(),
      ...this.#accountTimers.keys(),
    ]);
    for (const agentId of waiting) {
      this.#clearModelWait(agentId);
      this.#clearTimer(this.#releaseTimers, agentId);
      this.#clearTimer(this.#accountTimers, agentId);
      this.#ports.deliveryGate.release(agentId);
    }
  }

  #endBackoff(agentId: string): void {
    this.#clearTimer(this.#releaseTimers, agentId);
    this.#backoff.reset(agentId);
    this.#persistWaits(agentId);
    this.#finishWaitTransition(agentId, true);
  }

  #holdFenced(agentId: string): void {
    this.#clearTimer(this.#releaseTimers, agentId);
    this.#clearTimer(this.#accountTimers, agentId);
    this.#clearModelWait(agentId);
    this.#ports.deliveryGate.hold(agentId, "fingerprint_fence");
  }

  #projectWait(agentId: string): boolean {
    const regular = this.#releaseTimers.get(agentId);
    const hasQuotaWait = this.#accountTimers.has(agentId) || this.#modelWaits.has(agentId);
    const reason = regular?.reason ?? (hasQuotaWait ? "rate_limit_backoff" : undefined);
    if (!reason) return false;
    this.#ports.deliveryGate.hold(agentId, reason);
    return true;
  }

  #finishWaitTransition(agentId: string, flush: boolean, notify = true): void {
    if (this.#isFenced(agentId) || this.#ports.deliveryGate.credentialHeld(agentId)) return;
    if (this.#projectWait(agentId)) return;
    if (flush) this.#releaseHeld(agentId);
    else this.#ports.deliveryGate.endHoldForNextLaunch(agentId);
    if (notify) this.#ports.backoffEnded?.(agentId);
  }

  #persistWaits(agentId: string): void {
    const regular = this.#releaseTimers.get(agentId);
    const account = this.#accountTimers.get(agentId);
    const primary = account && (!regular || account.untilMs >= regular.untilMs) ? account : regular;
    if (!primary) return this.#ports.store?.clear(agentId);
    const companion = primary === account ? regular : account;
    const { timer: _primaryTimer, ...state } = primary;
    if (!companion) return this.#ports.store?.save(agentId, state);
    const { timer: _companionTimer, ...extra } = companion;
    this.#ports.store?.save(agentId, { ...state, companion: extra });
  }

  #isFenced(agentId: string): boolean {
    return this.#ports.deliveryGate.explicitHold(agentId) === "fingerprint_fence";
  }

  #scheduleRelease(
    timers: Map<string, ScheduledWait>,
    agentId: string,
    wait: RuntimeBackoffWait,
  ): void {
    this.#clearTimer(timers, agentId);
    const remainingMs = wait.untilMs - Date.now();
    const timer = setTimeout(
      () => {
        if (remainingMs > MAX_TIMER_DELAY_MS) {
          this.#scheduleRelease(timers, agentId, wait);
          return;
        }
        timers.delete(agentId);
        this.#persistWaits(agentId);
        this.#finishWaitTransition(agentId, true);
      },
      Math.min(Math.max(0, remainingMs), MAX_TIMER_DELAY_MS),
    );
    timers.set(agentId, { ...wait, timer });
  }

  #holdAccountWindow(agentId: string, untilMs: number): void {
    const previous = this.#accountTimers.get(agentId);
    if (previous && previous.untilMs >= untilMs) return;
    this.#scheduleRelease(this.#accountTimers, agentId, {
      untilMs,
      reason: "rate_limit_backoff",
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      claudeScope: "account_window",
    });
    this.#projectWait(agentId);
    this.#persistWaits(agentId);
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
    this.#finishWaitTransition(agentId, flush, flush);
  }

  #clearModelWait(agentId: string): void {
    const wait = this.#modelWaits.get(agentId);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.#modelWaits.delete(agentId);
  }

  #clearTimer(timers: Map<string, ScheduledWait>, agentId: string): void {
    const wait = timers.get(agentId);
    if (!wait) return;
    clearTimeout(wait.timer);
    timers.delete(agentId);
  }

  #releaseHeld(agentId: string): void {
    const held = this.#ports.deliveryGate.release(agentId);
    if (held.length) this.#ports.flush(agentId, held);
  }
}
