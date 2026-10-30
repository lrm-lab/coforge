import type { AgentMessageRecord, TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";

export type HeldTaskResultDeps = Readonly<{
  messageAttention: AgentMessageAttentionIndex;
  agentMessage: DaemonConnectionClient["agentMessage"];
  workspaceId: string;
}>;

export type TaskFreshnessContext = Readonly<{
  messages: AgentMessageRecord[];
  messageCount: number;
  withheld: boolean;
  seenUpToSeq?: number;
}>;

/** Reads the exact target context the daemon can prove is newer than the model boundary. */
export async function taskFreshnessContext(
  deps: HeldTaskResultDeps,
  agentId: string,
  command: TaskCommand,
  target: string,
  agentApiKey: string,
  { allowFirstTouch = true }: { allowFirstTouch?: boolean } = {},
): Promise<TaskFreshnessContext | undefined> {
  const { messageAttention } = deps;
  const attention = messageAttention.check(agentId).find((item) => item.target === target);
  if (command.freshnessContextMode === "withheld")
    return attention
      ? {
          messages: [],
          messageCount: attention.pendingCount,
          withheld: true,
        }
      : undefined;
  // A target the Agent has already seen has no first-touch context to fetch. This also keeps
  // allowed task writes from turning a previously reviewed target into a synthetic hold.
  if (
    !attention &&
    (messageAttention.modelSeenSequence(agentId, target) !== 0 ||
      messageAttention.hasExactSeen(agentId, target))
  )
    return undefined;
  if (!attention && !allowFirstTouch) return undefined;
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
  const messages = (context?.accepted ? context.messages : [])
    .filter(
      (message) =>
        message.target === target && !messageAttention.hasSeen(agentId, target, message.sequence),
    )
    .slice(-3);
  if (messages.length > 0) {
    const seenUpToSeq = Math.max(...messages.map(({ sequence }) => sequence));
    messageAttention.recordModelSeen(agentId, target, seenUpToSeq);
    return {
      messages,
      messageCount: attention?.pendingCount ?? messages.length,
      withheld: false,
      seenUpToSeq,
    };
  }
  if (!attention) return undefined;
  return {
    messages: [],
    messageCount: attention.pendingCount,
    withheld: false,
  };
}

/** Applies the attention preflight to a Task claim/update; returns the held result, if any. */
export async function heldTaskResult(
  deps: HeldTaskResultDeps,
  agentId: string,
  command: TaskCommand,
  target: string,
  agentApiKey: string,
): Promise<TaskResult | undefined> {
  const context = await taskFreshnessContext(deps, agentId, command, target, agentApiKey);
  if (context) {
    if (context.withheld)
      return {
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount: context.messageCount,
      };
    if (context.messageCount > 0)
      return {
        tasks: [],
        state: "held",
        freshnessContextMode: "inline",
        heldMessages: context.messages,
        newMessageCount: context.messageCount,
      };
  }
  return undefined;
}
