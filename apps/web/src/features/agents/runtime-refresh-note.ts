import type { RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";
import type { RuntimeCatalogRefreshResult } from "#src/features/computers/runtime-catalog-refresh-poll";

/** What one settled catalog refresh tells the person: how many models the provider offers now, or
 * why the Computer could not refresh it. A refresh that finds nothing new is said out loud, because
 * a list that re-renders unchanged otherwise reads as a button that did nothing (task #13). */
export type RuntimeRefreshNote =
  | { kind: "latest"; modelCount: number }
  | { kind: "failed"; code?: RuntimeUnavailableCode; diagnostic?: string };

export function runtimeRefreshNote(result: RuntimeCatalogRefreshResult): RuntimeRefreshNote {
  if (result.status === "refreshed" && "catalog" in result && result.catalog)
    return { kind: "latest", modelCount: result.catalog.models.length };
  return {
    kind: "failed",
    code: "code" in result ? result.code : undefined,
    diagnostic: "diagnostic" in result ? result.diagnostic : undefined,
  };
}
