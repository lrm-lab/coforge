import { utf8Decoder, utf8Encoder } from "@lrm/coforge-sdk/internal";
import type { RedisComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { getComputerStatusCache, type ComputerStatusCache } from "./computer-status.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

export function createDaemonConnectionStatusMethod(
  statusCache?: ComputerStatusCache,
  capabilities?: {
    refresh(
      workspaceId: string,
      computerId: string,
      identity?: { workerInstanceId: string; startedAt: number },
    ): Promise<void>;
  },
  upgrades?: Pick<RedisComputerUpgradeStore, "touchIdentity">,
  /** The release feed's newest Computer version: the heartbeat's answer refreshes it for a
   * daemon that stays connected for days between readies; a failed read answers no version. */
  latestComputerVersion?: () => Promise<string | null>,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const request = JSON.parse(utf8Decoder.decode(payload)) as {
      workspaceId?: string;
      computerId?: string;
      online?: boolean;
      workerInstanceId?: string;
      startedAt?: number;
    };
    if (
      request.workspaceId !== metadata.principal.workspaceId ||
      request.computerId !== metadata.principal.computerId ||
      typeof request.online !== "boolean"
    )
      return { code: 403, message: "invalid daemon connection status" };
    await (statusCache ?? getComputerStatusCache()).put(
      { workspaceId: request.workspaceId, computerId: request.computerId },
      request.online,
    );
    if (request.online) {
      await capabilities?.refresh(
        request.workspaceId,
        request.computerId,
        request.workerInstanceId && typeof request.startedAt === "number"
          ? { workerInstanceId: request.workerInstanceId, startedAt: request.startedAt }
          : undefined,
      );
      // Transitional: identity keys are durable now, so this cannot create an identity for a
      // Computer that never reported one. It only clears a pre-durable-identity 90s lease.
      await upgrades?.touchIdentity({
        workspaceId: request.workspaceId,
        computerId: request.computerId,
      });
    }
    const version = await latestComputerVersion?.().catch(() => null);
    return utf8Encoder.encode(JSON.stringify(version ? { latestComputerVersion: version } : {}));
  };
}
