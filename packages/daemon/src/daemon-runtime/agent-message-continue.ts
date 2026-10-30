import {
  type AgentMessageResponse,
  type LocalAgentMessageRequest,
} from "@lrm/coforge-sdk/internal";
import type { AgentMessageOperationsPorts } from "./agent-message-ports";
import { AGENT_MESSAGE_BODY_REQUIRED_MESSAGE, agentMessageBody } from "./agent-message-body";
import { AgentPreflightError } from "./agent-preflight-error";
import { AGENT_CONTINUATION_TTL_MS } from "#src/persistence/agent-continuation-store";
import type { AgentContinuation } from "#src/persistence/agent-continuation-store";
import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import type { AgentMessageContinuationOffer } from "@lrm/coforge-sdk/internal";

/**
 * Answers a held send's continuation: `a` resends the held draft unchanged, `b` resends under
 * the draft's key with a replacement body, `c` discards the draft without sending, `d` resends
 * the draft forcing past the freshness warning. One answer wins — a second reports what was
 * already recorded instead of running again.
 */
export async function continueHeldSend(
  ports: AgentMessageOperationsPorts,
  agentId: string,
  request: LocalAgentMessageRequest,
  send: (request: LocalAgentMessageRequest, target: string) => Promise<AgentMessageResponse>,
  prepareDraft: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<AgentMessageResponse> {
  const continuationId = request.continuationId ?? "";
  const choice = request.continuationChoice;
  if (!choice)
    throw new AgentPreflightError(
      "A continuation answer needs a choice: a, b, c or d.",
      "CONTINUATION_CHOICE_REQUIRED",
    );
  const inbox = ports.inbox(agentId);
  const lookup = await prepareDraft(() => inbox.continuation(continuationId, Date.now()));
  if (lookup.status === "missing")
    throw new AgentPreflightError(
      `No open continuation found for id ${continuationId}. It may have been superseded by a newer held send or already cleaned up.`,
      "CONTINUATION_UNKNOWN",
    );
  if (lookup.status === "expired")
    throw new AgentPreflightError(
      `Continuation ${continuationId} expired; the held draft's answer window has closed.`,
      "CONTINUATION_EXPIRED",
    );
  if (lookup.status === "answered")
    throw new AgentPreflightError(
      `Continuation ${continuationId} was already answered with choice "${lookup.answer.choice}".`,
      "CONTINUATION_ALREADY_ANSWERED",
    );
  const continuation = lookup.continuation;
  if (choice === "d" && !continuation.anywayOffered)
    throw new AgentPreflightError(
      `Choice "d" was not offered for continuation ${continuationId}; it is offered only after the same draft was held more than once.`,
      "CONTINUATION_CHOICE_NOT_OFFERED",
    );
  if (choice === "b" && agentMessageBody(request.content, request.message) === undefined)
    throw new AgentPreflightError(
      AGENT_MESSAGE_BODY_REQUIRED_MESSAGE,
      "AGENT_MESSAGE_BODY_REQUIRED",
    );
  const marked = await prepareDraft(() =>
    inbox.answerContinuation(continuationId, {
      choice,
      withInput: choice === "b",
      answeredAt: Date.now(),
    }),
  );
  if (!marked)
    throw new AgentPreflightError(
      `Continuation ${continuationId} was already answered.`,
      "CONTINUATION_ALREADY_ANSWERED",
    );
  const target = continuation.target;
  if (choice === "c") {
    // Discard: the draft leaves with the question, and nothing is sent.
    await prepareDraft(() => inbox.clear(target));
    return {
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messages: [],
      messageId: "",
      summaries: [],
      clearedDraft: true,
      continuationTarget: target,
    };
  }
  if (choice === "b") {
    // The replacement body goes out under the held draft's own idempotency key. If that key was
    // already committed, the server replays the ORIGINAL message and reports it
    // (`already_committed`): the Agent must be told the original was sent and this new content
    // was not — never a success of the rewrite.
    const sent = await send(
      {
        ...request,
        operation: "send",
        target,
        content: agentMessageBody(request.content, request.message),
        message: undefined,
        idempotencyKey: continuation.draft.idempotencyKey,
        sendDraft: undefined,
        attachmentIds: continuation.draft.attachmentIds
          ? [...continuation.draft.attachmentIds]
          : undefined,
        mentions: continuation.draft.mentions ? [...continuation.draft.mentions] : undefined,
        targetConfirmed: true,
      },
      target,
    );
    return { ...sent, continuationTarget: target };
  }
  // `a` and `d` resend the held draft itself; the expected key keeps a draft another send
  // replaced from going out under this answer.
  const sent = await send(
    {
      ...request,
      operation: "send",
      target,
      content: undefined,
      message: undefined,
      sendDraft: true,
      expectedDraftKey: continuation.draft.idempotencyKey,
      continueAnyway: choice === "d" || undefined,
    },
    target,
  );
  return { ...sent, continuationTarget: target };
}

/** A held send's fresh continuation, stored beside its draft: the id and choices the Agent's
 * notice carries, plus the self-contained record `message continue` resolves later. Choice `d` is
 * offered only when the server's `continueAnywaySuggested` says the same draft was held before. */
export async function heldSendContinuation(
  inbox: AgentInboxStateMachine,
  target: string,
  heldDraft: AgentContinuation["draft"],
  anywayOffered: boolean,
): Promise<AgentMessageContinuationOffer> {
  const continuation = {
    id: crypto.randomUUID(),
    target,
    choices: (anywayOffered ? ["a", "b", "c", "d"] : ["a", "b", "c"]) as ("a" | "b" | "c" | "d")[],
  };
  const now = Date.now();
  await inbox.saveContinuation(
    {
      id: continuation.id,
      target,
      draft: heldDraft,
      anywayOffered,
      createdAt: now,
      expiresAt: now + AGENT_CONTINUATION_TTL_MS,
    },
    now,
  );
  return continuation;
}
