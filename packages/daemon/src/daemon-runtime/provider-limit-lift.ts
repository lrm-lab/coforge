import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { AgentControl } from "#src/agent-runtime/agent-control";
import type { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";

const logger = getLogger(["coforge", "daemon", "daemon-runtime"]);

/** Every owner of a wait that a provider's quota can cause. Each one ends its own waits. */
export type ProviderLimitLiftPorts = {
  agents: {
    restartConfig(agentId: string): { config: { provider: string } } | undefined;
    /** Present while the Agent's process is up. */
    session(agentId: string): unknown;
  };
  /** Delivery holds raised by a rate limit, including ones restored after a restart. */
  hold: Pick<RuntimeErrorDeliveryHold, "releaseRateLimitBackoffs">;
  /** Managed Start retries that wait on a quota reset. */
  launchRetries: Pick<AgentControl, "endQuotaLaunchWaits">;
  /** The launch waits that keep a failed launch from reporting its Agent inactive. */
  launchWaits: Pick<AgentOfflineResidency, "endLaunchWaits">;
  /** Wake cooldowns that came from a quota reset time. */
  wakeCooldowns: Pick<LaunchFailureBackoff, "endRecoveryWaits">;
};

/** How many waits each owner ended. */
export type ProviderLimitLift = {
  backoffs: number;
  launchRetries: number;
  launchWaits: number;
  wakeCooldowns: number;
};

/**
 * `provider`'s limit was lifted (a reset credit was spent): every wait that limit caused ends now,
 * each through the owner that holds it, so nobody keeps waiting up to the longest backoff on a
 * limit that is gone. Only waits this provider's quota or rate limit caused end; a short launch
 * backoff or another provider's wait stays. An owner that fails is logged and does not stop the
 * others.
 *
 * Ending a wait is not waking an Agent: an Agent without a process keeps its queued deliveries
 * for its next launch, and a wake cooldown simply stops deferring the next delivery's wake.
 */
export function liftProviderLimit(
  ports: ProviderLimitLiftPorts,
  provider: RuntimeProvider,
): ProviderLimitLift {
  const ending = (owner: keyof ProviderLimitLift, end: () => number): number => {
    try {
      return end();
    } catch (error) {
      logger.warning("A wait could not be ended after a provider's limit was lifted", {
        event: "daemon_runtime:provider_limit_lift_failed",
        provider,
        owner,
        error_code: diagnosticErrorCode(error),
      });
      return 0;
    }
  };
  const lift: ProviderLimitLift = {
    backoffs: ending("backoffs", () =>
      ports.hold.releaseRateLimitBackoffs(
        provider,
        (agentId) => ports.agents.session(agentId) !== undefined,
      ),
    ),
    launchWaits: ending("launchWaits", () => ports.launchWaits.endLaunchWaits(provider)),
    launchRetries: ending("launchRetries", () => ports.launchRetries.endQuotaLaunchWaits(provider)),
    // A wake cooldown records no provider: the Agent it defers is the one with a restart config
    // for this provider, because a wake needs one.
    wakeCooldowns: ending("wakeCooldowns", () =>
      ports.wakeCooldowns.endRecoveryWaits(
        (agentId) => ports.agents.restartConfig(agentId)?.config.provider === provider,
      ),
    ),
  };
  if (Object.values(lift).some((count) => count > 0))
    logger.info("Waits ended after a provider's limit was lifted", {
      event: "daemon_runtime:provider_limit_lifted",
      provider,
      ...lift,
    });
  return lift;
}
