import {
  COMPUTER_UPGRADE_RESULT_METHOD,
  decodeComputerRestartIntent,
  decodeComputerUpgradeIntent,
  encodeComputerUpgradeResult,
  type ComputerUpgradeResult,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionConfig } from "./daemon-connection-client";
import {
  routePublication,
  type ComputerLifecycleKind,
  type PublicationKind,
} from "./publication-routing";

const REMEMBERED_REQUEST_IDS = 256;

function acceptLifecycleRequest(
  seen: Set<string>,
  requestId: string,
  run: () => Promise<void>,
): void {
  if (seen.size >= REMEMBERED_REQUEST_IDS) seen.delete(seen.values().next().value!);
  seen.add(requestId);
  try {
    void run().catch(() => {
      seen.delete(requestId);
    });
  } catch (error) {
    seen.delete(requestId);
    throw error;
  }
}

export class ComputerLifecyclePublications {
  readonly #restartRequestIds = new Set<string>();
  readonly #upgradeRequestIds = new Set<string>();
  readonly #reportedUpgradeRequestIds = new Set<string>();

  constructor(private readonly rpc: (method: string, payload: Uint8Array) => Promise<unknown>) {}

  routeKind(
    kind: ComputerLifecycleKind,
    data: Uint8Array,
    config: Pick<DaemonConnectionConfig, "requestUpgrade" | "requestRestart">,
    ownsDaemon: (value: { workspaceId: string; computerId?: string }) => boolean,
  ): boolean {
    if (kind === "computer_upgrade") {
      return routePublication(data, decodeComputerUpgradeIntent, (upgrade) => {
        const requestUpgrade = config.requestUpgrade;
        if (
          upgrade.protocolMajor !== 1 ||
          !ownsDaemon(upgrade) ||
          !requestUpgrade ||
          this.#upgradeRequestIds.has(upgrade.requestId)
        )
          return false;
        acceptLifecycleRequest(this.#upgradeRequestIds, upgrade.requestId, () =>
          requestUpgrade(upgrade.requestId, upgrade.expectedVersion, upgrade.releaseChannel),
        );
        return true;
      });
    }
    return routePublication(data, decodeComputerRestartIntent, (restart) => {
      const requestRestart = config.requestRestart;
      if (
        restart.protocolMajor !== 1 ||
        !ownsDaemon(restart) ||
        !requestRestart ||
        this.#restartRequestIds.has(restart.requestId)
      )
        return false;
      acceptLifecycleRequest(this.#restartRequestIds, restart.requestId, () =>
        requestRestart(restart.requestId),
      );
      return true;
    });
  }

  route(
    data: Uint8Array,
    config: Pick<DaemonConnectionConfig, "requestUpgrade" | "requestRestart">,
    ownsDaemon: (value: { workspaceId: string; computerId?: string }) => boolean,
    skip?: ReadonlySet<PublicationKind>,
  ): boolean {
    return (
      (!skip?.has("computer_upgrade") &&
        this.routeKind("computer_upgrade", data, config, ownsDaemon)) ||
      (!skip?.has("computer_restart") &&
        this.routeKind("computer_restart", data, config, ownsDaemon))
    );
  }

  async sendUpgradeResult(result: ComputerUpgradeResult): Promise<boolean> {
    if (this.#reportedUpgradeRequestIds.has(result.requestId)) return false;
    await this.rpc(COMPUTER_UPGRADE_RESULT_METHOD, encodeComputerUpgradeResult(result));
    if (this.#reportedUpgradeRequestIds.size >= REMEMBERED_REQUEST_IDS)
      this.#reportedUpgradeRequestIds.delete(
        this.#reportedUpgradeRequestIds.values().next().value!,
      );
    this.#reportedUpgradeRequestIds.add(result.requestId);
    return true;
  }

  clear(): void {
    this.#restartRequestIds.clear();
    this.#upgradeRequestIds.clear();
    this.#reportedUpgradeRequestIds.clear();
  }
}
