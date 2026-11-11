import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeConfig } from "@coforge/agent";
import type { AgentCredentialRestored } from "@lrm/coforge-sdk/internal";
import type { CredentialInvalidReason } from "#src/agent-runtime/credential-invalid";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import {
  appliesToModel,
  CredentialInvalidLedger,
  credentialKeyOf,
  isSharedKey,
  ownCredentialKey,
  sharedCredentialKey,
  type CredentialKey,
  type CredentialReleaseCause,
  type LedgerChange,
} from "./credential-invalid-ledger";
import { scheduleUnrefTimer } from "./unref-timer";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How long a closed Agent's deliveries wait before its launch probes the credential again (the
 * reference Computer's `CREDENTIAL_INVALID_CLOSED_HOLD_MS`). */
export const CREDENTIAL_INVALID_CLOSED_HOLD_MS = 60 * 60_000;

/** What an Agent reports once its credential works again, for the server to clear the error. */
export type CredentialRestored = Pick<
  AgentCredentialRestored,
  "agentId" | "reason" | "releaseCause" | "launchId" | "restoredAtMs"
>;

export type CredentialInvalidHoldsPorts = Readonly<{
  deliveryGate: Pick<AgentDeliveryGate, "credentialHeld" | "heldFor" | "endHold">;
  /** Holds one Agent's deliveries; false when a hold of its own (a tripped fence) stays. */
  hold(agentId: string, reason: CredentialInvalidReason): boolean;
  /** The Agents with a running process, and whether one Agent has. */
  runningAgentIds(): Iterable<string>;
  isRunning(agentId: string): boolean;
  /** The config the Agent runs or would be relaunched with. */
  configOf(agentId: string): AgentRuntimeConfig | undefined;
  /** Tells a live Agent what its hold kept: held deliveries and tracked mentions, in one notice. */
  present(agentId: string): void;
  /** Starts an Agent with no process for what its hold kept. */
  wake(agentId: string): void;
  /** Shows an idle Agent that another Agent found the shared sign-in unusable; `text` undefined
   * takes the notice away again. */
  notice(agentId: string, text: string | undefined): void;
  noticeText(config: AgentRuntimeConfig, reason: CredentialInvalidReason): string;
  launchId(agentId: string): string | undefined;
  restored(report: CredentialRestored): void;
  /** The holds are done with: whatever watches the credentials stops. */
  disposed?(): void;
}>;

/**
 * The credential-invalid hold across Agents (the reference Computer's `credentialInvalidHold`):
 * which credentials are known invalid (`CredentialInvalidLedger`), and which Agents' deliveries
 * that holds. An Agent whose runtime reported the failure holds its own deliveries, and so does
 * every other running Agent on the same shared sign-in, which is shown a notice instead of the
 * error. Who is held is the delivery gate's to say; the hold outlives the process and ends when the
 * credential is known usable again: the Agent stopped, the sign-in changed (`credentialsChanged`),
 * the Agent's model changed to one the record does not cover, or a turn begun after the record
 * produced model output. A closed Agent's deliveries wait an hour (`closed`), after which its
 * launch probes the credential. Ending the hold tells a live Agent what it kept and starts a closed
 * one, and reports the recovery of every Agent that showed the record.
 */
export class CredentialInvalidHolds {
  readonly ledger = new CredentialInvalidLedger();
  /** The closed Agents' probe timers, each with its cancel. */
  readonly #closed = new Map<string, () => void>();

