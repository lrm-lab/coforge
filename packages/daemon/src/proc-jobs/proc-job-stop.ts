import type { AgentProcJob, AgentProcStopReason } from "@lrm/coforge-sdk/agent";
import { stopVerifiedProcJob } from "#src/platform/proc-job-process";
import { markProcJobExited, toPublicProcJob, type StoredProcJob } from "./proc-job-ledger";

export async function stopProcJobTargets(
  list: StoredProcJob[],
  targets: readonly StoredProcJob[],
  reason: AgentProcStopReason,
  options: { graceMs: number; killWaitMs: number; platform: NodeJS.Platform },
  force?: boolean,
): Promise<{
  stopped: AgentProcJob[];
  alreadyExited: string[];
  failedTarget: StoredProcJob | undefined;
}> {
  const { graceMs, killWaitMs, platform } = options;
  const outcomes = await Promise.all(
    targets.map(async (target) => ({
      target,
      outcome: await stopVerifiedProcJob(target, { force, graceMs, killWaitMs, platform }),
    })),
  );
  const stopped: AgentProcJob[] = [];
  const alreadyExited: string[] = [];
  let failedTarget: StoredProcJob | undefined;
  for (const { target, outcome } of outcomes) {
    const idx = list.findIndex((item) => item.id === target.id);
    if (idx === -1) continue;
    if (outcome === "already_exited") {
      list[idx] = markProcJobExited(list[idx]!, "exited");
      alreadyExited.push(target.name);
    } else if (outcome === "stopped") {
      const updated = markProcJobExited(list[idx]!, reason);
      list[idx] = updated;
      stopped.push(toPublicProcJob(updated));
    } else {
      failedTarget ??= target;
    }
  }
  return { stopped, alreadyExited, failedTarget };
}
