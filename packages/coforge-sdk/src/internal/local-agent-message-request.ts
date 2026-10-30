/** The Agent's `coforge message` request as the local daemon sees it: the operation, its fields
 * and the token-bound context. `content` is the outgoing or replacement body; `sendDraft`,
 * `expectedDraftKey`, `continueAnyway` and the continuation pair answer a held send. */
/** A structured @mention binding: a handle claimed to name a specific actor. */
export type LocalMentionSelector = { type: "user" | "agent"; id: string; name: string };

/** What a `message search` request asks for beyond the filters every message request shares. */
export type LocalMessageSearchFields = {
  query?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  /** Skips this many results; pages a `relevance` search. */
  offset?: number;
  /** A previous page's `nextCursor`; continues a `recent` search with a query. */
  cursor?: string;
};
export type LocalAgentMessageRequest = LocalMessageSearchFields & {
  idempotencyKey: string;
  context: string;
  operation:
    | "check"
    | "read"
    | "search"
    | "send"
    | "continue"
    | "mute"
    | "unmute"
    | "thread-unfollow"
    | "resolve"
    | "react"
    | "unreact";
  target?: string;
  content?: string;
  /** Alias of `content`, used only when `content` is absent. Never forwarded upstream. */
  message?: string;
  /** `message continue` only: the held send's continuation id. */
  continuationId?: string;
  /** `message continue` only: which offered choice the Agent picked. `b` carries its replacement
   * body in `content` and resends under the held draft's idempotency key. */
  continuationChoice?: "a" | "b" | "c" | "d";
  sendDraft?: boolean;
  /** `message send --send-draft` only: refuse, before any request, unless the saved draft still
   * belongs to the logical send with this idempotency key. */
  expectedDraftKey?: string;
  continueAnyway?: boolean;
  /** `message send` only (daemon-internal): the boundary the sender has already reviewed. */
  seenUpToSeq?: number;
  /** `message send` only (daemon-internal): how many times this draft has already been held. */
  draftReholdCount?: number;
  /** `message send` only (daemon-internal): a normal send that replaced an already-held draft. */
  draftReplacedExisting?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  unread?: boolean;
  freshnessContextMode?: "inline" | "withheld";
  messageId?: string;
  emoji?: string;
  /** `message send` only: attachments already uploaded to this conversation, in send order.
   * Max 10, unique, each a UUID. */
  attachmentIds?: string[];
  /** `message send` only: structured @mention bindings; replaces the draft's saved mentions on `--send-draft` when non-empty. */
  mentions?: LocalMentionSelector[];
  /** `message send` only: confirms a top-level send despite newer thread read context under the same parent. Never leaves the daemon. */
  targetConfirmed?: boolean;
};
