import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";

export type HeldTaskResultDeps = Readonly<{
  messageAttention: AgentMessageAttentionIndex;
  agentMessage: DaemonConnectionClient["agentMessage"];
  workspaceId: string;
}>;

/** Applies the attention preflight to a Task claim/update; returns the held result, if any. */
export async function heldTaskResult(
  deps: HeldTaskResultDeps,
  agentId: string,
  command: TaskCommand,
  target: string,
  agentApiKey: string,
): Promise<TaskResult | undefined> {
  const { messageAttention } = deps;
  const attention = messageAttention.check(agentId).find((item) => item.target === target);
  if (command.freshnessContextMode === "withheld")
    return attention
      ? {
          tasks: [],
          state: "held",
          freshnessContextMode: "withheld",
          withheldMessageCount: attention.pendingCount,
        }
      : undefined;
  // Nothing pending and the Agent has seen this target (to a frontier, or one by one from a
  // check): there is no context to present.
  if (
    !attention &&
    (messageAttention.modelSeenSequence(agentId, target) !== 0 ||
      messageAttention.hasExactSeen(agentId, target))
  )
    return undefined;
  const context = await deps.agentMessage?.(
    {
      idempotencyKey: crypto.randomUUID(),
      agentId,
      workspaceId: deps.workspaceId,
      operation: "read",
      target,
      limit: 3,
      ...(attention
        ? {
            fromSequence: attention.firstPendingSequence,
            throughSequence: attention.latestSequence,
          }
        : {}),
    },
    agentApiKey,
  );
  const heldMessages = (context?.accepted ? context.messages : [])
    .filter(
      (message) =>
        message.target === target && !messageAttention.hasSeen(agentId, target, message.sequence),
    )
    .slice(-3);
  if (heldMessages.length > 0) {
    messageAttention.recordModelSeen(
      agentId,
      target,
      Math.max(...heldMessages.map(({ sequence }) => sequence)),
    );
    return {
      tasks: [],
      state: "held",
      freshnessContextMode: "inline",
      heldMessages,
      newMessageCount: attention?.pendingCount ?? heldMessages.length,
    };
  }
  if (!attention) return undefined;
  return {
    tasks: [],
    state: "held",
    freshnessContextMode: "inline",
    heldMessages: [],
    newMessageCount: attention.pendingCount,
  };
}
