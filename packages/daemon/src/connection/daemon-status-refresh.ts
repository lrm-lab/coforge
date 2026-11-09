import { DAEMON_CONNECTION_STATUS_METHOD, type AgentStatus } from "@lrm/coforge-sdk/internal";
import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
import type { DaemonConnectionConfig } from "./daemon-connection-client";
import type { DaemonConnectionTiming } from "./daemon-connection-timing";
import type { InboundQuietness } from "./connection-liveness";
import type { ListenerSlot } from "./listener-slot";
import { encodeDaemonConnectionStatus } from "./connection-status-payload";
import { readStatusLatestVersion } from "./daemon-ready-send";

const AGENT_STATUS_REFRESH_MS = 30_000;
export const COMPUTER_STATUS_REFRESH_MS = 30_000;

/** What the connection supplies to its periodic status refresh. */
export type DaemonStatusRefreshDeps = {
  client(): CentrifugeWorkspaceClient | undefined;
  connected(): boolean;
  statuses(): Iterable<AgentStatus>;
  queueStatus(client: CentrifugeWorkspaceClient, status: AgentStatus): void;
  inboundQuiet: InboundQuietness;
  latestComputerVersion: ListenerSlot<(version: string) => void>;
  timing(): DaemonConnectionTiming;
};

/** The two periodic status refreshes a live connection runs: replaying each active Agent's
 * status and polling the Computer's connection status. `start` is idempotent per connection
 * lifetime; `stop` clears both timers. */
export class DaemonStatusRefresh {
  #agentTimer: ReturnType<typeof setInterval> | undefined;
  #computerTimer: unknown;

  constructor(private readonly deps: DaemonStatusRefreshDeps) {}

  start(config: DaemonConnectionConfig): void {
    if (!this.#agentTimer) {
      this.#agentTimer = setInterval(() => {
        const client = this.deps.client();
        if (!this.deps.connected() || !client) return;
        for (const status of this.deps.statuses()) {
          if (status.status !== "active") continue;
          this.deps.queueStatus(client, { ...status, requestId: crypto.randomUUID() });
        }
      }, AGENT_STATUS_REFRESH_MS);
      this.#agentTimer.unref();
    }

    if (this.#computerTimer) return;
    const refresh = () => {
      const client = this.deps.client();
      if (!this.deps.connected() || !client) return;
      this.deps.inboundQuiet.check(client, config);
      void client
        .rpc(DAEMON_CONNECTION_STATUS_METHOD, encodeDaemonConnectionStatus(config))
        .then((reply) => {
          // An answered round trip is the only inbound traffic a Workspace with nothing to say
          // produces, so it is what keeps a legitimately quiet connection alive.
          if (client === this.deps.client()) this.deps.inboundQuiet.markInbound();
          const version = readStatusLatestVersion(reply);
          if (version) this.deps.latestComputerVersion.current?.(version);
        })
        .catch(() => {});
    };
    const timing = this.deps.timing();
    this.#computerTimer = timing.scheduleRepeating
      ? timing.scheduleRepeating(refresh, COMPUTER_STATUS_REFRESH_MS)
      : setInterval(refresh, COMPUTER_STATUS_REFRESH_MS);
    if (!timing.scheduleRepeating) {
      (this.#computerTimer as ReturnType<typeof setInterval>).unref();
    }
  }

  stop(): void {
    if (this.#agentTimer) clearInterval(this.#agentTimer);
    this.#agentTimer = undefined;
    if (this.#computerTimer !== undefined) {
      const timing = this.deps.timing();
      if (timing.cancelRepeating) timing.cancelRepeating(this.#computerTimer);
      else clearInterval(this.#computerTimer as ReturnType<typeof setInterval>);
      this.#computerTimer = undefined;
    }
  }
}
