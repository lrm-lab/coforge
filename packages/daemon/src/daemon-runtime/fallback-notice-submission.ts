import { getLogger } from "@logtape/logtape";
import type { AgentNoticeOptions } from "@coforge/agent";
import type { FallbackNotice } from "./agent-delivery-gate";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export function prepareFallbackNotice(agentId: string, notice: FallbackNotice) {
  const { text, fallbackText, noticeOrigin, deliveryIds, conversation } = notice;
  const attemptId = crypto.randomUUID();
  const identity = {
    agent_id: agentId,
    source: "fallback",
    attempt_id: attemptId,
    previous_attempt_id: noticeOrigin?.attemptId,
    previous_source: noticeOrigin?.source,
    deliveries: noticeOrigin?.deliveries,
    delivery_ids: deliveryIds,
    conversation_id: conversation?.conversationId,
  };
  const prepare = (boundary: "release" | "prompt" | "steer") => {
    const selected = fallbackText ? fallbackText() : text;
    logger.info("Fallback inbox notice submission decided", {
      ...identity,
      event: "agent.inbox_notice.submission_decision",
      boundary,
      outcome: selected === undefined ? "suppress" : "submit",
    });
    return selected;
  };
  const pending = prepare("release");
  if (pending === undefined) return;
  if (!fallbackText && !noticeOrigin)
    return {
      text: pending,
      options:
        deliveryIds?.length || conversation
          ? { deliveryIds: deliveryIds ?? [], ...(conversation ? { conversation } : {}) }
          : undefined,
    };

  const options: AgentNoticeOptions = {
    ...(deliveryIds?.length ? { deliveryIds } : {}),
    ...(conversation ? { conversation } : {}),
    ...(fallbackText ? { fallbackText } : {}),
    noticeOrigin: { source: "fallback", attemptId, deliveries: noticeOrigin?.deliveries ?? [] },
    prepareSubmission: prepare,
    onPromptWritten: () =>
      logger.info("ACP prompt written for fallback inbox notice", {
        ...identity,
        event: "agent.inbox_notice.acp_prompt_written",
      }),
  };
  return { text: pending, options };
}
