/**
 * Where a target's consumed frontier came from — diagnostics only, never a decision. The record
 * lives in memory beside the state it describes, keyed by that state's own object, so nothing is
 * persisted and a restart honestly reads `loaded`: the file holds the number, not the reason.
 */
export type FrontierSource = "history_read" | "send_context" | "model_seen" | "loaded" | "unset";

const sources = new WeakMap<object, FrontierSource>();

export function noteFrontierSource(entry: object, source: FrontierSource): void {
  sources.set(entry, source);
}

/** Where that state's frontier last came from: what moved it here, `loaded` for a
 * number this process did not write, and `unset` when the target has no frontier at all. */
export function frontierSourceOf(entry: { seq?: number } | undefined): FrontierSource {
  const recorded = entry === undefined ? undefined : sources.get(entry);
  if (recorded !== undefined) return recorded;
  return entry?.seq === undefined ? "unset" : "loaded";
}
