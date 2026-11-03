import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import { mergeSeenExactSeqs } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
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
  // The caller confirmed the held review (`--anyway`): skip the local hold and let the write
  // through — the server's gate honors the same confirmation.
  if (heldOperation && command.continueAnyway !== true) {
    const held = await heldTaskResult(ports, agentId, command, target, agentApiKey);
    if (held) return held;
  }
  const { messageAttention } = ports;
  const seenUpToSeq = Math.max(
    messageAttention.modelSeenSequence(agentId, target),
    command.seenUpToSeq ?? 0,
  );
  const seenExactSeqs = mergeSeenExactSeqs(
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
  if (shown.length > 0)
    messageAttention.recordModelSeen(
      agentId,
      target,
      Math.max(...shown.map(({ sequence }) => sequence)),
    );
  return result;
}
