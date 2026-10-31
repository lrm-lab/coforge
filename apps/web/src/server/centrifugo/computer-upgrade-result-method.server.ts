import { decodeComputerUpgradeResult } from "@lrm/coforge-sdk/internal";
import {
  getComputerUpgradeStore,
  type RedisComputerUpgradeStore,
} from "#src/server/computers/computer-upgrade-store.server";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/**
 * The Daemon's terminal report for one upgrade operation. A reported failure settles the request
 * with its reason; a reported success is only ever corroborating evidence - the store still
 * requires the Computer's own new identity before calling an upgrade complete.
 */
export function createComputerUpgradeResultMethod(
  upgrades?: Pick<RedisComputerUpgradeStore, "reported">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    let result;
    try {
      result = decodeComputerUpgradeResult(payload);
    } catch {
      return { code: 400, message: "invalid Computer upgrade result" };
    }
    const denied = requireDaemonPrincipal(metadata, result);
    if (denied) return denied;
    if (result.protocolMajor !== 1 || !result.requestId)
      return { code: 400, message: "invalid Computer upgrade result" };
    try {
      await (upgrades ?? getComputerUpgradeStore()).reported(
        { workspaceId: result.workspaceId, computerId: result.computerId },
        {
          requestId: result.requestId,
          status: result.status,
          completedAtMs: result.completedAtMs,
          ...(result.version ? { version: result.version } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        },
      );
      // Acceptance is the acknowledgement: the Daemon drops its local record on this reply.
      return new Uint8Array();
    } catch {
      return { code: 503, message: "Computer upgrade result was not recorded" };
    }
  };
}