  constructor(
    private readonly ports: CredentialInvalidHoldsPorts,
    private readonly closedHoldMs = CREDENTIAL_INVALID_CLOSED_HOLD_MS,
  ) {
    this.ledger.subscribe((change) => this.#onChange(change));
  }

  isHeld(agentId: string): boolean {
    return this.ports.deliveryGate.credentialHeld(agentId);
  }

  /** The Agent's runtime reported its credential unusable. */
  record(agentId: string, config: AgentRuntimeConfig, reason: CredentialInvalidReason): void {
    const key = credentialKeyOf(agentId, config);
    this.ledger.record(
      key,
      {
        reason,
        ...(reason === "user_model_access" ? { model: config.model } : {}),
        recordedAtMs: Date.now(),
      },
      agentId,
      config,
    );
    this.#hold(agentId, key, reason);
  }

  /** A running Agent produced model output in a turn begun after a record: the credential works. */
  modelOutput(agentId: string, turnStartedAtMs: number | undefined): void {
    if (!this.ledger.hasInvalid() || turnStartedAtMs === undefined) return;
    const config = this.ports.configOf(agentId);
    if (!config) return;
    this.ledger.release(
      credentialKeyOf(agentId, config),
      "model_output",
      (record) => appliesToModel(record, config.model) && turnStartedAtMs > record.recordedAtMs,
    );
  }

  /** The Agent's model changed. A plan that lacks the old model no longer holds it; an Agent on the
   * shared sign-in leaves the record to the others and only stops being held by it. */
  modelChanged(agentId: string, model: string): void {
    if (!this.ledger.hasInvalid()) return;
    const config = this.ports.configOf(agentId);
    if (!config) return;
    const key = credentialKeyOf(agentId, config);
    if (!isSharedKey(key)) {
      this.ledger.release(
        key,
        "model_changed",
        (record) => record.reason === "user_model_access" && !appliesToModel(record, model),
      );
    } else if (this.isHeld(agentId) && !this.ledger.invalidFor(key, model))
      this.#lift(agentId, "model_changed");
  }

  /** The credentials under `key` changed on disk. */
  credentialsChanged(key: CredentialKey): void {
    this.ledger.release(key, "credentials_changed");
  }

  /** The Computer's own login for `provider` was signed in again. */
  signedIn(provider: string): void {
    this.credentialsChanged(sharedCredentialKey(provider));
  }

  /** A person stopped the Agent: its credential records end, the others on the sign-in with them. */
  stopped(agentId: string): void {
    const config = this.ports.configOf(agentId);
    this.#cancelClosed(agentId);
    // The stopping Agent has nothing to present: its hold goes first, so the release below leaves it.
    this.ports.deliveryGate.endHold(agentId, "credential_invalid");
    const keys = new Set<CredentialKey>([ownCredentialKey(agentId)]);
    if (config) keys.add(credentialKeyOf(agentId, config));
    for (const key of keys) this.ledger.release(key, "explicit_stop");
  }

  /**
   * A person started the Agent: their act is the probe, so the records that held it end here
   * rather than waiting for a launch to run into the same failure. What the hold kept is handed
   * to a live Agent in the same step (`#lift`'s present); the launch this Start is making tells
   * it when no process is running. Ending the hold is what makes that possible at all: the hold
   * keeps the delivery a turn would have needed to produce the model output it waits for.
   */
  started(agentId: string): void {
    const config = this.ports.configOf(agentId);
    this.#cancelClosed(agentId);
    const keys = new Set<CredentialKey>([ownCredentialKey(agentId)]);
    if (config) keys.add(credentialKeyOf(agentId, config));
    for (const key of keys) this.ledger.release(key, "explicit_start");
    // A record that no longer answers to this Agent's keys (a sibling's on a shared sign-in, a
    // model it has since left) still holds it: the person's Start ends that one with it.
    if (this.isHeld(agentId)) this.#lift(agentId, "explicit_start");
  }

  /** The Agent is gone (offline, deleted, relaunched fresh): it no longer waits on its own
   * credentials, which nothing reports restored. */
  forget(agentId: string): void {
    this.#cancelClosed(agentId);
    this.ledger.drop(ownCredentialKey(agentId));
  }

  /** The Agent's process ended while its credential is invalid: what waits for it is not run
   * into the same failure for an hour, after which its next launch probes the credential. */
  closed(agentId: string): void {
    if (!this.isHeld(agentId)) return;
    this.#cancelClosed(agentId);
    this.#closed.set(
      agentId,
      scheduleUnrefTimer(async () => {
        this.#closed.delete(agentId);
        if (!this.isHeld(agentId)) return;
        this.ports.deliveryGate.endHold(agentId, "credential_invalid");
        this.ports.wake(agentId);
      }, this.closedHoldMs),
    );
  }

