import {
  applyReactionToggle,
  type ReactionSummary,
  type Reactor,
  type VersionedReactions,
} from "./message-reactions";

/** Most messages one repair read asks about: what `loadMessageReactions` accepts. */
const REPAIR_LIMIT = 200;

type Reactions = ReactionSummary[] | undefined;
type Click = { emoji: string; reactor: Reactor; active: boolean };
/** A message's clicks still waiting for their answer, and the server's summary under them. */
type Pending = { base: { reactions: Reactions; version: number }; clicks: Click[] };

type Message = {
  id: string;
  sequence: number;
  reactions?: ReactionSummary[];
  reactionVersion?: number;
};

/**
 * Keeps one conversation's shown reactions in step with the server. A loaded message carries the
 * `reactionVersion` its reactions are at (`writeReaction` raises it); a summary from an event, a
 * repair read or the viewer's own click shows only when its version is above that, compared inside
 * `update`'s updater against the cached copy, since `loaded` can lag. The viewer's unanswered
 * clicks are folded over whatever shows, so a newer summary without them does not flicker them off.
 */
export function createReactionSync<M extends Message>(deps: {
  /** The loaded messages, for choosing what a repair reads; may lag the cache. */
  loaded: () => readonly M[];
  /** Replace one loaded message with what `update` makes of its cached copy, synchronously. */
  update: (messageId: string, update: (message: M) => M) => void;
  load: (messageIds: string[]) => Promise<Record<string, VersionedReactions>>;
  /** Re-reads the conversation after a click failed. */
  resync: () => Promise<unknown>;
}) {
  const pending = new Map<string, Pending>();

  /** `message` with its pending clicks folded over the newest server summary known for it. */
  const withClicks = (message: M, entry: Pending): M => {
    const version = message.reactionVersion ?? 0;
    // A re-read merged in since the clicks began may be newer than their base.
    if (version > entry.base.version) entry.base = { reactions: message.reactions, version };
    const reactions = entry.clicks.reduce<Reactions>(
      (shown, click) => applyReactionToggle(shown, click.emoji, click.reactor, click.active),
      entry.base.reactions,
    );
    return { ...message, reactions };
  };

  /** Shows `answer` if it is newer than what shows (none: only re-folds the pending clicks). */
  const show = (messageId: string, answer?: VersionedReactions) => {
    const entry = pending.get(messageId);
    let shown = false;
    deps.update(messageId, (message) => {
      let next = message;
      const current = Math.max(message.reactionVersion ?? 0, entry?.base.version ?? 0);
      if (answer && answer.version > current) {
        shown = true;
        const reactions = answer.reactions ?? undefined;
        next = { ...message, reactions, reactionVersion: answer.version };
      }
      return entry ? withClicks(next, entry) : next;
    });
    if (entry && !entry.clicks.length) pending.delete(messageId);
    return shown;
  };

  /** Shows a server summary (an event or a read) for a loaded message if it is newer. A summary
   * without a numeric version (from a server older than versions) is ignored. */
  const apply = (messageId: string, answer: VersionedReactions) =>
    Number.isFinite(answer.version) && show(messageId, answer);

  let repairing: Promise<void> | undefined;
  let repairAgain = false;
  const readAll = async () => {
    const newest = [...new Map(deps.loaded().map((message) => [message.id, message])).values()]
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, REPAIR_LIMIT);
    if (!newest.length) return;
    let answer: Record<string, VersionedReactions>;
    try {
      answer = await deps.load(newest.map((message) => message.id));
    } catch {
      return;
    }
    for (const [messageId, reactions] of Object.entries(answer)) apply(messageId, reactions);
  };
  /** Events may have been lost: re-read the newest loaded messages' reactions in one call. A repair
   * asked for while one is reading runs once more after it. */
  const repair = (): Promise<void> => {
    if (repairing) {
      repairAgain = true;
      return repairing;
    }
    repairing = readAll().finally(() => {
      repairing = undefined;
      if (repairAgain) {
        repairAgain = false;
        void repair();
      }
    });
    return repairing;
  };

  return {
    apply,
    repair,
    /** The viewer's click: shown at once (none without a viewer), sent, then settled by its answer
     * if nothing newer shows; a failure re-reads the conversation and still rejects. */
    toggle: async (
      messageId: string,
      emoji: string,
      reactor: Reactor | undefined,
      active: boolean,
      send: () => Promise<VersionedReactions>,
    ) => {
      const click = reactor && { emoji, reactor, active };
      if (click)
        deps.update(messageId, (message) => {
          const entry = pending.get(messageId) ?? {
            base: { reactions: message.reactions, version: message.reactionVersion ?? 0 },
            clicks: [],
          };
          pending.set(messageId, entry);
          if (!entry.clicks.includes(click)) entry.clicks.push(click);
          return withClicks(message, entry);
        });
      /** The click no longer pends: shows `answer` if newer, re-folding the clicks left. */
      const settle = (answer?: VersionedReactions) => {
        const entry = pending.get(messageId);
        if (entry) entry.clicks = entry.clicks.filter((other) => other !== click);
        show(messageId, answer && Number.isFinite(answer.version) ? answer : undefined);
      };
      let answer: VersionedReactions;
      try {
        answer = await send();
      } catch (error) {
        settle();
        void deps.resync().catch(() => {});
        throw error;
      }
      settle(answer);
    },
  };
}
