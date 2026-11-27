import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { pendingMessageRecords } from "./agent-inbox-freshness";

export function heldTaskResult(
  messageAttention: AgentMessageAttentionIndex,
  agentId: string,
  command: TaskCommand,
  target: string,
): TaskResult | undefined {
  const pendingCount = messageAttention.pendingMessageCount(agentId, target);
  if (pendingCount === 0) return undefined;
  if (command.freshnessContextMode === "withheld")
    return {
      tasks: [],
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount: pendingCount,
    };
  return {
    tasks: [],
    state: "held",
    freshnessContextMode: "inline",
    heldMessages: pendingMessageRecords(messageAttention, agentId, target),
    newMessageCount: pendingCount,
  };
}
