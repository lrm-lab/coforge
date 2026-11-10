import type {
  ModelCatalogRefreshOutcome,
  ModelCatalogRefreshRead,
  ModelCatalogRefreshStart,
} from "#src/server/computers/computer-model-catalog-refresh.server";
import { pollForAnswer } from "./poll-for-answer";

/** A single provider's probe is often quick. */
const RUNTIME_CATALOG_REFRESH_FIRST_POLL_INTERVAL_MS = 500;
/** How often the page asks for the Computer's answer once it is taking a while. */
const RUNTIME_CATALOG_REFRESH_POLL_INTERVAL_MS = 1_500;
/** Longer than the Daemon's 45 second probe budget, and inside the 60 second pending lifetime of
 * the request (`MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS`), after which no reply is stored. */
export const RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS = 50_000;

/** What a refresh comes back with: the Computer's outcome, or no answer in time. */
export type RuntimeCatalogRefreshResult = ModelCatalogRefreshOutcome | { status: "timeout" };

/**
 * Starts a refresh and asks for its answer until it settles (`pollForAnswer`), so no request is
 * held while the Computer probes. A refresh that could not start is an error; the deadline and the
 * caller going away both end the wait as a timeout. A read that refuses ends as a thrown failure,
 * as a refused start does.
 */
export async function awaitRuntimeCatalogRefresh(options: {
  start(): Promise<ModelCatalogRefreshStart>;
  read(requestId: string): Promise<ModelCatalogRefreshRead>;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RuntimeCatalogRefreshResult> {
  const started = await options.start();
  if (started.status === "refused") throw new Error("Computer is not available");
  if (started.status === "failed") return { status: "error" };
  const answer = await pollForAnswer<ModelCatalogRefreshRead | { status: "timeout" }>({
    read: () => options.read(started.requestId),
    onGiveUp: { status: "timeout" },
    signal: options.signal,
    firstIntervalMs: RUNTIME_CATALOG_REFRESH_FIRST_POLL_INTERVAL_MS,
    intervalMs: RUNTIME_CATALOG_REFRESH_POLL_INTERVAL_MS,
    deadlineMs: RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS,
    now: options.now,
    sleep: options.sleep,
  });
  if (answer.status === "refused") throw new Error("Computer is not available");
  return answer.status === "settled" ? answer.outcome : answer;
}
