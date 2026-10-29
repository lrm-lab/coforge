import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

/**
 * Settles one provider's model-catalog discovery per provider. A CLI that cannot start, or a
 * catalog that times out, is that provider's failure: the others still report, and the scan does
 * not turn one unusable runtime into "the Computer did not answer". Each failure is logged with
 * its provider id, so the runtime that has no catalog can be named.
 */
export async function settleCatalogDiscoveries<T extends object>(
  discoveries: readonly (readonly [RuntimeProvider, Promise<T>])[],
): Promise<Array<T & { provider: RuntimeProvider }>> {
  const settled = await Promise.all(
    discoveries.map(([provider, discovery]) =>
      discovery
        .catch((error: unknown) => {
          logger.warning("Code Agent model catalog discovery failed", {
            event: "code_agent_catalog:discovery_failed",
            provider,
            error_code: diagnosticErrorCode(error),
            outcome: "unavailable",
          });
          return undefined;
        })
        .then((result) => (result ? { ...result, provider } : undefined)),
    ),
  );
  return settled.flatMap((result) => (result ? [result] : []));
}
