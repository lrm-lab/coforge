import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import type { AgentMessageOperationsPorts } from "./agent-message-ports";
import { agentSendResponse } from "./agent-send-result";
import { getLogger } from "@logtape/logtape";
import {
  freshnessDecisionFactId,
  HELD_CONTEXT_LIMIT,
  mentionsInContent,
  threadParentTarget,
  type AgentMessageRecord,
  type AgentMessageResponse,
  type LocalAgentMessageRequest,
} from "@lrm/coforge-sdk/internal";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import {
  locallyHeldSend,
  planAgentInboxFreshness,
  sendSeenExactSeqs,
} from "./agent-inbox-freshness";
import {
  heldFreshnessActivity,
  heldFreshnessDecision,
  heldFreshnessMessageCount,
} from "./agent-inbox-freshness-activity";
import { AGENT_MESSAGE_BODY_REQUIRED_MESSAGE, agentMessageBody } from "./agent-message-body";
import { AgentPreflightError, expiredDraftError } from "./agent-preflight-error";
import { settleAgentSend } from "./agent-send-settlement";
import { settleHistoryRead } from "./agent-history-read";
import { searchPage, searchFields } from "./search-page";
import {
  fenceChannelTranscriptForMemory,
  refuseUnreadMemoryParentRead,
  targetConfirmationRequiredMessage,
} from "./memory-channel-transcript";

const logger = getLogger(["coforge", "daemon", "agent-message"]);

/** Bounds how many events pages one `check` drains before reporting `hasMore: true` and yielding. */
const MAX_EVENT_DRAIN_ROUNDS = 50;

/**
 * An Agent's `coforge message` operations over the Agent HTTPS RPC: `check` drains pending
 * events, `send` goes through the local draft, freshness hold, and send settlement, and every
 * other operation is forwarded, with a `read` settling attention. Each one records what it showed
 * the Agent in the attention index.
 */
export class AgentMessageOperations {
  readonly #ports: AgentMessageOperationsPorts;

  constructor(ports: AgentMessageOperationsPorts) {
    this.#ports = ports;
  }

  /** `target` is the request's target, already canonical. */
  handle(
    agentId: string,
    request: LocalAgentMessageRequest,
    target: string | undefined,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const { operation } = request;
    if (operation === "check") return this.#check(agentId, request, agentApiKey, target);
    if (operation === "send" && target) return this.#send(agentId, request, target, agentApiKey);
    return this.#forward(agentId, request, operation, target, agentApiKey);
  }

