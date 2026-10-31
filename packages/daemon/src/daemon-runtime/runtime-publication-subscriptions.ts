import { getLogger } from "@logtape/logtape";
import type {
  AgentActivityProbe,
  AgentInboxPurge,
  AgentMigrationCancel,
  AgentMessageDelivery,
  AgentStartIntent,
  AgentStopIntent,
  AgentTurnInterruptIntent,
  AgentWorkspaceResetRequest,
  DaemonConnectRejectionReason,
  ReminderSync,
  AppConfigSync,
} from "@lrm/coforge-sdk/internal";
import type { AppRegistrationNotice } from "@lrm/coforge-sdk/internal/app-registration-notice";
import type {
  DaemonConnectionClient,
  ReceivedAgentMigrationLease,
} from "#src/connection/daemon-connection-client";
import { HeldPublications } from "#src/connection/held-publications";
import {
  logAgentActivityProbeFailure,
  logAgentOperationFailure,
  logAgentStartFailure,
} from "./agent-failure-logs";
import { diagnosticErrorCode, diagnosticErrorName, thrownMessage } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime"]);

type Hold<Value> = (value: Value, run: () => Promise<void>) => void;

export type RuntimePublicationSubscriptionPorts = {
  transport: DaemonConnectionClient;
  workspaceId: string;
  computerId: string;
  startAgent: (intent: AgentStartIntent) => Promise<unknown>;
  stopAgent: (intent: AgentStopIntent) => Promise<unknown>;
  interruptAgent: (intent: AgentTurnInterruptIntent) => Promise<unknown>;
  probeAgent: (probe: AgentActivityProbe) => Promise<unknown>;
  purgeAgentInbox: (purge: AgentInboxPurge) => void;
  resetWorkspace: (request: AgentWorkspaceResetRequest) => Promise<void>;
  deliverMessage: (message: AgentMessageDelivery) => Promise<void>;
  stopRuntime: () => Promise<void>;
  connectionRefused: (reason: DaemonConnectRejectionReason) => void;
  applyReminderSync: (sync: ReminderSync) => Promise<void>;
  applyAppConfigSync: (sync: AppConfigSync) => void;
  acceptAppRegistrationNotice: (notice: AppRegistrationNotice) => Promise<void>;
  migration?: {
    pruneLeftovers: () => Promise<void>;
    lease: (lease: ReceivedAgentMigrationLease) => void;
    cancel: (cancel: AgentMigrationCancel) => Promise<void>;
  };
};

export class RuntimePublicationSubscriptions {
  /** Publications before ready are replayed after the handshake: latest start/stop/probe per
   * Agent, control intents in arrival order, and capped delivery notices. */
  readonly #heldControl = new HeldPublications<() => Promise<void>>();
  readonly #heldMessages = new HeldPublications<() => Promise<void>>();
  #buffering = true;

  constructor(private readonly ports: RuntimePublicationSubscriptionPorts) {}

