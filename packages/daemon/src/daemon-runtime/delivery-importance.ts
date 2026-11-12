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
  /** The server's verdict that this delivery belongs to a Task's discussion: an "assigned you
   * task #N" notice, or a reply in a task the Agent is on. It comes from the Task and its
   * conversation, so a channel thread whose id happens to be digits is not one, and no notice's
   * words are read to decide (raft, #coforge-backend:#14 seq 41). Absent from a server that
   * predates the field, and then the delivery is judged like any other. */
  taskDiscussion?: boolean;
  /** The message's own machine-readable notice kind (`system.kind`), absent on ordinary messages.
   * See `RELIABLE_NOTICE_KINDS` for the ones that need the Agent. */
  noticeKind?: string;
}>;

/** The system notice kinds that need the Agent itself, so the notice is told again until it is
 * read. The rest are the platform narrating what it did: `task.claimed`, `channel.member_joined`
 * and the like, which one notice covers. */
const RELIABLE_NOTICE_KINDS: readonly string[] = ["task.assigned_you"];

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
  if (facts.noticeKind !== undefined && RELIABLE_NOTICE_KINDS.includes(facts.noticeKind))
    return DELIVERY_IMPORTANCE.RELIABLE;
  if (facts.taskExecutionSessionId !== undefined) return DELIVERY_IMPORTANCE.RELIABLE;
  // A direct message's target is the Agent itself; a channel's always starts with `#`.
  if (facts.target?.startsWith("@") === true) return DELIVERY_IMPORTANCE.RELIABLE;
  // An App Inbox `system.reminder` is reliable as well, and does not reach this function yet: it is
  // a reminder that came due, which the Agent has to act on. The App Inbox step passes it here, and
  // nothing may classify it as maintenance before then (raft, #coforge-backend:#14 seq 34).
  return DELIVERY_IMPORTANCE.BEST_EFFORT;
}
