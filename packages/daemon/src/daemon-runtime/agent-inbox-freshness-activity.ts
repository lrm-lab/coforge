import { getLogger } from "@logtape/logtape";
import type { ActivityTrajectoryEntry } from "@lrm/coforge-sdk/internal";
import { freshnessDecisionFactId } from "@lrm/coforge-sdk/internal";
import type { AgentMessageTransportResponse } from "#src/connection/agent-message-adapters";

const logger = getLogger(["coforge", "daemon", "agent-message"]);

/**
 * The Activity a held freshness decision narrates.
 *
 * One held send narrates exactly two things: a **status entry** —
 * `{kind:"status", activity:"working", activityKind:"working", detail: <title>,
 * detailKind:"freshness_hold", producerFactId}` — and an **action entry** carrying the same
 * title plus a three-line text (`target:`, the count line, the decision line(s)). The Activity
 * frame carries both (a display status with optional trajectory entries), so this projects the
 * pair onto it: `activityKind`/`detail`/`detailKind` are the status entry, `entries` is the action
 * entry as the one system row our trajectory model has. The producer fact id travels on the frame.
 *
 * The wording, the count-line split between `local_hold` and `syncing_hold`, and the decision lines
 * are fixed strings.
 */

export type HeldFreshnessActivityInput = {
  action: "send" | "task_claim" | "task_update";
  decision: "local_hold" | "syncing_hold";
  target: string;
  /** The count the Activity shows: `pendingCount` for `local_hold`, `heldMessageCount` for
   * `syncing_hold` (see `heldFreshnessMessageCount`). */
  messageCount: number;
  producerFactId: string;
};

export type HeldFreshnessActivity = {
  activityKind: "working";
  detailKind: "freshness_hold";
  detail: string;
  entries: ActivityTrajectoryEntry[];
  producerFactId: string;
};

export function heldFreshnessActivity(input: HeldFreshnessActivityInput): HeldFreshnessActivity {
  const messageNoun = input.messageCount === 1 ? "message" : "messages";
  const title =
    input.action === "send"
      ? "Send held by freshness check"
      : input.action === "task_claim"
        ? "Task claim held by freshness check"
        : "Task update held by freshness check";
  const countLine =
    input.decision === "syncing_hold"
      ? `unreviewed synced context for this target: ${input.messageCount} ${messageNoun}`
      : `new messages: ${input.messageCount} newer ${messageNoun}`;
  const decisionLines =
    input.decision === "syncing_hold"
      ? [
          "reason: this target's latest synced context was not yet in your reviewed context",
          input.action === "send"
            ? "action: review the synced context before sending"
            : "action: review the synced context, then retry this action",
        ]
      : ["decision: local hold; review the newer context before retrying"];
  const text = [input.target ? `target: ${input.target}` : null, countLine, ...decisionLines]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  return {
    activityKind: "working",
    detailKind: "freshness_hold",
    detail: title,
    entries: [{ kind: "system", title, text }],
    producerFactId: input.producerFactId,
  };
}

/** The message count of a freshness-decision Activity: the sync hold counts the window it
 * showed, a local hold counts what is actually pending; each falls back to the other. */
export function heldFreshnessMessageCount(input: {
  decision: "local_hold" | "syncing_hold";
  newMessageCount?: number;
  shownMessageCount?: number;
}): number {
  return input.decision === "syncing_hold"
    ? (input.shownMessageCount ?? input.newMessageCount ?? 0)
    : (input.newMessageCount ?? input.shownMessageCount ?? 0);
}

/** An activity is narrated for exactly the two hold decisions; a send that reached the provider
 * (`forward`/`bypass`) has none. */
export function heldFreshnessDecision(
  decision: string | undefined,
): "local_hold" | "syncing_hold" | undefined {
  return decision === "local_hold" || decision === "syncing_hold" ? decision : undefined;
}

/** Logs the freshness decision and reports its held-send Activity — one record per decision, so a
 * locally decided hold is auditable next to a server-decided one. */
export async function reportHeldSendFreshnessDecision(input: {
  agentId: string;
  target: string;
  result: AgentMessageTransportResponse;
  modelSeenSequence: number;
  logScope: Record<string, unknown>;
  reportFreshnessHold: (agentId: string, activity: HeldFreshnessActivity) => void;
}): Promise<void> {
  const { agentId, target, result, modelSeenSequence, logScope, reportFreshnessHold } = input;
  const heldDecision = heldFreshnessDecision(result.decision);
  if (!heldDecision) return;
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
  logger.info("Agent inbox freshness decision", {
    event: "agent.inbox.freshness_decision",
    ...logScope,
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
  reportFreshnessHold(
    agentId,
    heldFreshnessActivity({
      action: "send",
      decision: heldDecision,
      target,
      messageCount: heldFreshnessMessageCount({
        decision: heldDecision,
        newMessageCount: result.newMessageCount,
        shownMessageCount: result.shownMessageCount,
      }),
      producerFactId,
    }),
  );
}