  /**
   * Drains the server-side events page for the Agent until it reports no more remain. The server
   * owns pagination and advances the canonical read boundary as it returns each page
   * (ack-on-drain); this loop only reconciles the daemon's volatile notice index afterward.
   */
  async #check(
    agentId: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
    target = request.target,
  ): Promise<AgentMessageResponse> {
    const startedAt = performance.now();
    const attention = this.#ports.attention
      .check(agentId)
      .filter((item) => !target || item.target === target);
    const messages: AgentMessageRecord[] = [];
    let hasMore = false;
    let roundCount = 0;
    while (roundCount < MAX_EVENT_DRAIN_ROUNDS) {
      roundCount += 1;
      const result = await this.#ports.transport.agentMessage!(
        {
          idempotencyKey: request.idempotencyKey,
          agentId,
          workspaceId: this.#ports.connection.workspaceId,
          operation: "check",
          target: target || "",
          limit: request.limit,
        },
        agentApiKey,
      );
      if (!result.accepted || result.messages.length === 0) {
        hasMore = false;
        break;
      }
      messages.push(...result.messages);
      hasMore = Boolean(result.hasMore);
      if (!hasMore) break;
    }
    // A `check` records the exact sequences it showed, per target, and no frontier: a check
    // drains what notified the Agent, which need not be every message of the target. It reviews
    // nothing either, so it takes no read order.
    const shownByTarget = new Map<string, number[]>();
    for (const message of messages) {
      const shown = shownByTarget.get(message.target);
      if (shown) shown.push(message.sequence);
      else shownByTarget.set(message.target, [message.sequence]);
    }
    this.#ports.attention.recordExactSeen(agentId, shownByTarget);
    logger.info("Agent checked pending messages", {
      event: "agent.message.checked",
      ...this.#logScope(agentId, request.idempotencyKey),
      pending_count: attention.reduce((count, item) => count + item.pendingCount, 0),
      displayed_count: messages.length,
      round_count: roundCount,
      has_more: hasMore,
      duration_ms: Math.round(performance.now() - startedAt),
      outcome: "ok",
    });
    return {
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: attention.reduce((n, a) => n + a.pendingCount, 0),
      summaries: attention.map((item) => ({ ...item, flags: [...item.flags] })),
      messages,
      messageId: "",
      hasMore,
      // The App Inbox is read only to say so when a check found no message.
      appItemsPending:
        messages.length === 0 ? await this.#ports.appItemsPending?.(agentId) : undefined,
    };
  }

  /**
   * The saved draft `--send-draft` re-sends, checked before anything is issued: an expired draft
   * is discarded and returned as the error's last copy, a missing one is refused, and
   * `--expected-draft-key` refuses a draft that now belongs to a different logical send.
   */
  async #draftToResend(
    agentId: string,
    inbox: AgentInboxStateMachine,
    target: string,
    request: LocalAgentMessageRequest,
  ) {
    const lookup = await this.#prepareDraft(agentId, () => inbox.lookup(target));
    if (lookup.status === "expired")
      throw expiredDraftError(target, lookup.content, lookup.savedAt);
    if (lookup.status === "missing")
      throw new AgentPreflightError(`No saved draft for target: ${target}`, "SEND_DRAFT_NOT_FOUND");
    const draft = lookup.draft;
    if (request.expectedDraftKey !== undefined && draft.idempotencyKey !== request.expectedDraftKey)
      throw new AgentPreflightError(
        "The saved draft no longer matches the expected idempotency key. No request was made and the current draft was left unchanged because it belongs to a different logical send.",
        "SAVED_DRAFT_IDENTITY_CHANGED",
        {
          draftSaved: false,
          retryable: false,
          suggestedNextAction:
            "Review the current draft before deciding whether to send it; do not treat it as the earlier logical send.",
        },
      );
    return draft;
  }

  /** Draft storage before this invocation issues a send. Never use for a held refresh or cleanup
   * after transport: those failures cannot establish that nothing was sent. */
  async #prepareDraft<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      logger.warn("Agent send could not prepare its local draft", {
        event: "agent.message.draft_prepare_failed",
        agent_id: agentId,
        error_code: diagnosticErrorCode(error),
      });
      throw new AgentPreflightError(
        "Local message draft storage is unavailable. This command made no send request.",
        "SEND_DRAFT_STORAGE_FAILED",
        {
          draftSaved: false,
          retryable: false,
          suggestedNextAction:
            "Repair local draft storage (disk space, permissions, or corrupt data). This error does not " +
            "settle any earlier send; do not resend an earlier UNKNOWN message on this evidence.",
        },
      );
    }
  }

  /** Sends a body or a held draft, honouring the server's freshness hold decision. */
  async #send(
    agentId: string,
    request: LocalAgentMessageRequest,
    target: string,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const startedAt = performance.now();
    const inbox = this.#ports.inbox(agentId);
    // The daemon owns the per-target draft, and the draft names its own send by key: every local
    // request carries a key the CLI minted for that invocation, so the draft's key alone decides
    // which accepted send may clear it (`clearIfIdempotencyKeyMatches` below, task #70).
    const draft = request.sendDraft
      ? await this.#draftToResend(agentId, inbox, target, request)
      : undefined;
    // One logical send keeps one idempotency key. A fresh send's key is this invocation's;
    // `--send-draft` re-sends under the key the draft was saved with, so a resend after an
    // unknown outcome can never commit the same message twice.
    const idempotencyKey = draft?.idempotencyKey ?? request.idempotencyKey;
    // A normal send replaces whatever draft was there; the send reports that (and the hold count
    // the draft had reached) so the server can compute `continueAnywaySuggested`.
    const priorDraft =
      draft ??
      (request.sendDraft
        ? undefined
        : await this.#prepareDraft(agentId, () => inbox.draft(target)));
    const draftReholdCount = priorDraft?.reholdCount ?? 0;
    const content = draft?.content ?? agentMessageBody(request.content, request.message);
    if (content === undefined)
      throw new AgentPreflightError(
        AGENT_MESSAGE_BODY_REQUIRED_MESSAGE,
        "AGENT_MESSAGE_BODY_REQUIRED",
      );
    // The boundary a draft already accounted for travels with the next attempt — a
    // `--send-draft` resend reuses the draft's `seenUpToSeq`, a fresh send inherits the draft it is
    // replacing, and only when neither has one does the daemon fall back to what this Agent has
    // consumed for the target.
    const draftSeenUpToSeq = request.sendDraft ? draft?.seenUpToSeq : priorDraft?.seenUpToSeq;
    const modelSeenSequence = this.#ports.attention.modelSeenSequence(agentId, target);
    const seenUpToSeq = draftSeenUpToSeq ?? (modelSeenSequence > 0 ? modelSeenSequence : undefined);
    // The messages above that frontier the Agent was shown one by one travel with it, so the
    // server's freshness check does not count them as unreviewed.
    const seenExactSeqs = sendSeenExactSeqs(
      request.sendDraft ? draft?.seenExactSeqs : priorDraft?.seenExactSeqs,
      this.#ports.attention.seenExactSequences(agentId, target),
      seenUpToSeq,
    );
    // `--send-draft` re-sends the saved draft's attachments/mentions unless the Agent explicitly
    // supplies new `--mention` values, which replace them (Feature 2's documented override).
    const attachmentIds = request.sendDraft ? draft?.attachmentIds : request.attachmentIds;
    const mentions = request.sendDraft
      ? request.mentions?.length
        ? request.mentions
        : draft?.mentions
      : request.mentions;
    // The presence check runs against the EFFECTIVE outgoing content on every path, including a
    // `--send-draft` resend of the daemon-held body (the CLI can only run this check client-side
    // when it has the body in hand, i.e. never for an unmodified draft resend).
    if (mentions?.length) {
      const present = mentionsInContent(content);
      for (const mention of mentions)
        if (!present.has(mention.name))
          throw new AgentPreflightError(
            `Structured mention @${mention.name} is not present in the message body.`,
            "MENTION_NOT_IN_CONTENT",
          );
    }
    // Narrow local guard, decided entirely from volatile read-context state, before any transport
    // call is made: a top-level send whose parent was read less recently than a thread rooted
    // under it is an easy typo (replying to the channel instead of the thread), and moving a
    // thread conclusion to the parent channel is uncommon enough to confirm once. `--send-draft`
    // itself skips this guard (it can only re-target what was already confirmed once, at worst).
    if (
      !request.sendDraft &&
      !request.targetConfirmed &&
      threadParentTarget(target) === undefined
    ) {
      const latestThread = this.#ports.attention.latestThreadReadUnderParent(agentId, target);
      if (latestThread) {
        const parentOrder = this.#ports.attention.readOrder(agentId, target);
        if (parentOrder === undefined || parentOrder < latestThread.order) {
          // The outgoing content is saved as the local draft before refusing, so the documented
          // recovery is resending that exact draft, not retyping it.
          await this.#prepareDraft(agentId, () =>
            inbox.save(target, {
              content,
              attachmentIds,
              mentions,
              seenUpToSeq,
              idempotencyKey,
            }),
          );
          throw new AgentPreflightError(
            targetConfirmationRequiredMessage(target, latestThread.target),
            "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
            { draftSaved: true },
          );
        }
      }
    }
    // Persist the draft before transport; a failed save is a local precondition. Keep that
    // classification separate from failures after transport, whose delivery may be unknown.
    if (!request.sendDraft)
      await this.#prepareDraft(agentId, () =>
        inbox.save(target, { content, attachmentIds, mentions, seenUpToSeq, idempotencyKey }),
      );
    // The daemon's own freshness decision, taken BEFORE any transport call: a send it holds must
    // never be issued, because a re-issue of the same request would re-decide it (observed: the
    // same idempotencyKey held at 00:18:30 and forwarded at 00:19:30 delivered a message the Agent had
    // been told was held, and the deliberate `--send-draft` resend then duplicated it). A hold
    // decided here is terminal; the server still gets the request when the daemon forwards, so its
    // own check remains the race guard for anything that arrived in between.
    const freshness = planAgentInboxFreshness({
      continueAnyway: Boolean(request.continueAnyway),
      modelSeenSequence,
      pendingMessageCount: this.#ports.attention.pendingMessageCount(agentId, target),
      pendingMaxSequence: this.#ports.attention.pendingMaxSequence(agentId, target),
    });
    const result =
      freshness.decision === "local_hold"
        ? locallyHeldSend(
            freshness,
            {
              idempotencyKey,
              draftReholdCount,
              freshnessContextMode: request.freshnessContextMode,
            },
            // A held notice shows the newest unreviewed messages. The daemon now has them (its
            // attention index keeps a bounded window of unreviewed deliveries), so a locally decided
            // hold carries real previews instead of a bare count — and the shared post-processing
            // below then marks that window reviewed (`recordModelSeen`): the Agent has been shown
            // the newest context, so a resend is no longer held by it.
            this.#ports.attention
              .pendingWindow(agentId, target, HELD_CONTEXT_LIMIT)
              .map(({ delivery, receivedAt }) => ({
                id: delivery.messageId,
                sequence: delivery.sequence,
                senderKind: delivery.latestSenderKind ?? "system",
                senderHandle: delivery.latestSenderHandle ?? "",
                senderDescription: delivery.latestSenderDescription ?? "",
                target,
                body: delivery.body,
                // Deliveries carry no message timestamp (only the server knows when a message was
                // written), so a local preview shows when this daemon received it.
                createdAt: new Date(receivedAt).toISOString(),
                attachments: [],
              })),
          )
        : await settleAgentSend(
            {
              idempotencyKey,
              agentId,
              workspaceId: this.#ports.connection.workspaceId,
              operation: "send",
              target,
              content,
              continueAnyway: request.continueAnyway,
              draftReholdCount,
              draftReplacedExisting: !request.sendDraft && draftReholdCount > 0,
              sendDraft: request.sendDraft,
              seenUpToSeq,
              seenExactSeqs,
              freshnessContextMode: request.freshnessContextMode,
              attachmentIds: attachmentIds ? [...attachmentIds] : undefined,
              mentions: mentions ? [...mentions] : undefined,
            },
            {
              send: (send) => this.#ports.transport.agentMessage!(send, agentApiKey),
              reconcile: (reconciliation) => {
                if (!this.#ports.transport.reconcileAgentSend)
                  throw new Error("daemon connection cannot reconcile a send");
                return this.#ports.transport.reconcileAgentSend(reconciliation, agentApiKey);
              },
              draftHoldsKey: async (draftTarget, key) =>
                (await inbox.draft(draftTarget))?.idempotencyKey === key,
            },
            {
              reviewerIsolation: request.freshnessContextMode === "withheld",
              logScope: this.#logScope(agentId, idempotencyKey),
            },
          );
    const held = result.state === "held";
    // A withheld context was never presented to the Agent, so nothing about it may be recorded
    // (or kept in the draft) as reviewed.
    const contextWasWithheld =
      request.freshnessContextMode === "withheld" || result.freshnessContextMode === "withheld";
    if (held) {
      await inbox.replace(target, {
        content,
        attachmentIds,
        mentions,
        // The held refresh: the same content, one hold later, remembering the frontier the notice
        // presented so the resend clears the hold.
        reholdCount: draftReholdCount + 1,
        seenUpToSeq: contextWasWithheld ? seenUpToSeq : (result.seenUpToSeq ?? seenUpToSeq),
        // A presented hold's frontier covers what the draft saw one by one; a withheld one
        // presented nothing, so the draft keeps them.
        seenExactSeqs: contextWasWithheld ? seenExactSeqs : undefined,
        idempotencyKey,
      });
    } else if (result.accepted) {
      // Only the send whose key the draft holds consumes it, so an older send accepted late
      // leaves a newer draft alone (task #70).
      await inbox.clearIfIdempotencyKeyMatches(target, idempotencyKey);
    }
    // The consume effects, one write for the send. A presented hold consumed the frontier its
    // notice presented (or the shown window's newest for a hold that carries no frontier) and
    // reviewed the target; a withheld one presented nothing.
    // A sent send whose server advanced the boundary over messages the Agent had already seen
    // (`exact_target_pending_already_seen`, `target_first_touch_recent_context_already_seen`)
    // consumes that boundary in either mode, which is what empties the exact set.
    let presented = 0;
    if (held && !contextWasWithheld) {
      presented = result.seenUpToSeq ?? 0;
      for (const message of result.messages)
        if (message.target === target && message.sequence > presented) presented = message.sequence;
    }
    const recentUnread = contextWasWithheld
      ? []
      : (result.recentUnread ?? []).filter((message) => message.target === target);
    let through = presented;
    if (!held && result.accepted) through = Math.max(through, result.seenUpToSeq ?? 0);
    for (const message of recentUnread) through = Math.max(through, message.sequence);
    this.#ports.attention.recordSendContext(
      agentId,
      target,
      through,
      presented > 0 ? { sequence: presented } : undefined,
    );
    // The freshness-decision activity: one working status row per held send, titled `Send held by
    // freshness check`, carrying the target, the count line and the decision line(s) as its text.
    // A held context in `withheld` mode was never presented, so no activity is reported for it.
    if (held && !contextWasWithheld) {
      const heldDecision = heldFreshnessDecision(result.decision);
      if (heldDecision) {
        const producerFactId =
          result.producerFactId ??
          (await freshnessDecisionFactId({
            agentId,
            action: "send",
            decision: heldDecision,
            target,
            reason: result.reason ?? "",
            pendingMaxSeq: result.seenUpToSeq,
            modelSeenSeq: modelSeenSequence,
            heldMessageCount: result.shownMessageCount ?? result.messages.length,
            omittedMessageCount: result.omittedMessageCount,
          }));
        // One record per decision, so a locally decided hold is auditable next to a
        // server-decided one.
        logger.info("Agent inbox freshness decision", {
          event: "agent.inbox.freshness_decision",
          ...this.#logScope(agentId, idempotencyKey),
          producer_fact_id: producerFactId,
          action: "send",
          decision: heldDecision,
          target,
          reason: result.reason,
          pending_count: result.newMessageCount,
          pending_max_seq: result.seenUpToSeq,
          model_seen_seq: modelSeenSequence || undefined,
          held_message_count: result.shownMessageCount ?? result.messages.length,
          omitted_message_count: result.omittedMessageCount,
        });
        const activity = heldFreshnessActivity({
          action: "send",
          decision: heldDecision,
          target,
          messageCount: heldFreshnessMessageCount({
            decision: heldDecision,
            newMessageCount: result.newMessageCount,
            shownMessageCount: result.shownMessageCount,
          }),
          producerFactId,
        });
        this.#ports.reportFreshnessHold(agentId, activity);
      }
    }
    logger.info("Agent sent a message", {
      event: "agent.message.sent",
      ...this.#logScope(agentId, idempotencyKey),
      // A commit confirmed by reconciliation carries no freshness decision of its own, so it logs
      // none and says `reconciled` instead.
      ...(result.state === "committed"
        ? { reconciled: true }
        : { freshness_decision: result.decision ?? "forward" }),
      accepted: result.accepted,
      message_id: result.messageId,
      duration_ms: Math.round(performance.now() - startedAt),
      outcome: result.accepted ? "ok" : "rejected",
    });
    return agentSendResponse({ idempotencyKey, result, contextWasWithheld, recentUnread });
  }

  /** Forwards read/search/mute/unmute/unfollow unchanged; an unpaged read settles attention. */
  async #forward(
    agentId: string,
    request: LocalAgentMessageRequest,
    operation: Exclude<LocalAgentMessageRequest["operation"], "check">,
    target: string | undefined,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    // Only an `unread` read looks at what is unread now and, when it finds nothing, settles the
    // attention the daemon held for the target up to this point; any other read without an anchor
    // shows the newest page. A Memory Agent's `message_read` has no `unread` argument, and its
    // increment read of a channel is the unread read.
    const unpaged = operation === "read" && !request.before && !request.after && !request.around;
    const isMemory = this.#ports.isMemoryAgent?.(agentId);
    const read = unpaged && isMemory && !request.unread ? { ...request, unread: true } : request;
    if (unpaged && target?.startsWith("#") && !target.includes(":") && isMemory)
      refuseUnreadMemoryParentRead(target, this.#ports.attention.check(agentId));
    const attentionUpperBound =
      unpaged && read.unread && target
        ? this.#ports.attention.check(agentId).find((item) => item.target === target)
            ?.latestSequence
        : undefined;
    const result = await this.#ports.transport.agentMessage!(
      {
        idempotencyKey: request.idempotencyKey,
        agentId,
        workspaceId: this.#ports.connection.workspaceId,
        operation,
        target: target ?? "",
        content: request.content,
        before: request.before,
        after: request.after,
        around: request.around,
        limit: request.limit,
        unread: read.unread,
        ...searchFields(request),
        messageId: request.messageId,
        emoji: request.emoji,
      },
      agentApiKey,
    );
    const { messages: unfolded, folded } =
      operation === "read" && target && result.accepted
        ? settleHistoryRead(this.#ports.attention, agentId, target, {
            request: read,
            result,
            unpaged,
            attentionUpperBound,
          })
        : { messages: result.messages, folded: undefined };
    const messages =
      this.#ports.isMemoryAgent?.(agentId) && unfolded.length
        ? fenceChannelTranscriptForMemory(unfolded)
        : unfolded;
    return {
      idempotencyKey: request.idempotencyKey,
      accepted: result.accepted,
      attentionCount: result.attentionCount,
      messageId: result.messageId ?? "",
      messages,
      summaries: [],
      hasOlder: result.hasOlder,
      hasNewer: result.hasNewer,
      olderCursor: result.olderCursor,
      newerCursor: result.newerCursor,
      ...searchPage(result),
      unreadCursorBefore: result.unreadCursorBefore,
      readPositionAfter: result.readPositionAfter,
      moreUnread: result.moreUnread,
      foldedMessageCount: folded?.count,
      foldedFromSequence: folded?.fromSequence,
      foldedThroughSequence: folded?.throughSequence,
    };
  }

  /** The log's correlation field is `request_id`; on the Agent HTTP path it carries the request's
   * idempotency key. */
  #logScope(agentId: string, idempotencyKey: string) {
    return {
      request_id: idempotencyKey,
      workspace_id: this.#ports.connection.workspaceId,
      computer_id: this.#ports.connection.computerId,
      agent_id: agentId,
    };
  }
}
