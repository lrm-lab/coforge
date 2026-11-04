import type { DaemonCommandRequest, ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";
import type { ComputerUpgradeReceipt } from "#src/platform/computer-upgrade-receipts";
import type { MachineSupervisor } from "./machine-supervisor";
import { runWorkspaceLifecycleCommand } from "./run-supervisor-workspace-lifecycle";
import { OPERATOR_COMMAND_BUDGET_MS } from "./workspace-start-outcome";

/**
 * `command()`'s workspace-scoped lifecycle dispatch (task #417): the upgrade records, the
 * upgrade acknowledgement, and the detach run inside `runWorkspaceLifecycleCommand`; start,
 * stop and restart dispatch to the supervisor here. A `daemon:snapshot` answers the view
 * alone.
 */
export async function runWorkspaceCommand({
  method,
  request,
  supervisor,
  workspaceDirectory,
  stateDirectory,
  refreshChildUpgradeConfig,
  completeUpgrade,
  watchPendingUpgrade,
  launchComputerUpgrade,
  makeSelfClient,
  view,
  startForOperator,
  ownServerUrl,
}: {
  method: string;
  request: DaemonCommandRequest;
  supervisor: MachineSupervisor;
  workspaceDirectory: (workspaceId: string) => string;
  stateDirectory: string;
  refreshChildUpgradeConfig: (workspaceId: string) => Promise<void>;
  completeUpgrade: (
    workspaceId: string,
    requestId: string,
    receipt: ComputerUpgradeReceipt,
  ) => Promise<unknown>;
  watchPendingUpgrade: (workspaceId: string, requestId: string, at: number) => void;
  launchComputerUpgrade: (
    requestId: string,
    expectedVersion: string,
    input: { stateDirectory: string },
  ) => Promise<void>;
  makeSelfClient: (serverHttpUrl: string) => Pick<ComputerSelfClient, "detach">;
  view: () => Promise<ManagedRuntimeIdentity[]>;
  startForOperator: (
    operation: "start" | "restart",
    workspaceId: string | undefined,
    requestId: string,
  ) => Promise<ManagedRuntimeIdentity[]>;
  /** This Coordinator's own server — the only origin a detach's `serverHttpUrl` may name. */
  ownServerUrl: string;
}): Promise<
  ManagedRuntimeIdentity[] | { runtimes: ManagedRuntimeIdentity[]; detachKeyRevoked?: boolean }
> {
  const handled = await runWorkspaceLifecycleCommand({
    method,
    request,
    supervisor,
    ownServerUrl,
    workspaceDirectory,
    stateDirectory,
    refreshChildUpgradeConfig,
    completeUpgrade,
    watchPendingUpgrade,
    launchComputerUpgrade,
    makeSelfClient,
    view,
  });
  if (handled !== undefined) return handled;
  // upgrade, upgrade_ack and detach ran inside `runWorkspaceLifecycleCommand` (each returns
  // undefined — the detach's keyed marker came back through `handled`); the view is their
  // answer.
  if (method === "daemon:upgrade" || method === "daemon:upgrade_ack" || method === "daemon:detach")
    return view();
  if (method !== "daemon:snapshot") {
    const operation = method.slice("daemon:".length);
    if (operation !== "start" && operation !== "stop" && operation !== "restart")
      throw new Error("unknown lifecycle operation");
    if (operation === "stop") {
      // Answers by the same deadline: a Workspace it has not stopped yet still shows its
      // process, which the CLI reports as still stopping.
      await supervisor.command(operation, request.workspaceId, undefined, {
        deadline: Date.now() + OPERATOR_COMMAND_BUDGET_MS,
      });
      return view();
    }
    return startForOperator(operation, request.workspaceId, request.requestId);
  }
  return view();
}