  dispose(): void {
    this.ports.disposed?.();
    for (const cancel of this.#closed.values()) cancel();
    this.#closed.clear();
  }

  #hold(agentId: string, key: CredentialKey, reason: CredentialInvalidReason): boolean {
    if (!this.ports.hold(agentId, reason)) return false;
    logger.warning("Provider credential invalid; deliveries held until it changes", {
      event: "agent.runtime.credential_invalid_held",
      agent_id: agentId,
      reason,
      credential_key_kind: isSharedKey(key) ? "shared" : "agent",
    });
    return true;
  }

  #onChange(change: LedgerChange): void {
    if (change.kind === "recorded") return this.#holdSiblings(change);
    if (change.kind === "dropped") return;
    // The hold ends first: a report that cannot be sent leaves no Agent stranded behind it.
    for (const agentId of this.ports.deliveryGate.heldFor("credential_invalid")) {
      if (this.#keyOf(agentId) !== change.key || this.#stillInvalid(agentId, change.key)) continue;
      this.#safely(() => this.#lift(agentId, change.cause));
    }
    for (const entry of change.shown) {
      const launchId = this.ports.launchId(entry.agentId);
      this.#safely(() =>
        this.ports.restored({
          agentId: entry.agentId,
          reason: entry.reason,
          releaseCause: change.cause,
          restoredAtMs: Date.now(),
          ...(launchId ? { launchId } : {}),
        }),
      );
      if (entry.shownAs === "notice")
        this.#safely(() => this.ports.notice(entry.agentId, undefined));
    }
  }

  #keyOf(agentId: string): CredentialKey {
    const config = this.ports.configOf(agentId);
    return config ? credentialKeyOf(agentId, config) : ownCredentialKey(agentId);
  }

  #stillInvalid(agentId: string, key: CredentialKey): boolean {
    const config = this.ports.configOf(agentId);
    return config
      ? this.ledger.invalidFor(key, config.model) !== undefined
      : this.ledger.hasInvalid(key);
  }

  /** The other running Agents on a shared sign-in are held and told, in a notice, what to expect. */
  #holdSiblings(change: Extract<LedgerChange, { kind: "recorded" }>): void {
    if (!isSharedKey(change.key)) return;
    const { key, record } = change;
    for (const agentId of [...this.ports.runningAgentIds()]) {
      const config = this.ports.configOf(agentId);
      if (agentId === change.agentId || !config || credentialKeyOf(agentId, config) !== key)
        continue;
      if (!appliesToModel(record, config.model) || !this.#hold(agentId, key, record.reason))
        continue;
      const shown = { agentId, reason: record.reason, shownAs: "notice" } as const;
      if (this.ledger.noteShown(key, record, shown))
        this.#safely(() =>
          this.ports.notice(agentId, this.ports.noticeText(config, record.reason)),
        );
    }
  }

  /** The credential works again for the Agent: it is told what it kept, or started for it. */
  #lift(agentId: string, cause: CredentialReleaseCause): void {
    const live = this.ports.isRunning(agentId);
    this.#cancelClosed(agentId);
    this.ports.deliveryGate.endHold(agentId, "credential_invalid");
    logger.info("Provider credential usable again; held deliveries released", {
      event: "agent.runtime.credential_invalid_released",
      agent_id: agentId,
      release_cause: cause,
      live,
    });
    if (live) this.ports.present(agentId);
    // A person's Start is the launch: waking here would start a second one beside it.
    else if (cause !== "explicit_start") this.ports.wake(agentId);
  }

  #cancelClosed(agentId: string): void {
    this.#closed.get(agentId)?.();
    this.#closed.delete(agentId);
  }

  #safely(effect: () => void): void {
    try {
      effect();
    } catch (error) {
      logger.error("A credential hold side effect failed", {
        event: "agent.runtime.credential_hold_effect_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
