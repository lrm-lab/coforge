import type { CodeAgentModelMetadata } from "@lrm/coforge-sdk/internal";
import { JsonlRequestError } from "#src/jsonl-error";
import { withDeadline } from "#src/deadline";

/** How long each bounded wait of a catalog discovery (`within`) lasts. A discovery that waits on
 * several requests grants each its own wait. */
export const CATALOG_DISCOVERY_TIMEOUT_MS = 5_000;

// Only adapter-authored messages may be persisted; provider output is untrusted.
export class CatalogDiscoveryError extends Error {}

export function within<T>(
  promise: Promise<T>,
  timeoutMs: number = CATALOG_DISCOVERY_TIMEOUT_MS,
): Promise<T> {
  return withDeadline(
    promise,
    timeoutMs,
    () => new CatalogDiscoveryError(`model catalog discovery timed out after ${timeoutMs} ms`),
  );
}

export function catalogErrorMessage(error: unknown): string {
  if (error instanceof CatalogDiscoveryError || error instanceof JsonlRequestError)
    return error.message;
  if (
    error instanceof Error &&
    [
      "code agent process exited unexpectedly",
      "code agent process produced invalid output",
      "code agent process rejected a message",
      "code agent process closed",
      "code agent process is closed",
      "code agent process tree did not exit",
    ].includes(error.message)
  )
    return error.message;
  return "model catalog discovery failed; untrusted error detail omitted";
}

export function isModel(
  model: CodeAgentModelMetadata | undefined,
): model is CodeAgentModelMetadata {
  return model !== undefined;
}
