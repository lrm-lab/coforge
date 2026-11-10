import {
  type RuntimeProvider,
  type RuntimeUnavailableCode,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";
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

/** Which "up to date" sentence the count belongs in. Pi reports only the providers this Computer
 * holds credentials for, so its count can stay the same while a provider someone expects is simply
 * not configured; that line says so instead of leaving the gap to look like a failed refresh
 * (task #13). Every other runtime keeps the plain count. */
export function refreshLatestNoteKey(
  runtime: RuntimeProvider | undefined,
): "agent_form_model_refresh_latest" | "agent_form_model_refresh_latest_pi" {
  return runtime === RUNTIME_PROVIDER.PI
    ? "agent_form_model_refresh_latest_pi"
    : "agent_form_model_refresh_latest";
}
