import { getLogger } from "@logtape/logtape";
import { RuntimeStartFailedError, RuntimeVersionUnsupportedError } from "@lrm/coforge-anvil";
import {
  diagnosticErrorCode,
  type RuntimeProvider,
  type RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

/** The safe reason a failed catalog discovery reports: the typed classes a person can act on,
 * classified like the runtime report's unavailable codes; anything else stays `unknown` — native
 * diagnostics never leave the daemon. */
export function catalogFailureOf(error: unknown): {
  code: RuntimeUnavailableCode;
  diagnostic?: string;
} {
  if (error instanceof RuntimeStartFailedError)
    return {
      code: "start_failed",
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    };
  if (error instanceof RuntimeVersionUnsupportedError) return { code: "version_unsupported" };
  return { code: "unknown" };
}

export type CatalogDiscoverySettled<T> = {
  provider: RuntimeProvider;
  result?: T;
  failure?: { code: RuntimeUnavailableCode; diagnostic?: string };
};

/**
 * Settles one provider's model-catalog discovery per provider. A CLI that cannot start, or a
 * catalog that times out, is that provider's failure: the others still report, and the scan does
 * not turn one unusable runtime into "the Computer did not answer". Each failure is logged with
 * its provider id and classified reason, so the runtime that has no catalog can be named — and
 * the answer a requested refresh gives can say why.
 */
export async function settleCatalogDiscoveries<T extends object>(
  discoveries: readonly (readonly [RuntimeProvider, Promise<T>])[],
): Promise<CatalogDiscoverySettled<T>[]> {
  return Promise.all(
    discoveries.map(async ([provider, discovery]) => {
      try {
        return { provider, result: await discovery };
      } catch (error) {
        const failure = catalogFailureOf(error);
        logger.warning("Code Agent model catalog discovery failed", {
          event: "code_agent_catalog:discovery_failed",
          provider,
          error_code: diagnosticErrorCode(error),
          failure_code: failure.code,
          outcome: "unavailable",
        });
        return { provider, failure };
      }
    }),
  );
}
