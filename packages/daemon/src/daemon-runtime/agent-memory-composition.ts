import type { AgentLaunchCoordinatorPorts } from "./agent-launch-coordinator";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { readMemoryReviewReceipt } from "#src/local-memory/memory-review-receipt";
import { LocalMemoryRuntime } from "./local-memory-runtime";
import { MemoryIdleReview } from "./memory-idle-review";

type AgentMemoryPorts = Pick<
  AgentLaunchCoordinatorPorts,
  | "contexts"
  | "runtimeRelease"
  | "connection"
  | "agentProcessManager"
  | "authorizeMemory"
  | "systemCleaner"
  | "isStopping"
  | "deliveryGate"
  | "lifecycle"
>;

export function composeAgentMemory(ports: AgentMemoryPorts, compacting: (id: string) => boolean) {
  const review = new MemoryIdleReview({
    ledger: (id) => ports.contexts.memoryReviewLedger(id),
    idle: (id) => {
      const agent = ports.runtimeRelease.coldIdleAgent?.(id);
      return (
        !ports.isStopping() &&
        agent !== undefined &&
        agent.busyReason === undefined &&
        !compacting(id) &&
        !ports.deliveryGate.shouldHold(id)
      );
    },
    receipt: (id) =>
      readMemoryReviewReceipt(
        agentWorkspaceDirectory(ports.connection.workspaceRoot, ports.connection.workspaceId, id),
      ),
    deliver: async (id, text) => {
      const session = ports.agentProcessManager.session(id);
      if (!session?.notify || session.hasLiveTurn !== false) return false;
      await session.notify(text);
      return true;
    },
  });
  ports.lifecycle.subscribe({ processClosed: (id) => review.forget(id) });
  const local = new LocalMemoryRuntime(
    (context, key) => ports.authorizeMemory(context, key),
    () => ports.connection,
    (id, key, revision) => {
      ports.systemCleaner.onMemoryWrite(id);
      if (ports.agentProcessManager.session(id)) review.noteWrite(id, key, revision);
    },
  );
  return { local, review };
}
