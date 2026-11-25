import {
  REMINDER_SYNC_MESSAGE_TYPE,
  decodeAgentActivityProbe,
  decodeAgentInboxPurge,
  decodeAgentMessageDelivery,
  decodeAgentMigrationCancel,
  decodeAgentMigrationLease,
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentTurnInterruptIntent,
  decodeAgentWorkspaceResetRequest,
  decodeReminderSync,
  type AgentActivityProbe,
  type AgentInboxPurge,
  type AgentMessageDelivery,
  type AgentMigrationCancel,
  type AgentStartIntent,
  type AgentStopIntent,
  type AgentTurnInterruptIntent,
  type AgentWorkspaceResetRequest,
  type RuntimeAuthIntent,
} from "@lrm/coforge-sdk/internal";
import {
  decodeAppRegistrationNotice,
  type AppRegistrationNotice,
} from "@lrm/coforge-sdk/internal/app-registration-notice";
import type { RejectedControl } from "./control-rejection-log";
import type {
  DaemonConnectionConfig,
  ReceivedAgentMigrationLease,
} from "./daemon-connection-client";
import type { DaemonProviderPublications } from "./daemon-provider-publications";
import type { DaemonQueries } from "./daemon-queries";
import type { ListenerSlot } from "./listener-slot";
import { ownedIntent } from "./owned-intent";
import { routePublication } from "./publication-routing";
import type { ReadyPublicationHold } from "./ready-publication-hold";
import { routeRuntimeAuthPublication } from "./runtime-auth-publication";
import type { ServerPublications } from "./server-publications";
import type { ComputerLifecyclePublications } from "./upgrade-result-send";

export type AgentPublicationDispatchDeps = {
  runtimeAuthIntent: ListenerSlot<(intent: RuntimeAuthIntent) => void>;
  queries: DaemonQueries;
  serverPublications: ServerPublications;
  computerLifecycle: ComputerLifecyclePublications;
  providerPublications: DaemonProviderPublications;
  readyPublications: ReadyPublicationHold;
  rejectedControl: RejectedControl;
  appRegistrationNotice: ListenerSlot<(notice: AppRegistrationNotice) => void>;
  agentMigrationLease: ListenerSlot<(lease: ReceivedAgentMigrationLease) => void>;
  agentMigrationCancel: ListenerSlot<(cancel: AgentMigrationCancel) => void>;
  agentWorkspaceReset: ListenerSlot<(request: AgentWorkspaceResetRequest) => void>;
  agentActivityProbe: ListenerSlot<(probe: AgentActivityProbe) => void>;
  agentInboxPurge: ListenerSlot<(purge: AgentInboxPurge) => void>;
  agentMessage: ListenerSlot<(delivery: AgentMessageDelivery) => void>;
  agentStop: ListenerSlot<(intent: AgentStopIntent) => void>;
  agentTurnInterrupt: ListenerSlot<(intent: AgentTurnInterruptIntent) => void>;
  agentStart: ListenerSlot<(intent: AgentStartIntent) => void>;
};

export function dispatchAgentPublication(
  deps: AgentPublicationDispatchDeps,
  data: Uint8Array,
  config: DaemonConnectionConfig,
): void {
  const { workspaceId, computerId } = config;
  const ownsDaemon = (value: { workspaceId: string; computerId?: string }) =>
    value.workspaceId === workspaceId && value.computerId === computerId;
  const handled =
    routeRuntimeAuthPublication(data, config, deps.runtimeAuthIntent.current) ||
    deps.queries.receive(data, config) ||
    routePublication(
      data,
      decodeReminderSync,
      (sync) => sync.messageType === REMINDER_SYNC_MESSAGE_TYPE && ownsDaemon(sync),
    ) ||
    deps.serverPublications.route(
      data,
      { workspaceId, computerId: config.computerId },
      deps.readyPublications,
    ) ||
    routePublication(data, decodeAppRegistrationNotice, (notice) => {
      if (!ownsDaemon(notice)) return false;
      deps.readyPublications.deliver(deps.appRegistrationNotice, notice);
      return true;
    }) ||
    routePublication(data, decodeAgentMigrationLease, (lease) => {
      if (!ownsDaemon(lease)) return false;
      deps.readyPublications.deliver(deps.agentMigrationLease, {
        ...lease,
        deadline: Date.now() + lease.expiresInMs,
      });
      return true;
    }) ||
    routePublication(data, decodeAgentMigrationCancel, (cancel) => {
      if (!ownsDaemon(cancel)) return false;
      deps.readyPublications.deliver(deps.agentMigrationCancel, cancel);
      return true;
    }) ||
    deps.computerLifecycle.route(data, config, ownsDaemon) ||
    routePublication(data, decodeAgentWorkspaceResetRequest, (request) => {
      if (request.workspaceId === workspaceId)
        deps.readyPublications.deliver(deps.agentWorkspaceReset, request);
      return true;
    }) ||
    deps.providerPublications.route(data, workspaceId) ||
    routePublication(data, decodeAgentActivityProbe, (probe) => {
      if (probe.protocolMajor !== 1 || !ownsDaemon(probe)) return false;
      deps.readyPublications.deliver(deps.agentActivityProbe, probe, "probe");
      return true;
    }) ||
    routePublication(data, decodeAgentInboxPurge, (purge) => {
      if (purge.protocolMajor !== 1 || !ownsDaemon(purge)) return false;
      deps.readyPublications.deliver(deps.agentInboxPurge, purge);
      return true;
    });
  if (handled) return;
  const decoders = [
    {
      kind: "agent_message",
      decode: () =>
        deps.readyPublications.deliver(
          deps.agentMessage,
          ownedIntent(decodeAgentMessageDelivery(data), workspaceId),
          "notice",
        ),
    },
    {
      kind: "agent_stop",
      decode: () => {
        const intent = ownedIntent(decodeAgentStopIntent(data), workspaceId);
        deps.readyPublications.deliver(deps.agentStop, intent, "stop");
      },
    },
    {
      kind: "agent_turn_interrupt",
      decode: () => {
        const intent = ownedIntent(decodeAgentTurnInterruptIntent(data), workspaceId);
        if (!deps.readyPublications.holding)
          deps.readyPublications.deliver(deps.agentTurnInterrupt, intent);
      },
    },
    {
      kind: "agent_start",
      decode: () => {
        const intent = ownedIntent(decodeAgentStartIntent(data), workspaceId);
        deps.readyPublications.deliver(deps.agentStart, intent, "start");
      },
    },
  ];
  deps.rejectedControl.decodeFirst(decoders, data, { workspaceId, computerId });
}
