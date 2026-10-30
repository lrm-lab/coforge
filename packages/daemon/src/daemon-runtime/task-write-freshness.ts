import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { heldTaskResult, taskFreshnessContext, type HeldTaskResultDeps } from "./held-task-result";

type TaskWriteFreshnessPorts = HeldTaskResultDeps & {
  agentTask: NonNullable<DaemonConnectionClient["agentTask"]>;
};

/** Runs the daemon-owned freshness policy around a task mutation. */
export async function taskWriteWithFreshness(
  ports: TaskWriteFreshnessPorts,
  agentId: string,
  command: TaskCommand,
  target: string,
  agentApiKey: string,
): Promise<TaskResult | undefined> {
  const blocked = ["create", "claim", "assign"].includes(command.operation);
  const attached = ["unclaim", "update", "amend"].includes(command.operation);
  if (!blocked && !attached) return undefined;
  if (blocked) {
    const held = await heldTaskResult(ports, agentId, command, target, agentApiKey);
    if (held) return held;
  }

  const context = await taskFreshnessContext(ports, agentId, command, target, agentApiKey, {
    allowFirstTouch: false,
  });
  const seenUpToSeq = Math.max(
    ports.messageAttention.modelSeenSequence(agentId, target),
    command.seenUpToSeq ?? 0,
  );
  const seenExactSeqs = [
    ...new Set([
      ...(command.seenExactSeqs ?? []),
      ...ports.messageAttention.seenExactSequences(agentId, target),
    ]),
  ].sort((a, b) => a - b);
  const forwarded = {
    ...command,
    ...(seenUpToSeq > 0 ? { seenUpToSeq } : {}),
    ...(seenExactSeqs.length > 0 ? { seenExactSeqs } : {}),
  };
  if (!attached || !context) return ports.agentTask(forwarded, agentApiKey);
  const result = await ports.agentTask(forwarded, agentApiKey);
  return {
    ...result,
    ...(context.withheld
      ? {
          freshnessContextMode: "withheld" as const,
          withheldMessageCount: context.messageCount,
        }
      : {
          recentUnread: context.messages,
          newMessageCount: context.messageCount,
        }),
  };
}
