/** Who reacted: the person's or Agent's own `id` (how the viewer's own reaction is found) and the
 * `label` to show, a person's name or an Agent's `@handle`. */
export type Reactor = { id: string; label: string };

/** One emoji's reactions on a message, as the server summarizes them (`reactionSummaries`). */
export type ReactionSummary = { emoji: string; count: number; reactors: Reactor[] };

/**
 * The summaries after `reactor` adds or removes `emoji`, computed locally so the chip can change
 * before the server answers. Keeps the server's first-reaction order: a new emoji goes last and a
 * reactor is appended to its emoji. Returns undefined once no reaction is left, the same shape a
 * message without reactions has.
 */
export function applyReactionToggle(
  reactions: readonly ReactionSummary[] | undefined,
  emoji: string,
  reactor: Reactor,
  active: boolean,
): ReactionSummary[] | undefined {
  const isReactor = (other: Reactor) => other.id === reactor.id;
  const current = reactions ?? [];
  const existing = current.find((reaction) => reaction.emoji === emoji);
  const next: ReactionSummary[] = active
    ? existing
      ? current.map((reaction) =>
          reaction === existing && !reaction.reactors.some(isReactor)
            ? { emoji, count: reaction.count + 1, reactors: [...reaction.reactors, reactor] }
            : reaction,
        )
      : [...current, { emoji, count: 1, reactors: [reactor] }]
    : current.flatMap((reaction) => {
        if (reaction !== existing || !reaction.reactors.some(isReactor)) return [reaction];
        const reactors = reaction.reactors.filter((other) => !isReactor(other));
        return reactors.length ? [{ emoji, count: reaction.count - 1, reactors }] : [];
      });
  return next.length ? next : undefined;
}

/** A message's reactions at one `reactionVersion` (`reaction-sync.ts`); null once none is left. */
export type VersionedReactions = { reactions: ReactionSummary[] | null; version: number };
