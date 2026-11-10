import type { AgentRuntimeConfig } from "@coforge/agent";
import { isRuntimeAuthProvider } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import type { CredentialReleaseCause } from "@lrm/coforge-sdk/internal";
import type { CredentialInvalidReason } from "#src/agent-runtime/credential-invalid";
import { hasOwnLogin } from "./provider-credentials";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Whose sign-in an Agent's provider uses: the Computer's own login for its runtime (`shared:`,
 * every Agent on it shares the fate) or credentials only this Agent has (`agent:`). */
export type CredentialKey = `shared:${string}` | `agent:${string}`;

export const ownCredentialKey = (agentId: string): CredentialKey => `agent:${agentId}`;
export const sharedCredentialKey = (runtime: string): CredentialKey => `shared:${runtime}`;
export const isSharedKey = (key: CredentialKey): boolean => key.startsWith("shared:");

/** The runtime whose Computer-wide login this Agent uses, or undefined when it brings its own
 * credentials (a custom provider, or an environment that relocates the login). */
export function sharedAuthRuntime(config: AgentRuntimeConfig): string | undefined {
  if (!isRuntimeAuthProvider(config.provider) || config.providerConfig) return undefined;
  return hasOwnLogin(config.provider, config.envVars ?? {}) ? undefined : config.provider;
}

export function credentialKeyOf(agentId: string, config: AgentRuntimeConfig): CredentialKey {
  const runtime = sharedAuthRuntime(config);
  return runtime ? sharedCredentialKey(runtime) : ownCredentialKey(agentId);
}

/** One known-invalid credential. A plan that lacks a model is invalid for that model only. */
export type InvalidRecord = Readonly<{
  reason: CredentialInvalidReason;
  model?: string;
  recordedAtMs: number;
}>;

export const appliesToModel = (record: InvalidRecord, model: string): boolean =>
  record.reason !== "user_model_access" || record.model === model.trim();

/** What an Agent showed of a record, so its release can tell the server the Agent recovered. */
export type ShownEntry = Readonly<{
  agentId: string;
  reason: CredentialInvalidReason;
  shownAs: "own_error" | "notice";
}>;

export type { CredentialReleaseCause };

export type LedgerChange =
  | Readonly<{
      kind: "recorded";
      key: CredentialKey;
      record: InvalidRecord;
      agentId?: string;
      /** The recording Agent's config: where an agent-scoped credential is found. */
      config?: AgentRuntimeConfig;
    }>
  | Readonly<{
      kind: "released";
      key: CredentialKey;
      record: InvalidRecord;
      cause: CredentialReleaseCause;
      shown: readonly ShownEntry[];
    }>
  /** The records ended with the Agent that held them: nothing is restored, so nothing is reported. */
  | Readonly<{ kind: "dropped"; key: CredentialKey }>;

/**
 * Which credentials are known invalid (the reference Computer's `ProviderLimitLedger.invalid`).
 * In memory only: a Daemon restart finds the credential afresh. Records of a key are kept apart
 * by kind, one per model for a plan without it and one for everything else, and each remembers
 * the Agents that showed it, merged when a newer record of its kind replaces it.
 */
export class CredentialInvalidLedger {
  readonly #records = new Map<CredentialKey, InvalidRecord[]>();
  readonly #shown = new Map<InvalidRecord, ShownEntry[]>();
  readonly #listeners = new Set<(change: LedgerChange) => void>();

  /** Whether `key` has a record, or, without a key, whether any key does. */
  hasInvalid(key?: CredentialKey): boolean {
    return key === undefined ? this.#records.size > 0 : this.#records.has(key);
  }

  /** The record that holds an Agent on `key` running `model`: a general one first. */
  invalidFor(key: CredentialKey, model: string): InvalidRecord | undefined {
    const records = this.#records.get(key);
    return (
      records?.find((record) => record.reason !== "user_model_access") ??
      records?.find((record) => appliesToModel(record, model))
    );
  }

  record(
    key: CredentialKey,
    record: InvalidRecord,
    agentId?: string,
    config?: AgentRuntimeConfig,
  ): InvalidRecord {
    const stored: InvalidRecord =
      record.reason === "user_model_access"
        ? { ...record, model: (record.model ?? "").trim() }
        : { reason: record.reason, recordedAtMs: record.recordedAtMs };
    const current = this.#records.get(key) ?? [];
    const kept = current.filter((each) =>
      stored.reason === "user_model_access"
        ? !(each.reason === "user_model_access" && each.model === stored.model)
        : each.reason === "user_model_access",
    );
    this.#records.set(key, [...kept, stored]);
    const carried = current
      .filter((each) => !kept.includes(each))
      .flatMap((each) => {
        const entries = this.#shown.get(each) ?? [];
        this.#shown.delete(each);
        return entries;
      });
    this.#shown.set(stored, mergeShown(carried, agentId ? [ownError(agentId, stored)] : []));
    this.#announce({
      kind: "recorded",
      key,
      record: stored,
      ...(agentId ? { agentId } : {}),
      ...(config ? { config } : {}),
    });
    return stored;
  }

  /** Notes that `entry`'s Agent showed `record`; false when it had shown it already (or the record
   * has ended), so the Agent is not shown it twice. */
  noteShown(key: CredentialKey, record: InvalidRecord, entry: ShownEntry): boolean {
    const stored = this.#records.get(key)?.find((each) => each === record);
    if (!stored) return false;
    const shown = this.#shown.get(stored) ?? [];
    if (shown.some((each) => each.agentId === entry.agentId && each.reason === entry.reason))
      return false;
    this.#shown.set(stored, mergeShown(shown, [entry]));
    return true;
  }

  /** Ends the records of `key` that `only` takes (all by default); returns what ended. */
  release(
    key: CredentialKey,
    cause: CredentialReleaseCause,
    only: (record: InvalidRecord) => boolean = () => true,
  ): InvalidRecord[] {
    const records = this.#records.get(key);
    const released = records?.filter(only) ?? [];
    if (!records || released.length === 0) return [];
    const kept = records.filter((record) => !released.includes(record));
    if (kept.length > 0) this.#records.set(key, kept);
    else this.#records.delete(key);
    for (const record of released) {
      const shown = this.#shown.get(record) ?? [];
      this.#shown.delete(record);
      this.#announce({ kind: "released", key, record, cause, shown });
    }
    return released;
  }

  /** Ends the records of `key` without a release: their Agent is gone, nothing was restored. */
  drop(key: CredentialKey): void {
    const records = this.#records.get(key);
    if (!records) return;
    this.#records.delete(key);
    for (const record of records) this.#shown.delete(record);
    this.#announce({ kind: "dropped", key });
  }

  subscribe(listener: (change: LedgerChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A listener that throws does not keep the others from the change: it has happened already. */
  #announce(change: LedgerChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        logger.error("A credential record listener failed", {
          event: "agent.runtime.credential_listener_failed",
          change: change.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

const ownError = (agentId: string, record: InvalidRecord): ShownEntry => ({
  agentId,
  reason: record.reason,
  shownAs: "own_error",
});

/** One entry per Agent and reason; an Agent's own error stays the way it was shown. */
function mergeShown(current: readonly ShownEntry[], entries: readonly ShownEntry[]): ShownEntry[] {
  const merged = new Map<string, ShownEntry>();
  for (const entry of [...current, ...entries]) {
    const id = `${entry.agentId}\0${entry.reason}`;
    merged.set(
      id,
      merged.get(id)?.shownAs === "own_error" ? { ...entry, shownAs: "own_error" } : entry,
    );
  }
  return [...merged.values()];
}
