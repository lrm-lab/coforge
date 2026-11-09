import { getLogger } from "@logtape/logtape";
import {
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  diagnosticErrorCode,
  type ResetCreditOutcome,
  type RuntimeProvider,
  utf8Encoder,
} from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "@lrm/coforge-anvil";
import { liftProviderLimit, type ProviderLimitLiftPorts } from "./provider-limit-lift";
import { USAGE_SCAN_READ_TIMEOUT_MS } from "./runtime-agent-flows";
import { stampedUsage } from "./usage-scan-response";

const logger = getLogger(["coforge", "daemon", "daemon-runtime"]);

/** What a reset-credit attempt needs from the runtime that owns the providers and the Agents. */
export type ResetCreditPorts = {
  assertRunning(): void;
  workspaceRoot: string;
  createProvider(provider: RuntimeProvider): {
    consumeResetCredit?(options: {
      workingDirectory: string;
      idempotencyKey: string;
    }): Promise<ResetCreditOutcome>;
    /** The adapter's own usage read, so the answer can carry the credits left. */
    readUsage?(options: {
      workingDirectory: string;
      timeoutMs: number;
    }): Promise<UsageSnapshot | null | undefined>;
  };
} & ProviderLimitLiftPorts;

export type ResetCreditConsumeResult = {
  outcome: ResetCreditOutcome;
  /** A usage read made after the attempt, when there was one. Never an earlier observation. */
  snapshotJson?: Uint8Array;
};

/** An outcome decided before the credit could be asked for: there is nothing new to read. */
const REFUSALS: ReadonlySet<ResetCreditOutcome> = new Set(["unsupported", "reauth_required"]);

/**
 * Spends one reset credit of a provider's account, then reads its usage again so the page shows the
 * credits left. `unknown` is the answer to anything that leaves the credit possibly spent. A
 * `reset`, or an `already_redeemed` (an earlier attempt with this key spent the credit and its
 * reply was lost), lifts the provider's limit here (`liftProviderLimit`), because the waits it
 * caused are over. Only the Workspace child that took the request lifts its own waits. The usage
 * sent back is read from the adapter after the attempt; the Daemon's earlier
 * observation of the account, which a usage scan falls back to, still counts the spent credit, so
 * with no fresh read the answer carries none and the page reads again. The key goes to the provider as given and is never logged.
 */
export async function consumeResetCredit(
  ports: ResetCreditPorts,
  provider: RuntimeProvider,
  idempotencyKey: string,
): Promise<ResetCreditConsumeResult> {
  try {
    ports.assertRunning();
  } catch {
    // Nothing was asked of the provider, but a Daemon on its way out cannot say it was not.
    return { outcome: "unknown" };
  }
  const outcome = await attempt(ports, provider, idempotencyKey);
  logger.info("Reset credit attempt answered", {
    event: "daemon_runtime:reset_credit_consumed",
    provider,
    outcome,
  });
  if (outcome === "reset" || outcome === "already_redeemed") liftProviderLimit(ports, provider);
  if (REFUSALS.has(outcome)) return { outcome };
  const snapshot = await freshUsage(ports, provider);
  return snapshot ? { outcome, snapshotJson: snapshot } : { outcome };
}

/** A usage read made now, encoded for the answer; nothing when the adapter has none or fails. */
async function freshUsage(
  ports: ResetCreditPorts,
  provider: RuntimeProvider,
): Promise<Uint8Array | undefined> {
  try {
    const reading = await ports.createProvider(provider).readUsage?.({
      workingDirectory: ports.workspaceRoot,
      timeoutMs: USAGE_SCAN_READ_TIMEOUT_MS,
    });
    return reading
      ? utf8Encoder.encode(JSON.stringify(stampedUsage(reading, () => new Date())))
      : undefined;
  } catch {
    return undefined;
  }
}

async function attempt(
  ports: ResetCreditPorts,
  provider: RuntimeProvider,
  idempotencyKey: string,
): Promise<ResetCreditOutcome> {
  try {
    if (!RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider]) return "unsupported";
    const adapter = ports.createProvider(provider);
    if (!adapter.consumeResetCredit) return "unsupported";
    return await adapter.consumeResetCredit({
      workingDirectory: ports.workspaceRoot,
      idempotencyKey,
    });
  } catch (error) {
    logger.warning("Reset credit attempt failed", {
      event: "daemon_runtime:reset_credit_failed",
      provider,
      error_code: diagnosticErrorCode(error),
    });
    return "unknown";
  }
}
