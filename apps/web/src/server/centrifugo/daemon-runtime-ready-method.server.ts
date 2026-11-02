import {
  AGENT_MIGRATION_CAPABILITY,
  decodeDaemonRuntimeReadyRequest,
} from "@lrm/coforge-sdk/internal";
import type { ComputerLifecycleActivity } from "#src/server/agents/computer-lifecycle-activity.server";
import {
  computerObservationSchema,
  type ComputerObservation,
} from "#src/server/computers/computer-metadata.server";
import type { ComputerRestartStore } from "#src/server/computers/computer-restart-store.server";
import type { RedisComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { errorType } from "#src/server/errors/error-type.server";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/** What a daemon's ready updates, each optional so a test composes only the step it covers. */
export type DaemonRuntimeReadyPorts = {
  recovery?: {
    recoverWorkspace(
      workspaceId: string,
      computerId: string,
      runningAgentIds: readonly string[],
    ): Promise<void>;
  };
  restarts?: ComputerRestartStore;
  capabilities?: {
    record(
      workspaceId: string,
      computerId: string,
      values: readonly string[],
      identity: { workerInstanceId: string; startedAt: number },
    ): Promise<unknown>;
  };
  reminderRecovery?: { snapshotAssigned(workspaceId: string, computerId: string): Promise<void> };
  /** Moves on the Computer's Agent migrations after it was away. */
  migrationRecovery?: { recover(workspaceId: string, computerId: string): Promise<void> };
  observe?: (
    scope: { workspaceId: string; computerId: string },
    metadata: ComputerObservation,
  ) => Promise<void>;
  upgrades?: RedisComputerUpgradeStore;
  /** Started after the ready succeeds, never awaited: Activity rows must not hold the reply. */
  lifecycle?: Pick<ComputerLifecycleActivity, "ready">;
};

export const createDaemonRuntimeReadyMethod =
  ({
    recovery,
    restarts,
    capabilities,
    reminderRecovery,
    migrationRecovery,
    observe,
    upgrades,
    lifecycle,
  }: DaemonRuntimeReadyPorts = {}): CentrifugoRpcMethod =>
  async (payload, metadata) => {
    const request = decodeDaemonRuntimeReadyRequest(payload);
    const denied = requireDaemonPrincipal(metadata, request);
    if (denied) return denied;
    if (
      !request.workspaceId ||
      !request.computerId ||
      !request.workerInstanceId ||
      !request.daemonVersion?.trim() ||
      !request.recoveredRestartRequestIds ||
      new Set(request.recoveredRestartRequestIds).size !==
        request.recoveredRestartRequestIds.length ||
      !request.recoveredUpgradeRequestIds ||
      new Set(request.recoveredUpgradeRequestIds).size !==
        request.recoveredUpgradeRequestIds.length ||
      !request.requestId
    )
      return { code: 400, message: "invalid daemon runtime ready request" };
    const observation = computerObservationSchema.safeParse(request);
    if (!observation.success) return { code: 400, message: "invalid Computer metadata" };
    let stage = "restart_recovery";
    try {
      await restarts?.ready(
        { workspaceId: request.workspaceId, computerId: request.computerId },
        {
          workerInstanceId: request.workerInstanceId,
          daemonVersion: request.daemonVersion,
          startedAt: request.startedAt,
        },
        request.recoveredRestartRequestIds,
      );
      stage = "identity_check";
      const current = await restarts?.identity?.({
        workspaceId: request.workspaceId,
        computerId: request.computerId,
      });
      if (current && current.workerInstanceId !== request.workerInstanceId)
        return { code: 409, message: "daemon runtime was superseded" };
      stage = "capability_record";
      await capabilities?.record(
        request.workspaceId,
        request.computerId,
        request.capabilities ?? [],
        { workerInstanceId: request.workerInstanceId, startedAt: request.startedAt },
      );
      stage = "computer_observation";
      await observe?.(
        { workspaceId: request.workspaceId, computerId: request.computerId },
        observation.data,
      );
      stage = "agent_recovery";
      await recovery?.recoverWorkspace(
        request.workspaceId,
        request.computerId,
        request.runningAgentIds,
      );
      stage = "reminder_recovery";
      if (request.capabilities?.includes("reminder:v1"))
        await reminderRecovery?.snapshotAssigned(request.workspaceId, request.computerId);
      if (request.capabilities?.includes(AGENT_MIGRATION_CAPABILITY))
        void migrationRecovery?.recover(request.workspaceId, request.computerId).catch((error) =>
          console.warn(
            JSON.stringify({
              event: "agent_migration:recovery_failed",
              request_id: request.requestId,
              workspace_id: request.workspaceId,
              computer_id: request.computerId,
              outcome: "failed",
              error_type: errorType(error),
            }),
          ),
        );
      stage = "upgrade_recovery";
      if (upgrades && request.computerVersion?.trim())
        await upgrades.ready(
          { workspaceId: request.workspaceId, computerId: request.computerId },
          {
            workerInstanceId: request.workerInstanceId,
            computerVersion: request.computerVersion,
            daemonVersion: request.daemonVersion,
            startedAt: request.startedAt,
          },
          request.recoveredUpgradeRequestIds,
        );
      void lifecycle
        ?.ready(
          { workspaceId: request.workspaceId, computerId: request.computerId },
          {
            requestId: request.requestId,
            workerInstanceId: request.workerInstanceId,
            ...(request.computerVersion ? { computerVersion: request.computerVersion } : {}),
            recoveredUpgradeRequestIds: request.recoveredUpgradeRequestIds,
            recoveredRestartRequestIds: request.recoveredRestartRequestIds,
          },
        )
        .catch((error: unknown) =>
          console.error(
            JSON.stringify({
              event: "daemon_ready.lifecycle_activity_failed",
              outcome: "failed",
              request_id: request.requestId,
              workspace_id: request.workspaceId,
              computer_id: request.computerId,
              error_type: errorType(error),
            }),
          ),
        );
      return new Uint8Array();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "daemon_ready.failed",
          stage,
          request_id: request.requestId,
          workspace_id: request.workspaceId,
          computer_id: request.computerId,
          error_type: errorType(error),
        }),
      );
      return { code: 503, message: `daemon ready failed at ${stage}` };
    }
  };
