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
  /** The delivery comes from a Task's discussion: an "assigned you task #N" notice, or a reply in
   * a task the Agent is on. The envelope cannot say so today — a task's target (`#board:#N`,
   * `@peer:#N`) differs from a channel thread's (`#board:<id>`) only in shape, and reading that
   * shape would mistake an all-digit thread id for a task — so the wiring supplies this from a
   * task ref the server sends, never from the words of a notice (raft, #coforge-backend:#14
   * seq 34: do not guess by matching text). */
  taskDiscussion?: boolean;
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
  // Assigned work is a direct instruction, and a task's discussion is where the Agent acts on it.
  if (facts.taskDiscussion === true) return DELIVERY_IMPORTANCE.RELIABLE;
  if (facts.taskExecutionSessionId !== undefined) return DELIVERY_IMPORTANCE.RELIABLE;
  // A direct message's target is the Agent itself; a channel's always starts with `#`.
  if (facts.target?.startsWith("@") === true) return DELIVERY_IMPORTANCE.RELIABLE;
  // An App Inbox `system.reminder` is reliable as well, and does not reach this function yet: it is
  // a reminder that came due, which the Agent has to act on. The App Inbox step passes it here, and
  // nothing may classify it as maintenance before then (raft, #coforge-backend:#14 seq 34).
  return DELIVERY_IMPORTANCE.BEST_EFFORT;
}
