import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { AgentPreflightError } from "./agent-preflight-error";
import { recordTaskHoldOffered, taskHoldOffered } from "./agent-task-hold-offers";
import { heldTaskResult } from "./held-task-result";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";

/** Task writes that must wait for the Agent to review unread target context first. */
const FRESHNESS_HELD_OPERATIONS = ["create", "claim", "assign"];
/** Task writes that go through on unread context, with what the Agent missed attached. */
const FRESHNESS_ATTACH_OPERATIONS = ["unclaim", "update", "amend"];

type TaskWriteFreshnessPorts = {
  messageAttention: AgentMessageAttentionIndex;
  agentTask: NonNullable<DaemonConnectionClient["agentTask"]>;
};

export async function taskWriteWithFreshness(
  ports: TaskWriteFreshnessPorts,
  agentId: string,
  command: TaskCommand,
  target: string,
  agentApiKey: string,
): Promise<TaskResult | undefined> {
  const heldOperation = FRESHNESS_HELD_OPERATIONS.includes(command.operation);
  if (!heldOperation && !FRESHNESS_ATTACH_OPERATIONS.includes(command.operation)) return undefined;
  const sourceThreadCreate = command.operation === "create" && Boolean(command.messageId);
  const holdKey = sourceThreadCreate ? `${target}:${command.messageId}` : target;
  if (heldOperation) {
    if (command.continueAnyway === true && !taskHoldOffered(agentId, holdKey))
      throw new AgentPreflightError(
        "No freshness hold was suggested for this target, so there is nothing to confirm: " +
          "review the messages with `coforge message read` first.",
        "INVALID_INPUT",
        { retryable: false },
      );
    if (command.continueAnyway !== true && !sourceThreadCreate) {
      const held = heldTaskResult(ports.messageAttention, agentId, command, target);
      if (held) {
        recordTaskHoldOffered(agentId, holdKey);
        return held;
      }
    }
  }
  const { messageAttention } = ports;
  const result = await ports.agentTask(
    { ...command, consumptionEvidence: messageAttention.writeContext(agentId, holdKey).evidence },
    agentApiKey,
  );
  if (result.state === "held") recordTaskHoldOffered(agentId, holdKey);
  return result;
}
