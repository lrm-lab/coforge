/**
 * How long the router reuses a route's preload (`defaultPreload: "intent"`: the pointer resting on
 * a link reads what it opens): a navigation within this long of the preload takes its loader's
 * result instead of running the loader again. A Query a loader reads only for the page it opens
 * (`conversationOpenQuery`) is kept at least this long, so the navigation still finds it.
 */
export const PRELOAD_STALE_MS = 30_000;
