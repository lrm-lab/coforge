import { getLogger } from "@logtape/logtape";
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

const logger = getLogger(["coforge", "daemon", "supervisor", "upgrades"]);

/** The bindings still carrying this request's pending copy, with its recorded requestedAt. */
async function pendingMachineUpgradeCopies(
  supervisor: MachineSupervisor,
  requestId: string,
): Promise<{ workspaceId: string; requestedAt: number }[]> {
  return (await supervisor.snapshot()).flatMap((binding) =>
    (binding.upgradeOperations ?? [])
      .filter((operation) => operation.requestId === requestId && operation.state === "pending")
      .map((operation) => ({
        workspaceId: binding.workspaceId,
        requestedAt: operation.requestedAt,
      })),
  );
}

/** Every binding carrying this request's copy, and whether that copy is still pending — one read
 * of the bindings, since a request never has two copies on one binding. */
async function machineUpgradeCarriers(
  supervisor: MachineSupervisor,
  requestId: string,
): Promise<{ workspaceId: string; pending: boolean }[]> {
  return (await supervisor.snapshot()).flatMap((binding) => {
    const copy = (binding.upgradeOperations ?? []).find(
      (operation) => operation.requestId === requestId,
    );
    return copy ? [{ workspaceId: binding.workspaceId, pending: copy.state === "pending" }] : [];
  });
}

/**
 * Settles every binding's pending copy of a machine-level request. One binding's failed save must
 * not keep the rest pending: that is the refusal this settlement exists to clear, and the caller
 * reports the launch failure regardless.
 */
async function settleMachineUpgradeCopies(
  supervisor: MachineSupervisor,
  completeUpgrade: (
    workspaceId: string,
    requestId: string,
    receipt: ComputerUpgradeReceipt,
  ) => Promise<unknown>,
  requestId: string,
  receipt: ComputerUpgradeReceipt,
): Promise<void> {
  for (const { workspaceId } of await pendingMachineUpgradeCopies(supervisor, requestId)) {
    try {
      await completeUpgrade(workspaceId, requestId, receipt);
    } catch (error) {
      logger.warn("Settling a failed Computer upgrade launch left a copy pending", {
        event: "upgrade:launch_failure_settle_failed",
        request_id: requestId,
        workspace_id: workspaceId,
        error_message: thrownMessage(error),
      });
    }
  }
}

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
    input: { stateDirectory: string; releaseChannel?: string },
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
  if (method === "daemon:computer_upgrade") {
    if (!request.expectedVersion) throw new Error("computer upgrade requires expected version");
    // Machine-wide admission shares recordUpgrade's single pending slot: the request names no
    // Workspace, so any current binding satisfies its local-registration check and the record
    // fans out onto every binding. With no bindings there is nothing to record — the
    // installer's own machine-mutation lock stays the guard, as before this method existed.
    const carriers = (await supervisor.snapshot()).map((binding) => binding.workspaceId);
    const [carrier] = carriers;
    const created =
      carrier === undefined
        ? true
        : await supervisor.recordUpgrade(carrier, request.requestId, request.expectedVersion);
    if (created) {
      // Every binding carries a copy of the pending record, so every child's upgrade config
      // learns it — the same settlement push `daemon:upgrade` gives its one Workspace.
      await Promise.all(carriers.map((workspaceId) => refreshChildUpgradeConfig(workspaceId)));
      try {
        await launchComputerUpgrade(request.requestId, request.expectedVersion, {
          stateDirectory,
          releaseChannel: request.releaseChannel,
        });
      } catch (error) {
        // Same contract as `daemon:upgrade`: a job that never started must not leave the
        // pending record sitting there for the full TTL, refusing every later upgrade.
        const message = thrownMessage(error);
        await settleMachineUpgradeCopies(supervisor, completeUpgrade, request.requestId, {
          requestId: request.requestId,
          status: "failed",
          at: Date.now(),
          error: message,
          errorCode: UPGRADE_ERROR_CODE.LAUNCH_FAILED,
        });
        throw new UpgradeLaunchFailedError(message, { cause: error });
      }
      for (const { workspaceId, requestedAt } of await pendingMachineUpgradeCopies(
        supervisor,
        request.requestId,
      ))
        watchPendingUpgrade(workspaceId, request.requestId, requestedAt);
    }
    return undefined;
  }
  if (method === "daemon:upgrade") {
    if (!request.workspaceId || !request.expectedVersion)
      throw new Error("upgrade requires workspace and expected version");
    const created = await supervisor.recordUpgrade(
      request.workspaceId,
      request.requestId,
      request.expectedVersion,
    );
    if (created) {
      // Pushes down any settlement `recordUpgrade` just applied to the pending operations it
      // replaced, in addition to the new one, without restarting this Workspace. The record is
      // machine-wide, so every binding's child learns it, not only the requesting one.
      await Promise.all(
        (await supervisor.snapshot()).map((binding) =>
          refreshChildUpgradeConfig(binding.workspaceId),
        ),
      );
      try {
        await launchComputerUpgrade(request.requestId, request.expectedVersion, {
          stateDirectory,
          releaseChannel: request.releaseChannel,
        });
      } catch (error) {
        // `recordUpgrade` already committed a "pending" operation on every binding; a job that
        // never started must not leave those sitting there for the full pending TTL, refusing
        // every later upgrade in the meantime (the requirement this record exists for: never
        // leave an operation pending when the launch itself is what failed). The operation is
        // machine-wide, so its settlement is too: settling only the requesting Workspace would
        // leave the other copies refusing upgrades until the TTL expired.
        const message = thrownMessage(error);
        await settleMachineUpgradeCopies(supervisor, completeUpgrade, request.requestId, {
          requestId: request.requestId,
          status: "failed",
          at: Date.now(),
          error: message,
          errorCode: UPGRADE_ERROR_CODE.LAUNCH_FAILED,
        });
        throw new UpgradeLaunchFailedError(message, { cause: error });
      }
      // Every binding carries a pending copy, so every copy gets its own receipt watch — the
      // same fan-out `daemon:computer_upgrade` makes. A copy nobody watches would stay pending
      // until the next admission or the Coordinator's startup sweep.
      for (const { workspaceId, requestedAt } of await pendingMachineUpgradeCopies(
        supervisor,
        request.requestId,
      ))
        watchPendingUpgrade(workspaceId, request.requestId, requestedAt);
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
    // The operation is machine-wide, so its acknowledgement is too: a copy left unacknowledged
    // on another binding is re-reported on every later reconnect. A copy that is still pending -
    // its own receipt watcher settles it a poll later - is skipped rather than allowed to abort
    // the pass, and one binding's failed save does not stop the rest.
    const carriers = await machineUpgradeCarriers(supervisor, request.requestId);
    for (const { workspaceId, pending } of carriers.length
      ? carriers
      : [{ workspaceId: request.workspaceId, pending: false }]) {
      if (pending) continue;
      try {
        if (await supervisor.acknowledgeUpgrade(workspaceId, request.requestId))
          // Drops the now-acknowledged operation from the child's local config too, or a later
          // reconnect would keep re-reporting the same already-acknowledged result.
          await refreshChildUpgradeConfig(workspaceId);
      } catch (error) {
        logger.warn("Acknowledging a Computer upgrade operation left a copy unacknowledged", {
          event: "upgrade:ack_failed",
          request_id: request.requestId,
          workspace_id: workspaceId,
          error_message: thrownMessage(error),
        });
      }
    }
    return undefined;
  }
  return undefined;
}
