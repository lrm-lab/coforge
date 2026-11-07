import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import type { ManagedBinding } from "./machine-supervisor";
import { WorkspaceParkedError } from "./workspace-health-journal";
import { WorkspaceLifecycleSupersededError } from "./lifecycle-superseded-error";
import type { LifecycleFailure } from "./machine-supervisor-operations";

const logger = getLogger(["coforge", "daemon", "supervisor", "failures"]);

/** What recording a lifecycle command's late failure needs of the Coordinator's serialized
 * mutation context. `MachineSupervisor` supplies it; the record itself runs inside its
 * `#serialize` queue. */
export type MachineFailureContext = {
  refresh(): Promise<void>;
  bindings(): ManagedBinding[];
  saveBinding(binding: ManagedBinding): Promise<ManagedBinding>;
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  now(): number;
};

/**
 * Nobody waits for a command that failed after it answered, so its failure is logged and
 * recorded on the Workspaces it had not handled yet, where `status` shows it. A park or a stop
 * or configure that took over is not a failure of this kind: `status` already shows the park,
 * and the operator asked for the takeover.
 */
export function recordLifecycleFailureAfterAnswer(
  context: MachineFailureContext,
  operation: LifecycleFailure["operation"],
  workspaceIds: readonly string[],
  error: unknown,
): void {
  const message =
    thrownMessage(error) ||
    `The ${operation} failed without a reason; the Computer log has the details.`;
  if (error instanceof WorkspaceParkedError || error instanceof WorkspaceLifecycleSupersededError)
    return;
  logger.warn("A lifecycle command failed after it had already answered", {
    event: "lifecycle:command_failed_after_answer",
    operation,
    workspace_ids: workspaceIds,
    error_message: message,
  });
  void context
    .serialize(async () => {
      await context.refresh();
      for (const id of workspaceIds) {
        const binding = context.bindings().find((entry) => entry.workspaceId === id);
        if (binding)
          await context.saveBinding({
            ...binding,
            lastFailure: { operation, message: message.slice(0, 500), at: context.now() },
          });
      }
    })
    .catch((recordError: unknown) => {
      logger.warn("Recording a lifecycle failure for status failed", {
        event: "lifecycle:failure_record_failed",
        error_message: thrownMessage(recordError),
      });
    });
}

/** Drops a Workspace's recorded failure once a lifecycle step for it succeeded. */
export async function clearLifecycleFailure(
  context: MachineFailureContext,
  workspaceId: string,
): Promise<void> {
  const binding = context.bindings().find((entry) => entry.workspaceId === workspaceId);
  if (binding?.lastFailure) await context.saveBinding({ ...binding, lastFailure: undefined });
}