  async install(): Promise<(() => void)[]> {
    const { transport } = this.ports;
    const subscriptions: (() => void)[] = [];
    const subscribe = (unsubscribe: (() => void) | undefined) => {
      if (unsubscribe) subscriptions.push(unsubscribe);
    };
    const receive =
      <Value>(hold: Hold<Value>, handle: (value: Value) => Promise<void>) =>
      (value: Value) => {
        if (this.#buffering) hold(value, () => handle(value));
        else void handle(value);
      };
    const latest =
      <Value extends { agentId: string }>(kind: "start" | "stop" | "probe"): Hold<Value> =>
      (value, run) =>
        this.#heldControl.latestFor(value.agentId, kind, run);
    const control: Hold<unknown> = (_value, run) => this.#heldControl.add(run);
    const notice: Hold<{ agentId: string }> = (value, run) =>
      this.#heldMessages.notice(value.agentId, run);
    const failure =
      <Request extends AgentStopIntent | AgentWorkspaceResetRequest | AgentMessageDelivery>(
        operation: "stop" | "workspace_reset" | "message_delivery",
        handle: (request: Request) => Promise<unknown>,
      ) =>
      async (request: Request): Promise<void> => {
        try {
          await handle(request);
        } catch (error) {
          logAgentOperationFailure(this.ports.computerId, operation, request, error);
        }
      };

    subscribe(
      transport.onAgentStart?.(
        receive(latest("start"), (intent: AgentStartIntent) =>
          this.ports.startAgent(intent).then(
            () => {},
            (error) => logAgentStartFailure(intent, error),
          ),
        ),
      ),
    );
    subscribe(
      transport.onAgentStop?.(
        receive(
          latest("stop"),
          failure("stop", (intent: AgentStopIntent) => this.ports.stopAgent(intent)),
        ),
      ),
    );
    subscribe(
      transport.onAgentTurnInterrupt?.(
        receive(
          () => {},
          async (intent: AgentTurnInterruptIntent) => {
            try {
              await this.ports.interruptAgent(intent);
            } catch (error) {
              logger.warning("Turn interrupt failed", {
                event: "agent_turn_interrupt:failed",
                agent_id: intent.agentId,
                error: thrownMessage(error),
              });
            }
          },
        ),
      ),
    );
    subscribe(
      transport.onAgentActivityProbe?.(
        receive(latest("probe"), async (probe: AgentActivityProbe) => {
          try {
            await this.ports.probeAgent(probe);
          } catch (error) {
            logAgentActivityProbeFailure(probe, error);
          }
        }),
      ),
    );
    subscribe(
      transport.onAgentInboxPurge?.(
        receive(control, async (purge: AgentInboxPurge) => {
          try {
            this.ports.purgeAgentInbox(purge);
          } catch (error) {
            logger.warn("Agent inbox purge was not applied", {
              event: "agent.inbox.purge_rejected",
              agent_id: purge.agentId,
              error_code: diagnosticErrorName(error),
            });
          }
        }),
      ),
    );
    subscribe(
      transport.onAgentWorkspaceReset?.(
        receive(
          control,
          failure("workspace_reset", (request: AgentWorkspaceResetRequest) =>
            this.ports.resetWorkspace(request),
          ),
        ),
      ),
    );
    subscribe(
      transport.onAgentMessage?.(
        receive(
          notice,
          failure("message_delivery", (message: AgentMessageDelivery) =>
            this.ports.deliverMessage(message),
          ),
        ),
      ),
    );
    subscribe(
      transport.onConnectionRefused?.((reason) => {
        void this.ports
          .stopRuntime()
          .catch((error) =>
            logger.warn("Stopping Agents after the cloud refused the connection failed", {
              event: "daemon_runtime:refused_stop_failed",
              reason,
              error_code: diagnosticErrorCode(error),
            }),
          )
          .then(() => this.ports.connectionRefused(reason));
      }),
    );
    subscribe(
      transport.onReminderSync?.((sync) => void this.ports.applyReminderSync(sync).catch(() => {})),
    );
    subscribe(transport.onAppConfigSync?.((sync) => this.ports.applyAppConfigSync(sync)));
    subscribe(
      transport.onAppRegistrationNotice?.((notice) => {
        void this.ports.acceptAppRegistrationNotice(notice).catch(() => {});
      }),
    );
    const migration = this.ports.migration;
    if (migration) {
      // Before any lease is taken, so nothing it clears can belong to a run.
      await migration.pruneLeftovers().catch((error: unknown) =>
        logger.warn("Clearing what Agent migrations left behind failed", {
          event: "agent_migration:prune_failed",
          error_code: diagnosticErrorName(error),
        }),
      );
      subscribe(transport.onAgentMigrationLease?.((lease) => migration.lease(lease)));
      subscribe(
        transport.onAgentMigrationCancel?.(
          (cancel) => void migration.cancel(cancel).catch(() => {}),
        ),
      );
    }
    return subscriptions;
  }

  /** Stops buffering and returns the control work before delivery notices, preserving the old
   * replay order. A dropped notice is reported to the cloud, which resends it later. */
  release(): { buffered: Array<() => Promise<void>>; dropped: number } {
    const heldNotices = this.#heldMessages.take();
    const buffered = [...this.#heldControl.take().items, ...heldNotices.items];
    this.#buffering = false;
    return { buffered, dropped: heldNotices.dropped };
  }
}
