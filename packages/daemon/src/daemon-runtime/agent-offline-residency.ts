import { getLogger } from "@logtape/logtape";
import type { AgentActivity, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import {
  buildRuntimeActionRequiredActivity,
  buildRuntimeBillingExhaustedActivity,
  buildRuntimeErrorActivity,
  type RuntimeErrorEvent,
} from "#src/agent-runtime/runtime-error-activity";
import {
  classifyRuntimeErrorText,
  RUNTIME_ERROR_CLASS,
  type RuntimeErrorClassification,
} from "#src/agent-runtime/runtime-error-classification";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import type { ActivityDraft, PublishedActivityLaunch } from "./agent-activity-publisher";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** The launch fields offline residency touches beyond publishing: it records the failure's
 * Activity on the launch so the exit handler republishes it. */
export type OfflineResidencyLaunch = PublishedActivityLaunch & {
  offlineError?: ReturnType<typeof buildRuntimeErrorActivity>;
};

export type AgentOfflineResidencyPorts = Readonly<{
  /** Ends the Agent's explicit delivery hold without flushing into the dying process. */
  endHoldForNextLaunch(agentId: string): void;
  /** Forgets the Agent's runtime-error recovery streaks (backoff and fence). */
  forgetRuntimeErrorHold(agentId: string): void;
  /** Moves the launch's still-pending input-queue deliveries to `AgentDeliveryQueue`, ACKed. */
  keepInputDeliveriesForNextLaunch(agentId: string, error: Error): void;
  /** Closes the launch's input queue, rejecting non-delivery input. */
  closeAgentInputQueue(agentId: string, error: unknown): void;
  /** Builds the Activity envelope the launch's sequence metadata completes. */
  buildDraft(agentId: string, built: ReturnType<typeof buildRuntimeErrorActivity>): ActivityDraft;
  /** Publishes a draft under the launch's sequence metadata (muted when stopping). */
  publish(agentId: string, launch: PublishedActivityLaunch, draft: ActivityDraft): void;
  /** Reports the Agent's lifecycle status to the cloud. */
  sendAgentStatus(agentId: string, status: "inactive"): void;
  /** Sends a fully sequenced Activity frame (the offline Activity restated at close/delivery). */
  sendAgentActivity(activity: AgentActivity): void;
  /** Ends the Agent's process (drops its restart config). */
  stopProcess(agentId: string): Promise<void>;
}>;

/**
 * The per-Agent offline record a runtime error leaves behind (the reference Computer's terminal
 * residency): the dead launch and its failure's Activity draft. Owns the take-offline
 * orchestration (publish the Activity, report `inactive`, end the process while keeping queued
 * deliveries for the next launch), the `inactive` + Activity restatement a custody delivery
 * gets, and the wording selection for an offline failure's Activity. `runtime.ts` keeps only
 * the decision to call it and the clearing triggers (explicit Stop, next `active` status, the
 * Agent leaving this Computer); an abandoned launch preserves the record.
 */
export class AgentOfflineResidency {
  readonly #ports: AgentOfflineResidencyPorts;
  readonly #records = new Map<string, { launch: OfflineResidencyLaunch; draft: ActivityDraft }>();

  constructor(ports: AgentOfflineResidencyPorts) {
    this.#ports = ports;
  }

  /** Whether a runtime error took this Agent offline (an untracked delivery then takes the
   * custody path rather than `no_process`). */
  has(agentId: string): boolean {
    return this.#records.has(agentId);
  }

  /** The Agent's offline record, if one stands — for `#abandonLaunch`, which preserves it across
   * teardown that is not a person's Stop. */
  record(agentId: string): { launch: OfflineResidencyLaunch; draft: ActivityDraft } | undefined {
    return this.#records.get(agentId);
  }

  /** Restores a record `record` returned — only `#abandonLaunch` re-sets one it kept. */
  remember(
    agentId: string,
    record: { launch: OfflineResidencyLaunch; draft: ActivityDraft },
  ): void {
    this.#records.set(agentId, record);
  }

  /** A person's explicit Stop, a next `active` status, or the Agent leaving this Computer
   * clears the record; an abandoned launch keeps it. */
  forget(agentId: string): void {
    this.#records.delete(agentId);
  }

  /** The visible Activity an offline-taking runtime failure reports: action-required wording
   * when a person must act, balance wording for an exhausted billing balance, else the provider
   * text as-is (the fingerprint fence's wording is built by its caller, which holds the fence
   * state). */
  buildActivity(
    config: Pick<AgentRuntimeConfig, "provider" | "model" | "providerConfig">,
    providerLabel: string,
    event: RuntimeErrorEvent,
    classification: RuntimeErrorClassification,
  ): ReturnType<typeof buildRuntimeErrorActivity> {
    if (classification.requiredAction !== "none")
      return buildRuntimeActionRequiredActivity(event, classification, {
        provider: config.provider,
        model: config.model,
        providerLabel,
        agentProviderKey: config.providerConfig?.kind === "coforge",
      });
    if (classification.errorClass === RUNTIME_ERROR_CLASS.BILLING)
      return buildRuntimeBillingExhaustedActivity(event, classification, providerLabel);
    return buildRuntimeErrorActivity(event, classification);
  }

  /**
   * A runtime failure that cannot resolve by retrying takes the Agent offline: publish the
   * already-built runtime_error Activity, report `inactive`, and end the process. Deliveries are
   * kept, not dropped — the explicit hold ends without flushing into the dying process, and the
   * launch's still-pending input joins the same queue for the next launch.
   */
  takeOffline(
    agentId: string,
    launch: OfflineResidencyLaunch,
    provider: RuntimeProvider,
    built: ReturnType<typeof buildRuntimeErrorActivity>,
    log: Readonly<{
      event: string;
      errorClass: string;
      errorReason: string;
      requiredAction: string;
    }>,
  ): void {
    launch.offlineError = built;
    const draft = this.#ports.buildDraft(agentId, built);
    const ending = new Error("Agent is inactive");
    this.#ports.endHoldForNextLaunch(agentId);
    this.#ports.keepInputDeliveriesForNextLaunch(agentId, ending);
    this.#ports.closeAgentInputQueue(agentId, ending);
    this.#ports.forgetRuntimeErrorHold(agentId);
    logger.warning("Agent runtime error requires user action; terminating the process", {
      event: log.event,
      agent_id: agentId,
      provider,
      launch_id: launch.launchId,
      runtime_error_class: log.errorClass,
      runtime_error_reason: log.errorReason,
      runtime_error_action: log.requiredAction,
      outcome: "failed",
    });
    this.#ports.publish(agentId, launch, draft);
    // The dead launch object keeps the shared clientSeq counter: the exit republish and any
    // custody restatement each advance it, never colliding with an already-sent seq.
    this.#records.set(agentId, { launch, draft });
    launch.stopping = true;
    this.#ports.sendAgentStatus(agentId, "inactive");
    void this.#ports.stopProcess(agentId).catch((error: unknown) => {
      logger.warning("Agent process did not stop after an action-required error", {
        event: "agent_runtime:offline_stop_failed",
        agent_id: agentId,
        launch_id: launch.launchId,
        error_code: diagnosticErrorCode(error),
      });
    });
  }

  /**
   * A launch that failed before its error events could flow — the provider threw while the
   * session was being created — never reaches `#observeRuntimeEvent`. When the thrown error's
   * own text classifies as an offline failure this is the same `takeOffline` record: the Agent
   * stays offline and a later custody delivery restates this Activity. Returns the built
   * Activity, or undefined for an ordinary launch failure (which keeps the launcher wording).
   */
  thrownLaunchActivity(
    agentId: string,
    launch: OfflineResidencyLaunch,
    providerLabel: string,
    config: Pick<AgentRuntimeConfig, "provider" | "model" | "providerConfig">,
    error: unknown,
  ): ReturnType<typeof buildRuntimeErrorActivity> | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const event: RuntimeErrorEvent = { type: "error", message };
    const classification = classifyRuntimeErrorText(message);
    if (!classification.takesAgentOffline) return undefined;
    const built = this.buildActivity(config, providerLabel, event, classification);
    launch.offlineError = built;
    this.#records.set(agentId, { launch, draft: this.#ports.buildDraft(agentId, built) });
    return built;
  }

  /** A delivery reaching an offline Agent is kept (queued and ACKed by the caller); the daemon
   * restates `inactive` and the failure's Activity at a fresh clientSeq on the dead launch's
   * counter, as the reference Computer does for a delivery reaching a terminal-failure Agent. */
  restate(agentId: string): void {
    this.#ports.sendAgentStatus(agentId, "inactive");
    const record = this.#records.get(agentId);
    if (!record) return;
    this.#ports.sendAgentActivity({
      ...record.draft,
      requestId: crypto.randomUUID(),
      launchId: record.launch.launchId,
      clientSeq: ++record.launch.clientSeq,
      observedAtMs: Date.now(),
    });
  }
}
