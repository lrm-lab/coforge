/**
 * Where a target's consumed frontier came from — diagnostics only, never a decision. The record
 * lives in memory beside the state it describes, keyed by that state's own object, so nothing is
 * persisted and a restart honestly reads `loaded`: the file holds the number, not the reason.
 */
export type FrontierSource =
  | "history_read"
  | "send_context"
  | "model_seen"
  | "reset"
  | "loaded"
  | "unset";

const sources = new WeakMap<object, FrontierSource>();

/** Notes what last moved—or, for `reset`, cleared—the frontier of one target's state. */
export function noteFrontierSource(entry: object, source: FrontierSource): void {
  sources.set(entry, source);
}

/** Where that state's frontier last came from: what moved (or cleared) it here, `loaded` for a
 * number this process did not write, and `unset` when the target has no frontier at all. */
export function frontierSourceOf(entry: { seq?: number } | undefined): FrontierSource {
  const recorded = entry === undefined ? undefined : sources.get(entry);
  if (recorded !== undefined) return recorded;
  return entry?.seq === undefined ? "unset" : "loaded";
}
