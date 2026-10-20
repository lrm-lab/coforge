type Sequenced = { id: string; sequence: number };

/** What a loaded message may say about its reactions (`reaction-sync.ts`). */
type Reacted = { reactions?: unknown; reactionVersion?: number };

/**
 * Merge two message lists by id, `incoming` winning on conflicts, ordered by sequence.
 * Every place that folds a page, a poll or a send result into the loaded conversation uses this.
 * Reactions are the one exception (`keepShownReactions`).
 */
export function mergeMessages<T extends Sequenced & Reacted>(
  base: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map(base.map((message) => [message.id, message]));
  for (const message of incoming)
    byId.set(message.id, keepShownReactions(byId.get(message.id), message));
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

/**
 * `incoming`, but with `shown`'s reactions unless `incoming`'s version is newer: a re-read of a
 * loaded message (its thread summary changed, a reconcile, an evicted page read again) may predate
 * a `message.reaction.v1` the page already applied, and a send's echo carries no reactions or
 * version at all. At the same version the shown copy also holds the viewer's pending clicks.
 */
function keepShownReactions<T extends Reacted>(shown: T | undefined, incoming: T): T {
  if (
    shown?.reactionVersion === undefined ||
    (incoming.reactionVersion !== undefined && shown.reactionVersion < incoming.reactionVersion)
  )
    return incoming;
  return { ...incoming, reactions: shown.reactions, reactionVersion: shown.reactionVersion };
}
