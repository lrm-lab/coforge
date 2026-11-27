import { agentConsumptionScopeSchema } from "@lrm/coforge-sdk/internal/agent-consumption";
import type { AgentMessageDraftContent } from "#src/persistence/agent-message-draft-store";
import { targetConfirmationRequiredMessage } from "./target-confirmation-message";
import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import type { AgentMessageOperationsPorts } from "./agent-message-ports";
import { agentSendResponse } from "./agent-send-result";
import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorCode,
  mentionsInContent,
  threadParentTarget,
  type AgentMessageContinuationOffer,
  type AgentMessageResponse,
  type LocalAgentMessageRequest,
} from "@lrm/coforge-sdk/internal";
import {
  locallyHeldSend,
  planAgentInboxFreshness,
  pendingMessageRecords,
  sendSeenExactSeqs,
} from "./agent-inbox-freshness";
import { reportHeldSendFreshnessDecision } from "./agent-inbox-freshness-activity";
import { AGENT_MESSAGE_BODY_REQUIRED_MESSAGE, agentMessageBody } from "./agent-message-body";
import { AgentPreflightError, expiredDraftError } from "./agent-preflight-error";
import { continueHeldSend, heldSendContinuation } from "./agent-message-continue";
import { elideForAgent } from "./context-elision";
import { agentLogScope, checkPendingMessages } from "./agent-message-check";
import { settleAgentSend } from "./agent-send-settlement";
import { displayConsumptionRoot, matchesConsumptionScope } from "./message-consumption-key";
import { settleHistoryRead } from "./agent-history-read";
import { searchPage, searchFields } from "./search-page";
const logger = getLogger(["coforge", "daemon", "agent-message"]);
export class AgentMessageOperations {
  readonly #ports: AgentMessageOperationsPorts;
  constructor(ports: AgentMessageOperationsPorts) {
    this.#ports = ports;
  }
  handle(
    agentId: string,
    request: LocalAgentMessageRequest,
    target: string | undefined,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const { operation } = request;
    if (operation === "check")
      return checkPendingMessages(this.#ports, agentId, request, agentApiKey, target);
    if (operation === "send" && target) return this.#send(agentId, request, target, agentApiKey);
    if (operation === "continue") return this.#continue(agentId, request, agentApiKey);
    return this.#forward(agentId, request, operation, target, agentApiKey);
  }
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
  async #send(
    agentId: string,
    request: LocalAgentMessageRequest,
    target: string,
    agentApiKey: string,
    continuationDraft?: AgentMessageDraftContent,
  ): Promise<AgentMessageResponse> {
    const startedAt = performance.now();
    const inbox = this.#ports.inbox(agentId);
    const draft = request.sendDraft
      ? await this.#draftToResend(agentId, inbox, target, request)
      : undefined;
    const idempotencyKey = draft?.idempotencyKey ?? request.idempotencyKey;
    const priorDraft =
      draft ??
      (request.sendDraft
        ? undefined
        : await this.#prepareDraft(agentId, () => inbox.draft(target)));
    const originalDraft =
      continuationDraft ??
      draft ??
      (priorDraft?.idempotencyKey === idempotencyKey ? priorDraft : undefined);
    const originalScope = agentConsumptionScopeSchema.safeParse(
      originalDraft?.consumptionScope,
    ).data;
    const writeContext =
      originalDraft && !originalScope
        ? undefined
        : this.#ports.attention.writeContext(agentId, target, originalScope);
    const draftScope = writeContext?.scope;
    const draftReholdCount = priorDraft?.reholdCount ?? 0;
    const content = draft?.content ?? agentMessageBody(request.content, request.message);
    if (content === undefined)
      throw new AgentPreflightError(
        AGENT_MESSAGE_BODY_REQUIRED_MESSAGE,
        "AGENT_MESSAGE_BODY_REQUIRED",
      );
    const modelSeenSequence = this.#ports.attention.modelSeenSequence(agentId, target);
    const originalEvidence = originalDraft ? writeContext?.evidence?.[0]?.entry : undefined;
    const seenUpToSeq = originalDraft ? originalEvidence?.seq : modelSeenSequence || undefined;
    const seenExactSeqs = sendSeenExactSeqs(
      undefined,
      originalDraft
        ? (originalEvidence?.exactSeqs ?? [])
        : this.#ports.attention.seenExactSequences(agentId, target),
      seenUpToSeq,
    );
    const attachmentIds = request.sendDraft ? draft?.attachmentIds : request.attachmentIds;
    const mentions = request.sendDraft
      ? request.mentions?.length
        ? request.mentions
        : draft?.mentions
      : request.mentions;
    if (mentions?.length) {
      const present = mentionsInContent(content);
      for (const mention of mentions)
        if (!present.has(mention.name))
          throw new AgentPreflightError(
            `Structured mention @${mention.name} is not present in the message body.`,
            "MENTION_NOT_IN_CONTENT",
          );
    }
    if (
      !request.sendDraft &&
      !request.targetConfirmed &&
      threadParentTarget(target) === undefined
    ) {
      const latestThread = this.#ports.attention.latestThreadReadUnderParent(agentId, target);
      if (latestThread) {
        const parentOrder = this.#ports.attention.readOrder(agentId, target);
        if (parentOrder === undefined || parentOrder < latestThread.order) {
          await this.#prepareDraft(agentId, () =>
            inbox.save(target, {
              content,
              attachmentIds,
              mentions,
              seenUpToSeq,
              consumptionScope: draftScope,
              idempotencyKey,
            }),
          );
          this.#ports.noteCoforgeWriteOrHold?.(agentId);
          throw new AgentPreflightError(
            targetConfirmationRequiredMessage(target, latestThread.target),
            "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
            { draftSaved: true },
          );
        }
      }
    }
    if (!request.sendDraft)
      await this.#prepareDraft(agentId, () =>
        inbox.save(target, {
          content,
          attachmentIds,
          mentions,
          seenUpToSeq,
          consumptionScope: draftScope,
          idempotencyKey,
        }),
      );
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
            pendingMessageRecords(this.#ports.attention, agentId, target),
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
              consumptionEvidence: writeContext?.evidence ?? (originalScope ? [] : undefined),
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
              logScope: agentLogScope(this.#ports, agentId, idempotencyKey),
            },
          );
    const writeScope =
      result.writeConsumptionScope && matchesConsumptionScope(target, result.writeConsumptionScope)
        ? result.writeConsumptionScope
        : undefined;
    const held = result.state === "held";
    if (held || result.accepted) this.#ports.noteCoforgeWriteOrHold?.(agentId);
    const contextWasWithheld =
      request.freshnessContextMode === "withheld" || result.freshnessContextMode === "withheld";
    let continuation: AgentMessageContinuationOffer | undefined;
    if (held) {
      const localConversationId =
        freshness.decision === "local_hold"
          ? this.#ports.attention.pendingConversationId(agentId, target)
          : undefined;
      const localScope = localConversationId
        ? { conversationId: localConversationId, threadRootId: displayConsumptionRoot(target) }
        : undefined;
      const heldDraft = {
        content,
        attachmentIds,
        mentions,
        reholdCount: draftReholdCount + 1,
        consumptionScope: originalDraft ? draftScope : (writeScope ?? draftScope ?? localScope),
        seenUpToSeq,
        seenExactSeqs,
        idempotencyKey,
      };
      await inbox.replace(target, heldDraft);
      continuation = await heldSendContinuation(
        inbox,
        target,
        heldDraft,
        result.continueAnywaySuggested === true,
      );
    } else if (result.accepted) {
      await inbox.clearIfIdempotencyKeyMatches(target, idempotencyKey);
    }
    const recentUnread = contextWasWithheld
      ? []
      : (result.recentUnread ?? []).filter((message) => message.target === target);
    if (held && !contextWasWithheld)
      await reportHeldSendFreshnessDecision({
        agentId,
        target,
        result,
        modelSeenSequence,
        logScope: agentLogScope(this.#ports, agentId, idempotencyKey),
        reportFreshnessHold: (id, activity) => this.#ports.reportFreshnessHold(id, activity),
      });
    logger.info("Agent sent a message", {
      event: "agent.message.sent",
      ...agentLogScope(this.#ports, agentId, idempotencyKey),
      ...(result.state === "committed"
        ? { reconciled: true }
        : { freshness_decision: result.decision ?? "forward" }),
      accepted: result.accepted,
      message_id: result.messageId,
      duration_ms: Math.round(performance.now() - startedAt),
      outcome: result.accepted ? "ok" : "rejected",
    });
    return agentSendResponse({
      idempotencyKey,
      result,
      contextWasWithheld,
      recentUnread,
      continuation,
    });
  }
  async #continue(
    agentId: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    return continueHeldSend(
      this.#ports,
      agentId,
      request,
      (sendRequest, sendTarget, originalDraft) =>
        this.#send(agentId, sendRequest, sendTarget, agentApiKey, originalDraft),
      (operation) => this.#prepareDraft(agentId, operation),
    );
  }
  async #forward(
    agentId: string,
    request: LocalAgentMessageRequest,
    operation: Exclude<LocalAgentMessageRequest["operation"], "check" | "continue">,
    target: string | undefined,
    agentApiKey: string,
  ): Promise<AgentMessageResponse> {
    const unpaged = operation === "read" && !request.before && !request.after && !request.around;
    const read = request;
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
          })
        : { messages: result.messages, folded: undefined };
    const messages = elideForAgent(this.#ports.contexts, agentId, unfolded, operation);
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
}
