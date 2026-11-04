import {
  UPGRADE_ERROR_CODE,
  thrownMessage,
  type DaemonCommandRequest,
  type ManagedRuntimeIdentity,
} from "@lrm/coforge-sdk/internal";
import { UpgradeLaunchFailedError } from "./upgrade-error";
import type { MachineSupervisor } from "./machine-supervisor";
import type { ComputerUpgradeReceipt } from "#src/platform/computer-upgrade-receipts";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";

/**
 * The workspace-scoped lifecycle operations one `command` frame carries beyond start, stop and
 * restart (task #417 step 3's `daemon:detach`, the upgrade record/acknowledgement the upgrade
 * flow owns). Each takes the request and the supervisor, and returns the same `view()` the
 * start/stop/restart branch answers, or `undefined` where the method is not theirs.
 */
export async function runWorkspaceLifecycleCommand({
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
  /** This Coordinator's own server — the only origin a request's `serverHttpUrl` may name
   * before the local `sk_computer` is sent to it (task #417). */
  ownServerUrl: string;
}): Promise<
  | ManagedRuntimeIdentity[]
  | { runtimes: ManagedRuntimeIdentity[]; detachKeyRevoked: boolean }
  | undefined
> {
  if (method === "daemon:upgrade") {
    if (!request.workspaceId || !request.expectedVersion)
      throw new Error("upgrade requires workspace and expected version");
    const created = await supervisor.recordUpgrade(
      request.workspaceId,
      request.requestId,
      request.expectedVersion,
    );
    if (created) {
      // Pushes down any settlement `recordUpgrade` just applied to the pending operation it
      // replaced, in addition to the new one, without restarting this Workspace.
      await refreshChildUpgradeConfig(request.workspaceId);
      try {
        await launchComputerUpgrade(request.requestId, request.expectedVersion, {
          stateDirectory,
        });
      } catch (error) {
        // `recordUpgrade` already committed a "pending" operation for this request; a job that
        // never started must not leave it sitting there for the full pending TTL, refusing every
        // later upgrade in the meantime (the requirement this record exists for: never leave an
        // operation pending when the launch itself is what failed).
        const message = thrownMessage(error);
        await completeUpgrade(request.workspaceId, request.requestId, {
          requestId: request.requestId,
          status: "failed",
          at: Date.now(),
          error: message,
          errorCode: UPGRADE_ERROR_CODE.LAUNCH_FAILED,
        });
        throw new UpgradeLaunchFailedError(message, { cause: error });
      }
      watchPendingUpgrade(request.workspaceId, request.requestId, Date.now());
    }
    return undefined;
  }
  if (method === "daemon:detach") {
    if (!request.workspaceId) throw new Error("detach requires workspace");
    // The server decides: only a definite revoke-and-unlink answer lets the local half run;
    // anything else keeps the binding exactly as it was (task #417 step 3).
    // A binding the supervisor never had can still carry a key — the request's own Computer
    // and server name it. The `sk_computer` goes only to a serverHttpUrl naming THIS
    // Coordinator's own server: a request that points anywhere else never receives it.
    const target =
      request.computerId &&
      request.serverHttpUrl &&
      new URL(request.serverHttpUrl).origin === new URL(ownServerUrl).origin
        ? { computerId: request.computerId, serverHttpUrl: request.serverHttpUrl }
        : undefined;
    const result = await supervisor.detach(request.workspaceId, {
      credentials: new (
        await import("#src/credentials/credential-store")
      ).FileDaemonCredentialStore(workspaceDirectory(request.workspaceId)),
      makeSelfClient,
      target,
    });
    if (!result.detached && result.reason === "not_bound")
      throw Object.assign(new Error("no binding for that Workspace here"), {
        code: "detach_not_bound",
        workspaceId: request.workspaceId,
      });
    if (!result.detached)
      throw Object.assign(new Error("server answer unavailable; binding kept"), {
        code: "detach_unconfirmed",
        workspaceId: request.workspaceId,
      });
    // The revoked-key answer rides the view as a marker so `local-rpc` can set the response's
    // detach_key_revoked — the CLI says "key revoked", not "detached" (task #417).
    return {
      runtimes: await view(),
      detachKeyRevoked: result.keyRevoked === true,
    };
  }
  if (method === "daemon:upgrade_ack") {
    if (!request.workspaceId) throw new Error("upgrade acknowledgement requires workspace");
    if (await supervisor.acknowledgeUpgrade(request.workspaceId, request.requestId))
      // Drops the now-acknowledged operation from the child's local config too, or a later
      // reconnect would keep re-reporting the same already-acknowledged result.
      await refreshChildUpgradeConfig(request.workspaceId);
    return undefined;
  }
  return undefined;
}
