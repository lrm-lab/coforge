import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import { mergeSeenExactSeqs } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { AgentPreflightError } from "./agent-preflight-error";
import { recordTaskHoldOffered, taskHoldOffered } from "./agent-task-hold-offers";
import { heldTaskResult, type HeldTaskResultDeps } from "./held-task-result";

/** Task writes that must wait for the Agent to review unread target context first. */
const FRESHNESS_HELD_OPERATIONS = ["create", "claim", "assign"];
/** Task writes that go through on unread context, with what the Agent missed attached. */
const FRESHNESS_ATTACH_OPERATIONS = ["unclaim", "update", "amend"];

type TaskWriteFreshnessPorts = HeldTaskResultDeps & {
  agentTask: NonNullable<DaemonConnectionClient["agentTask"]>;
};

/**
 * The daemon-owned freshness policy around a task mutation: held operations answer the attention
 * preflight's hold, everything gated forwards the model-visible boundary so the server applies its
 * own gate, and a passed write's shown context is consumed only after it answered — a failed
 * command never marks unseen messages seen.
 */
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
      const held = await heldTaskResult(ports, agentId, command, target, agentApiKey);
      if (held) {
        recordTaskHoldOffered(agentId, holdKey);
        return held;
      }
    }
  }
  const { messageAttention } = ports;
  const seenUpToSeq = sourceThreadCreate
    ? (command.seenUpToSeq ?? 0)
    : Math.max(messageAttention.modelSeenSequence(agentId, target), command.seenUpToSeq ?? 0);
  const seenExactSeqs = sourceThreadCreate
    ? (command.seenExactSeqs ?? [])
    : mergeSeenExactSeqs(
        0,
        command.seenExactSeqs ?? [],
        messageAttention.seenExactSequences(agentId, target),
      );
  const result = await ports.agentTask(
    {
      ...command,
      ...(seenUpToSeq > 0 ? { seenUpToSeq } : {}),
      ...(seenExactSeqs.length > 0 ? { seenExactSeqs } : {}),
    },
    agentApiKey,
  );
  const shown = result.state === "held" ? (result.heldMessages ?? []) : (result.recentUnread ?? []);
  if (result.state === "held") recordTaskHoldOffered(agentId, holdKey);
  if (shown.length > 0) {
    if (sourceThreadCreate) {
      const maxByTarget = new Map<string, number>();
      for (const message of shown) {
        const messageTarget = message.target;
        if (!messageTarget) continue;
        maxByTarget.set(
          messageTarget,
          Math.max(maxByTarget.get(messageTarget) ?? 0, message.sequence),
        );
      }
      for (const [messageTarget, seq] of maxByTarget)
        messageAttention.recordModelSeen(agentId, messageTarget, seq);
    } else {
      messageAttention.recordModelSeen(
        agentId,
        target,
        Math.max(...shown.map(({ sequence }) => sequence)),
      );
    }
  }
  return result;
}
