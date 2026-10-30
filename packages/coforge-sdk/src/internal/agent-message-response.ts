import type { AgentMessageRecord } from "./agent-message-record";
import type { MessageAttentionSummary } from "./local-attention-summary";

export type AgentPendingMentionAction = {
  resolutionId: string;
  messageId: string;
  targetType: "user" | "agent";
  targetHandle: string;
  targetAvatarUrl: string | null;
  /** Why it was not delivered: the target was not in the conversation at send time. */
  reason: "not_member";
  /** What the sender may still do: `notify` and/or `add`. */
  availableActions: string[];
  /** ISO time after which the action can no longer be taken. */
  expiresAt: string;
};
/** How far a `message search` page got: whether more follows, where it starts, and whether the
 * server stopped early (`searchedMessages`/`searchedThrough` say how far it read). `hasMore` is
 * also set by the `check` events drain. */
export type LocalSearchPaging = {
  hasMore?: boolean;
  nextCursor?: string;
  incomplete?: boolean;
  searchedMessages?: number;
  searchedThrough?: string;
};
/** `message send`/`continue` only, held: the open continuation the Agent answers with
 * `coforge message continue <id> <a|b|c|d>`. `a` resends the held draft unchanged, `b` replaces its
 * body (the answer's `content`), `c` discards the draft without sending, and `d` — offered only
 * when `continueAnywaySuggested` — forces the resend anyway. */
export type AgentMessageContinuationOffer = {
  id: string;
  /** The held send's canonical target, for the Agent's notice. */
  target: string;
  choices: readonly ("a" | "b" | "c" | "d")[];
};

export type AgentMessageResponse = LocalSearchPaging & {
  idempotencyKey: string;
  accepted: boolean;
  attentionCount: number;
  messages: AgentMessageRecord[];
  messageId: string;
  summaries: MessageAttentionSummary[];
  /** `message send`/`continue` only, held: the open continuation awaiting an answer. */
  continuation?: AgentMessageContinuationOffer;
  /** `message send`/`continue` only: the idempotency key was already committed — `messageId` is
   * the ORIGINAL message, and this request's body was not delivered. */
  replayedOriginal?: boolean;
  /** `message continue` choice `c` only: the held draft was discarded without sending. */
  clearedDraft?: boolean;
  /** `message continue` only: the held send's canonical target the answer ran against. */
  continuationTarget?: string;
  /** `message send` only: the send outcome, `"sent"` or `"held"`, or `"committed"` when the
   * daemon confirmed an ambiguous send's commit by its key and has no delivery receipt for it. */
  state?: "sent" | "held" | "committed";
  /** `message send` only: `forward`/`bypass` sent the message, `local_hold`/`syncing_hold` held it. */
  decision?: "forward" | "bypass" | "local_hold" | "syncing_hold";
  reason?: string;
  producerFactId?: string;
  /** `message send` only, held: the recovery actions. */
  availableActions?: string[];
  /** `message send` only, held: an already-re-held draft may be forced with `--send-draft --anyway`. */
  continueAnywaySuggested?: boolean;
  /** `message send` only, held: the held context window, oldest to newest. */
  heldMessages?: AgentMessageRecord[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  hasOlder?: boolean;
  hasNewer?: boolean;
  olderCursor?: string;
  newerCursor?: string;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  unreadCursorBefore?: number;
  readPositionAfter?: number;
  moreUnread?: boolean;
  foldedMessageCount?: number;
  foldedFromSequence?: number;
  foldedThroughSequence?: number;
  appItemsPending?: number;
  /** `message send` only: pending messages a bypassed hold chose not to review; empty otherwise. */
  recentUnread?: AgentMessageRecord[];
  /** `message send` only: mentions of people outside the channel, which notified no one. */
  pendingMentionActions?: AgentPendingMentionAction[];
  /** `message send` only: `@handle`s that name nobody the Agent can see. */
  unresolvedMentionHandles?: string[];
  /** `message send` only: the channel this send joined on the way, as `#name`. */
  joinedChannel?: string;
};
