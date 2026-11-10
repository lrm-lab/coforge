import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { thrownMessage, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentMessageAttentionIndex, MessageAttention } from "./agent-message-attention-index";
import { PENDING_WINDOW_LIMIT } from "./agent-message-attention-index-helpers";
import { isTrackedMention } from "./mention-delivery-tracker";
import type { AgentRecoveryContext } from "./runtime-launch-intent";
import type { LaunchRequest } from "./runtime-launch-types";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * A stored native Session the provider refuses to replay (Codex's encrypted reasoning no longer
 * decrypts after the backend or key changed, openai/codex#17541) fails every later turn the same
 * way until a person resets it. The adapter says so on the failed turn's `error` event
 * (`sessionRecovery`); once that turn has ended, the daemon invalidates the Session and
 * cold-starts a fresh one in its place.
 *
 * One launch's watch. A launch that resumed a stored Session replaces it at most once: `settle`
 * spends the watch only when the Session was replaced, so a recovery that did not proceed (the
 * process would not exit, a guard declined) leaves it armed for the next rejected turn. A launch
 * that did not resume one never acts, and a fresh Session that fails the same way is left to the
 * ordinary runtime-error path, so the recovery cannot loop.
 */
export class ProviderReplayWatch {
  #rejected = false;
  #attempting = false;
  #stored: string | undefined;

  /** The stored Session this launch continued, or undefined where there is none to replace: a
   * Session the launch created, recycled or had replaced (the provider replaced it, or reported
   * another id than the one asked for), and a Memory Agent's conversation-scoped ones. */
  constructor(
    resumedSessionId: string | undefined,
    exclude: Readonly<{
      memoryAgent: boolean;
      replacedSessionId: string | undefined;
      reportedSessionId: string | undefined;
    }>,
  ) {
    const replaced =
      exclude.replacedSessionId !== undefined ||
      (exclude.reportedSessionId !== undefined && exclude.reportedSessionId !== resumedSessionId);
    this.#stored = exclude.memoryAgent || replaced ? undefined : resumedSessionId;
  }

  /** Acts on one event of the launch: once the turn whose replay was rejected has ended, `replace`
   * ends the runtime and cold-starts a fresh Session with the stored one's id, and says whether it
   * did. A failure of `replace` is logged and leaves the watch armed. */
  observe(
    event: AgentRuntimeEvent,
    agentId: string,
    replace: (storedSessionId: string) => Promise<boolean>,
  ): void {
    if (this.#stored === undefined || this.#attempting) return;
    if (event.type === "error" && event.sessionRecovery === "provider_replay_rejected")
      this.#rejected = true;
    if (event.type !== "completed" || !this.#rejected) return;
    this.#rejected = false;
    this.#attempting = true;
    const stored = this.#stored;
    replace(stored).then(
      (replaced) => this.#settle(replaced),
      (error: unknown) => {
        this.#settle(false);
        logger.error("Replacing a Session the provider rejected failed", {
          event: "agent.runtime.replay_rejected_recovery_failed",
          agent_id: agentId,
          error: thrownMessage(error),
        });
      },
    );
  }

  /** The attempt ended; only a replaced Session spends the watch. */
  #settle(replaced: boolean): void {
    this.#attempting = false;
    if (replaced) this.#stored = undefined;
  }
}

/** What a launch was started with and a cold start must not lose. */
export type CarriedStart = Pick<LaunchRequest, "recovery" | "resumePrompt" | "introductionPrompt">;

/** A message that reached the Agent only as tracked @mentions, with the deliveries that carried it. */
export type PendingMention = Readonly<{ target: string; deliveryIds: readonly string[] }>;

/**
 * The messages among `attention` that reached the Agent only as tracked @mentions, read from its
 * attention window before the exit clears it. A message outside the bounded window, or one any
 * untracked delivery also carried, is not listed: it is counted like any other unread message.
 */
export function pendingMentions(
  agentId: string,
  attention: readonly Pick<MessageAttention, "target">[],
  window: Pick<AgentMessageAttentionIndex, "pendingWindow">,
): PendingMention[] {
  const mentions: PendingMention[] = [];
  for (const { target } of attention) {
    const bySequence = new Map<number, AgentMessageDelivery[]>();
    for (const { delivery } of window.pendingWindow(agentId, target, PENDING_WINDOW_LIMIT)) {
      const deliveries = bySequence.get(delivery.sequence);
      if (deliveries) deliveries.push(delivery);
      else bySequence.set(delivery.sequence, [delivery]);
    }
    for (const deliveries of bySequence.values())
      if (deliveries.every(isTrackedMention))
        mentions.push({ target, deliveryIds: deliveries.map((d) => d.deliveryId) });
  }
  return mentions;
}

/** The mentions the server issues again: every delivery of the message was handed back. A mention
 * the tracker did not hand back (drained, or forgotten) is not here, so it is counted. */
export function reissuedMentions(
  mentions: readonly PendingMention[],
  handedBack: readonly string[],
): PendingMention[] {
  const back = new Set(handedBack);
  return mentions.filter(({ deliveryIds }) => deliveryIds.every((id) => back.has(id)));
}

/** The `parked` deliveries `check()` did not already count: one held before it was read is in the
 * attention as well, and one handed back is issued again by the server. */
export function newlyParked<T extends Pick<AgentMessageDelivery, "deliveryId">>(
  parked: readonly T[],
  heldBefore: ReadonlySet<string>,
  handedBack: readonly string[],
): T[] {
  const back = new Set(handedBack);
  return parked.filter(({ deliveryId }) => !heldBefore.has(deliveryId) && !back.has(deliveryId));
}

const carriedOf = ({ recovery, resumePrompt, introductionPrompt }: CarriedStart): CarriedStart => ({
  ...(recovery ? { recovery } : {}),
  ...(resumePrompt !== undefined ? { resumePrompt } : {}),
  ...(introductionPrompt !== undefined ? { introductionPrompt } : {}),
});

/**
 * What the fresh Session is told: what the rejected launch was started with (a Start's recovery,
 * its resume or introduction prompt, which the Agent never got to act on) and the targets whose
 * messages reached the Agent and were never read, plus the `parked` deliveries that arrived while
 * the runtime was ending, folded into one `unreadSummary`. A server Start carries the same
 * `unreadSummary`. `check()` counts, not `unreadDeliveries()`: that one leaves out messages a
 * notice previewed in full, and a fresh Session holds none of those previews. A Start's
 * summary-only targets were never in `check()` (only recovered messages are), so the counts add.
 * The `reissued` mentions are left out: the server issues each of them again.
 */
export function carriedStart(
  started: CarriedStart,
  attention: readonly Pick<MessageAttention, "target" | "pendingCount">[],
  parked: readonly Pick<AgentMessageDelivery, "target">[] = [],
  reissued: readonly Pick<PendingMention, "target">[] = [],
): CarriedStart {
  const counts = new Map<string, number>();
  const add = (target: string | undefined, count: number) => {
    if (target && count > 0) counts.set(target, (counts.get(target) ?? 0) + count);
  };
  for (const [target, count] of Object.entries(started.recovery?.unreadSummary ?? {}))
    add(target, count);
  const reissuedCount = new Map<string, number>();
  for (const { target } of reissued)
    reissuedCount.set(target, (reissuedCount.get(target) ?? 0) + 1);
  for (const { target, pendingCount } of attention)
    add(target, pendingCount - (reissuedCount.get(target) ?? 0));
  for (const { target } of parked) add(target, 1);
  const { recovery } = started;
  return carriedOf({
    ...started,
    ...(recovery || counts.size
      ? { recovery: { ...recovery, unreadSummary: Object.fromEntries(counts) } }
      : {}),
  });
}

/**
 * One start from two: `own` keeps every field it sets, and the unread summaries take the larger
 * count per target, because both can describe the same unread messages.
 */
export function mergeCarried(own: CarriedStart, owed: CarriedStart): CarriedStart {
  const a = own.recovery;
  const b = owed.recovery;
  const summary: Record<string, number> = { ...b?.unreadSummary };
  for (const [target, count] of Object.entries(a?.unreadSummary ?? {}))
    summary[target] = Math.max(summary[target] ?? 0, count);
  const wakeMessage = a?.wakeMessage ?? b?.wakeMessage;
  // The launch's own messages, then the owed ones it does not already carry.
  const ownIds = new Set(a?.resumeMessages?.map(({ deliveryId }) => deliveryId));
  const resumeMessages = [
    ...(a?.resumeMessages ?? []),
    ...(b?.resumeMessages ?? []).filter(({ deliveryId }) => !ownIds.has(deliveryId)),
  ];
  const conversationIds = { ...b?.unreadConversationIds, ...a?.unreadConversationIds };
  const recovery: AgentRecoveryContext = {
    ...(wakeMessage ? { wakeMessage } : {}),
    ...(resumeMessages.length ? { resumeMessages } : {}),
    ...(Object.keys(summary).length ? { unreadSummary: summary } : {}),
    ...(Object.keys(conversationIds).length ? { unreadConversationIds: conversationIds } : {}),
  };
  return carriedOf({
    ...(a || b ? { recovery } : {}),
    resumePrompt: own.resumePrompt ?? owed.resumePrompt,
    introductionPrompt: own.introductionPrompt ?? owed.introductionPrompt,
  });
}

/** What the launch about to start is told: `request` with `owed` folded under its own start (a
 * Start's recovery is `startRecovery`), or `request` itself when nothing is owed. */
export function withOwed(
  request: LaunchRequest,
  startRecovery: AgentRecoveryContext | undefined,
  owed: CarriedStart | undefined,
): LaunchRequest {
  const own = startRecovery ? { ...request, recovery: startRecovery } : request;
  return owed ? { ...own, ...mergeCarried(own, owed) } : own;
}

/**
 * What a Session's cold start owes its Agent's next launch. The cold start carries the rejected
 * launch's start and unread summary, but the attention and the parked deliveries it was built
 * from are gone once it is built, so it stays owed until a launch for the Agent has told it: a
 * launch that fails, or whose recovery notice is refused, owes it still. A Stop, or the Agent's
 * delete (which stops it first), drops it. Memory only: a Daemon restart recovers unread messages
 * from the cloud's read boundary instead.
 */
export class OwedRecovery {
  readonly #owed = new Map<string, CarriedStart>();

  /** Owes `carried`, on top of anything already owed. */
  owe(agentId: string, carried: CarriedStart): void {
    const earlier = this.#owed.get(agentId);
    this.#owed.set(agentId, earlier ? mergeCarried(carried, earlier) : carried);
  }

  /** What the Agent's next launch owes, if anything, and `paid` for that launch to call once it has
   * told it. The `queued` deliveries are counted in, because a launch that tells a recovery drops
   * them and they arrived after what is owed was counted. */
  owing(
    agentId: string,
    queued: readonly Pick<AgentMessageDelivery, "target">[],
  ): { carried: CarriedStart; paid(): void } | undefined {
    const owed = this.#owed.get(agentId);
    if (!owed) return undefined;
    return {
      carried: carriedStart(owed, [], queued),
      // Only what this launch was handed: a newer debt stays owed.
      paid: () => {
        if (this.#owed.get(agentId) === owed) this.#owed.delete(agentId);
      },
    };
  }

  drop(agentId: string): void {
    this.#owed.delete(agentId);
  }

  clear(): void {
    this.#owed.clear();
  }
}
