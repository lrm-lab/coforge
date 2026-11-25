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
import {
  routePublication,
  scanPublicationKinds,
  type PublicationKind,
} from "./publication-routing";
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
  const scope = { workspaceId, computerId };
  const ownsDaemon = (value: { workspaceId: string; computerId?: string }) =>
    value.workspaceId === workspaceId && value.computerId === computerId;

  const tryKind = (kind: PublicationKind): boolean => {
    switch (kind) {
      case "runtime_auth":
        return routeRuntimeAuthPublication(data, config, deps.runtimeAuthIntent.current);
      case "pi_chat":
      case "agent_memory":
      case "agent_skills":
      case "agent_workspace_files_list":
      case "agent_workspace_scan":
      case "agent_workspace_file_read":
      case "agent_workspace_delete":
      case "agent_context_view":
      case "agent_side_ask":
      case "runtime_manage":
        return deps.queries.receiveKind(kind, data, config);
      case "reminder_sync":
        return routePublication(
          data,
          decodeReminderSync,
          (sync) => sync.messageType === REMINDER_SYNC_MESSAGE_TYPE && ownsDaemon(sync),
        );
      case "reminder_due":
      case "stale_runtime_stop":
      case "agent_config_sync":
      case "app_config_sync":
      case "agent_server_features":
        return deps.serverPublications.routeKind(kind, data, scope, deps.readyPublications);
      case "app_registration_notice":
        return routePublication(data, decodeAppRegistrationNotice, (notice) => {
          if (!ownsDaemon(notice)) return false;
          deps.readyPublications.deliver(deps.appRegistrationNotice, notice);
          return true;
        });
      case "agent_migration_lease":
        return routePublication(data, decodeAgentMigrationLease, (lease) => {
          if (!ownsDaemon(lease)) return false;
          deps.readyPublications.deliver(deps.agentMigrationLease, {
            ...lease,
            deadline: Date.now() + lease.expiresInMs,
          });
          return true;
        });
      case "agent_migration_cancel":
        return routePublication(data, decodeAgentMigrationCancel, (cancel) => {
          if (!ownsDaemon(cancel)) return false;
          deps.readyPublications.deliver(deps.agentMigrationCancel, cancel);
          return true;
        });
      case "computer_upgrade":
      case "computer_restart":
        return deps.computerLifecycle.routeKind(kind, data, config, ownsDaemon);
      case "agent_workspace_reset":
        return routePublication(data, decodeAgentWorkspaceResetRequest, (request) => {
          if (request.workspaceId === workspaceId)
            deps.readyPublications.deliver(deps.agentWorkspaceReset, request);
          return true;
        });
      case "usage_scan":
      case "reset_credit":
      case "model_refresh":
      case "effort_read":
        return deps.providerPublications.routeKind(kind, data, workspaceId);
      case "agent_activity_probe":
        return routePublication(data, decodeAgentActivityProbe, (probe) => {
          if (probe.protocolMajor !== 1 || !ownsDaemon(probe)) return false;
          deps.readyPublications.deliver(deps.agentActivityProbe, probe, "probe");
          return true;
        });
      case "agent_inbox_purge":
        return routePublication(data, decodeAgentInboxPurge, (purge) => {
          if (purge.protocolMajor !== 1 || !ownsDaemon(purge)) return false;
          deps.readyPublications.deliver(deps.agentInboxPurge, purge);
          return true;
        });
      case "agent_message": {
        let delivery: AgentMessageDelivery;
        try {
          delivery = decodeAgentMessageDelivery(data);
        } catch {
          return false;
        }
        if (delivery.protocolMajor !== 1 || delivery.workspaceId !== workspaceId) return false;
        try {
          deps.readyPublications.deliver(deps.agentMessage, delivery, "notice");
          return true;
        } catch (error) {
          deliveryErrors ??= new Map();
          deliveryErrors.set("agent_message", error);
          return false;
        }
      }
      case "agent_stop": {
        let intent: AgentStopIntent;
        try {
          intent = decodeAgentStopIntent(data);
        } catch {
          return false;
        }
        if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId) return false;
        try {
          deps.readyPublications.deliver(deps.agentStop, intent, "stop");
          return true;
        } catch (error) {
          deliveryErrors ??= new Map();
          deliveryErrors.set("agent_stop", error);
          return false;
        }
      }
      case "agent_turn_interrupt": {
        let intent: AgentTurnInterruptIntent;
        try {
          intent = decodeAgentTurnInterruptIntent(data);
        } catch {
          return false;
        }
        if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId) return false;
        try {
          if (!deps.readyPublications.holding)
            deps.readyPublications.deliver(deps.agentTurnInterrupt, intent);
          return true;
        } catch (error) {
          deliveryErrors ??= new Map();
          deliveryErrors.set("agent_turn_interrupt", error);
          return false;
        }
      }
      case "agent_start": {
        let intent: AgentStartIntent;
        try {
          intent = decodeAgentStartIntent(data);
        } catch {
          return false;
        }
        if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId) return false;
        try {
          deps.readyPublications.deliver(deps.agentStart, intent, "start");
          return true;
        } catch (error) {
          deliveryErrors ??= new Map();
          deliveryErrors.set("agent_start", error);
          return false;
        }
      }
    }
  };

  let tried: Set<PublicationKind> | undefined;
  let deliveryErrors: Map<PublicationKind, unknown> | undefined;
  for (const kind of scanPublicationKinds(data)) {
    if (tryKind(kind)) return;
    tried ??= new Set();
    tried.add(kind);
  }

  const skip = tried ?? EMPTY_SKIP;
  const handled =
    (!skip.has("runtime_auth") && tryKind("runtime_auth")) ||
    deps.queries.receive(data, config, skip) ||
    (!skip.has("reminder_sync") && tryKind("reminder_sync")) ||
    deps.serverPublications.route(data, scope, deps.readyPublications, skip) ||
    (!skip.has("app_registration_notice") && tryKind("app_registration_notice")) ||
    (!skip.has("agent_migration_lease") && tryKind("agent_migration_lease")) ||
    (!skip.has("agent_migration_cancel") && tryKind("agent_migration_cancel")) ||
    deps.computerLifecycle.route(data, config, ownsDaemon, skip) ||
    (!skip.has("agent_workspace_reset") && tryKind("agent_workspace_reset")) ||
    deps.providerPublications.route(data, workspaceId, skip) ||
    (!skip.has("agent_activity_probe") && tryKind("agent_activity_probe")) ||
    (!skip.has("agent_inbox_purge") && tryKind("agent_inbox_purge"));
  if (handled) return;

  const decoders = [
    {
      kind: "agent_message",
      decode: () => {
        if (deliveryErrors?.has("agent_message")) throw deliveryErrors.get("agent_message");
        deps.readyPublications.deliver(
          deps.agentMessage,
          ownedIntent(decodeAgentMessageDelivery(data), workspaceId),
          "notice",
        );
      },
    },
    {
      kind: "agent_stop",
      decode: () => {
        if (deliveryErrors?.has("agent_stop")) throw deliveryErrors.get("agent_stop");
        const intent = ownedIntent(decodeAgentStopIntent(data), workspaceId);
        deps.readyPublications.deliver(deps.agentStop, intent, "stop");
      },
    },
    {
      kind: "agent_turn_interrupt",
      decode: () => {
        if (deliveryErrors?.has("agent_turn_interrupt"))
          throw deliveryErrors.get("agent_turn_interrupt");
        const intent = ownedIntent(decodeAgentTurnInterruptIntent(data), workspaceId);
        if (!deps.readyPublications.holding)
          deps.readyPublications.deliver(deps.agentTurnInterrupt, intent);
      },
    },
    {
      kind: "agent_start",
      decode: () => {
        if (deliveryErrors?.has("agent_start")) throw deliveryErrors.get("agent_start");
        const intent = ownedIntent(decodeAgentStartIntent(data), workspaceId);
        deps.readyPublications.deliver(deps.agentStart, intent, "start");
      },
    },
  ];
  deps.rejectedControl.decodeFirst(decoders, data, scope);
}

const EMPTY_SKIP: ReadonlySet<PublicationKind> = new Set();
