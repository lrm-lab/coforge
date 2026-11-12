import { isCardEvent } from "./agent-message-attention-index-helpers";

/**
 * How hard the daemon works to make an Agent aware of a delivery (task #14).
 *
 * `reliable`: the Agent is told again, with a bounded retry and a persisted state, until it reads
 * the batch — a mention of it, a direct message, work assigned to it, the answer to a card it has
 * to act on.
 *
 * `best_effort`: one notice, no retry, and no bearing on whether the Agent counts as reachable —
 * ordinary channel traffic it subscribes to, and maintenance items that need nothing from it.
 *
 * One function decides this, and everything that sends a notice asks it: two places disagreeing
 * about what is important is how a person's mention turns into no notice while a cleaner run keeps
 * waking the Agent.
 */
export const DELIVERY_IMPORTANCE = {
  RELIABLE: "reliable",
  BEST_EFFORT: "best_effort",
} as const;

export type DeliveryImportance = (typeof DELIVERY_IMPORTANCE)[keyof typeof DELIVERY_IMPORTANCE];

/** What a delivery says about itself: the fields the tier is read from. */
export type DeliveryImportanceFacts = Readonly<{
  /** The conversation it arrived on: a direct message's target names the Agent (`@handle`). */
  target?: string;
  /** This delivery personally @mentioned the Agent. */
  mentionsAgent?: boolean;
  /** The Agent was mentioned without being a member of that channel. */
  nonMemberMention?: boolean;
  /** Present when the delivery starts an isolated Task execution session. */
  taskExecutionSessionId?: string;
  /** Why it reached the Agent; the card events (`choice`, `expired`) answer a card it authored. */
  reason?: string;
}>;

/** Which tier this delivery belongs to, in one place. */
export function deliveryImportance(facts: DeliveryImportanceFacts): DeliveryImportance {
  // A card's answer is about a message the Agent wrote and has to act on: the read state that
  // covers the card cannot cover the event.
  if (isCardEvent(facts)) return DELIVERY_IMPORTANCE.RELIABLE;
  // Being named is the Agent's own business, and a mention of a non-member is the only notice that
  // channel sends it at all.
  if (facts.mentionsAgent === true || facts.nonMemberMention === true)
    return DELIVERY_IMPORTANCE.RELIABLE;
  if (facts.taskExecutionSessionId !== undefined) return DELIVERY_IMPORTANCE.RELIABLE;
  // A direct message's target is the Agent itself; a channel's always starts with `#`.
  if (facts.target?.startsWith("@") === true) return DELIVERY_IMPORTANCE.RELIABLE;
  return DELIVERY_IMPORTANCE.BEST_EFFORT;
}
