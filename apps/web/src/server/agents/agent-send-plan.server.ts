import { HELD_CONTEXT_LIMIT, type FreshnessDecisionFactInput } from "@lrm/coforge-sdk/internal";
import type { AgentTargetFreshness } from "./agent-target-freshness.server";
import type {
  AgentMessageRecord,
  AgentSendMessageInput,
  AgentSendMessageResult,
} from "./agent-messages.server";

/** The actions a held send offers. */
const HELD_SEND_AVAILABLE_ACTIONS = ["check_messages", "send_draft", "send_anyway"] as const;

/** A send the plan lets through, stated once for every forward reason. */
type ForwardPlan = {
  decision: "forward" | "bypass";
  reason: string;
  fact: Omit<FreshnessDecisionFactInput, "agentId" | "target" | "decision" | "reason">;
  /** The consume effect: the read-through advances over messages the Agent has seen. */
  advanceTo?: number;
  /** A bypassed hold's report of what the Agent chose not to review. */
  recentUnread?: readonly AgentMessageRecord[];
};

/** The send's freshness decision: a held result, or how the send goes through. */
export async function planAgentSend(
  freshness: AgentTargetFreshness | undefined,
  input: AgentSendMessageInput,
  factId: (fact: Omit<FreshnessDecisionFactInput, "agentId" | "target">) => Promise<string>,
): Promise<(AgentSendMessageResult & { state: "held" }) | ForwardPlan> {
  const withheld = input.freshnessContextMode === "withheld";
  // The Agent reports the boundary it has already reviewed; the server advances its own
  // read-through to it (monotone) and uses the advanced value as the freshness boundary.
  let seen = 0;
  if (input.seenUpToSeq !== undefined) {
    if (!freshness?.advanceReadThrough)
      throw new Error("Agent read-through advancement is unavailable");
    seen = await freshness.advanceReadThrough(input.seenUpToSeq);
  }
  // What lies at or below that boundary, and what the Agent was shown one by one, is seen in either
  // mode: the mode decides what a hold presents, not what the Agent has already seen. With no
  // boundary, pending context starts above the Agent's own latest message.
  const pendingBoundary = seen || undefined;
  const excluded = input.seenExactSeqs?.length ? input.seenExactSeqs : undefined;
  const unconsumed = (await freshness?.readPending?.(pendingBoundary, excluded)) ?? [];
  // `continueAnyway` is the Agent's explicit decision to send anyway (`--send-draft --anyway`). It
  // short-circuits every hold and is never refused — there is no "denied" outcome.
  if (input.continueAnyway)
    return {
      decision: "bypass",
      reason: "continue_anyway",
      fact: { modelSeenSeq: seen || undefined },
      recentUnread: withheld ? [] : unconsumed.slice(-HELD_CONTEXT_LIMIT),
    };
  // Unconsumed context for this exact target -> `local_hold` over the unconsumed messages only; the
  // held boundary is their newest.
  if (unconsumed.length > 0) {
    const heldMessages = withheld ? [] : unconsumed.slice(-HELD_CONTEXT_LIMIT);
    // The inline window is bounded for display, so the true newer count comes from the repository's
    // unbounded count in *both* modes; without that seam the window's length is all we know and
    // `omittedMessageCount` stays 0.
    const newMessageCount =
      (await freshness?.countPending?.(pendingBoundary, excluded)) ?? unconsumed.length;
    const seenUpToSeq = maxSequence(unconsumed);
    return {
      state: "held",
      decision: "local_hold",
      reason: "exact_target_pending",
      producerFactId: await factId({
        decision: "local_hold",
        reason: "exact_target_pending",
        pendingMaxSeq: seenUpToSeq,
        modelSeenSeq: seen || undefined,
        heldMessageCount: heldMessages.length,
        omittedMessageCount: Math.max(0, newMessageCount - heldMessages.length),
      }),
      availableActions: HELD_SEND_AVAILABLE_ACTIONS,
      continueAnywaySuggested: (input.draftReholdCount ?? 0) >= 1,
      // Withheld mode never returns message bodies, senders, or metadata — only the state and a
      // count of everything still pending.
      heldMessages,
      newMessageCount,
      shownMessageCount: heldMessages.length,
      omittedMessageCount: Math.max(0, newMessageCount - heldMessages.length),
      seenUpToSeq,
      ...(withheld
        ? { freshnessContextMode: "withheld" as const, withheldMessageCount: newMessageCount }
        : {}),
    };
  }
  // Pending context the Agent had all been shown: forward, and advance the boundary over it when a
  // boundary already known reaches its newest message.
  //
  // The known boundary is not the client's alone (the Agent's reported `seenUpToSeq` and its
  // daemon's ledger): the server's own read-through counts too, which the `check` that showed
  // these messages already moved (the drain is ack-on-drain). That is what lets the steady
  // "notified → check → send" loop advance the boundary, so the Agent's exact set stays small
  // instead of growing to its 2500 cap; and it is safe because the drain already confirmed the
  // Agent was shown those messages.
  const pendingMaxSeq = excluded
    ? ((await freshness?.maxPendingSequence?.(pendingBoundary)) ?? 0)
    : 0;
  if (pendingMaxSeq > 0) {
    const known = Math.max(seen, (await freshness?.readThrough?.()) ?? 0);
    return {
      decision: "forward",
      reason: "exact_target_pending_already_seen",
      fact: {
        pendingMaxSeq,
        modelSeenSeq: known || undefined,
        heldMessageCount: 0,
        omittedMessageCount: 0,
      },
      advanceTo: known >= pendingMaxSeq ? pendingMaxSeq : undefined,
    };
  }
  // No pending context and a boundary: forward at that boundary.
  if (seen > 0)
    return { decision: "forward", reason: "model_seen_boundary", fact: { modelSeenSeq: seen } };
  // A first touch: no boundary at all. The target's recent context is loaded only for a
  // presented send, never a withheld one.
  const recent =
    !withheld && freshness?.readRecent
      ? await freshness.readRecent(HELD_CONTEXT_LIMIT, excluded)
      : undefined;
  if (recent?.maxSequence !== undefined) {
    const recentMaxSeq = recent.maxSequence;
    // Every recent message was already seen: forward and advance the boundary over the window.
    if (recent.unseen.length === 0)
      return {
        decision: "forward",
        reason: "target_first_touch_recent_context_already_seen",
        fact: {
          pendingMaxSeq: recentMaxSeq,
          modelSeenSeq: recentMaxSeq,
          heldMessageCount: 0,
          omittedMessageCount: 0,
        },
        advanceTo: recentMaxSeq,
      };
    // `syncing_hold` over the unconsumed messages; the notice's boundary is the whole window's
    // newest, which is what the Agent consumes by reading it.
    const heldMessages = recent.unseen.slice(-HELD_CONTEXT_LIMIT);
    return {
      state: "held",
      decision: "syncing_hold",
      reason: "target_first_touch_recent_context",
      producerFactId: await factId({
        decision: "syncing_hold",
        reason: "target_first_touch_recent_context",
        pendingMaxSeq: maxSequence(recent.unseen),
        heldMessageCount: heldMessages.length,
        omittedMessageCount: recent.unseen.length - heldMessages.length,
      }),
      availableActions: HELD_SEND_AVAILABLE_ACTIONS,
      continueAnywaySuggested: (input.draftReholdCount ?? 0) >= 1,
      heldMessages,
      newMessageCount: recent.unseen.length,
      shownMessageCount: heldMessages.length,
      omittedMessageCount: recent.unseen.length - heldMessages.length,
      seenUpToSeq: recentMaxSeq,
    };
  }
  return { decision: "forward", reason: "no_exact_target_pending_or_recent_context", fact: {} };
}

function maxSequence(messages: readonly { sequence: number }[]): number {
  let max = 0;
  for (const message of messages) if (message.sequence > max) max = message.sequence;
  return max;
}
