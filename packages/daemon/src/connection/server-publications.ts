import {
  decodeAgentConfigSync,
  decodeAgentServerFeatures,
  decodeAppConfigSync,
  decodeAgentStaleRuntimeStop,
  decodeReminderDue,
  type AgentConfigSync,
  type AgentServerFeatures,
  type AppConfigSync,
  type AgentStaleRuntimeStop,
  type ReminderDue,
} from "@lrm/coforge-sdk/internal";
import { ListenerSlot } from "./listener-slot";
import type { PublicationKind, ServerPublicationKind } from "./publication-routing";
import { ReadyPublicationHold } from "./ready-publication-hold";

export class ServerPublications {
  readonly appConfig = new ListenerSlot<(sync: AppConfigSync) => void>();
  readonly features = new ListenerSlot<(sync: AgentServerFeatures) => void>();
  readonly agentConfig = new ListenerSlot<(sync: AgentConfigSync) => void>();
  readonly staleRuntimeStop = new ListenerSlot<(intent: AgentStaleRuntimeStop) => void>();
  readonly reminderDue = new ListenerSlot<(due: ReminderDue) => void>();

  onAppConfigSync(callback: (sync: AppConfigSync) => void): () => void {
    return this.appConfig.set(callback);
  }

  onAgentServerFeatures(callback: (sync: AgentServerFeatures) => void): () => void {
    return this.features.set(callback);
  }

  onAgentConfigSync(callback: (sync: AgentConfigSync) => void): () => void {
    return this.agentConfig.set(callback);
  }

  onAgentStaleRuntimeStop(callback: (intent: AgentStaleRuntimeStop) => void): () => void {
    return this.staleRuntimeStop.set(callback);
  }

  onReminderDue(callback: (due: ReminderDue) => void): () => void {
    return this.reminderDue.set(callback);
  }

  clear(): void {
    this.appConfig.clear();
    this.features.clear();
    this.agentConfig.clear();
    this.staleRuntimeStop.clear();
    this.reminderDue.clear();
  }

  routeKind(
    kind: ServerPublicationKind,
    data: Uint8Array,
    scope: { workspaceId: string; computerId: string },
    ready: ReadyPublicationHold,
  ): boolean {
    try {
      switch (kind) {
        case "reminder_due": {
          const due = decodeReminderDue(data);
          if (due.workspaceId !== scope.workspaceId || due.computerId !== scope.computerId)
            return false;
          ready.deliver(this.reminderDue, due);
          return true;
        }
        case "stale_runtime_stop": {
          const stop = decodeAgentStaleRuntimeStop(data);
          if (stop.workspaceId !== scope.workspaceId || stop.computerId !== scope.computerId)
            return false;
          ready.deliver(this.staleRuntimeStop, stop, "stale-runtime-stop");
          return true;
        }
        case "agent_config_sync": {
          const config = decodeAgentConfigSync(data);
          if (config.workspaceId !== scope.workspaceId || config.computerId !== scope.computerId)
            return false;
          ready.deliver(this.agentConfig, config, "config");
          return true;
        }
        case "app_config_sync": {
          const sync = decodeAppConfigSync(data);
          if (sync.workspaceId !== scope.workspaceId || sync.computerId !== scope.computerId)
            return false;
          ready.deliver(this.appConfig, sync);
          return true;
        }
        case "agent_server_features": {
          const features = decodeAgentServerFeatures(data);
          if (
            features.workspaceId !== scope.workspaceId ||
            features.computerId !== scope.computerId
          )
            return false;
          ready.deliver(this.features, features);
          return true;
        }
      }
    } catch {
      return false;
    }
  }

  route(
    data: Uint8Array,
    scope: { workspaceId: string; computerId: string },
    ready: ReadyPublicationHold,
    skip?: ReadonlySet<PublicationKind>,
  ): boolean {
    return (
      (!skip?.has("reminder_due") && this.routeKind("reminder_due", data, scope, ready)) ||
      (!skip?.has("stale_runtime_stop") &&
        this.routeKind("stale_runtime_stop", data, scope, ready)) ||
      (!skip?.has("agent_config_sync") &&
        this.routeKind("agent_config_sync", data, scope, ready)) ||
      (!skip?.has("app_config_sync") && this.routeKind("app_config_sync", data, scope, ready)) ||
      (!skip?.has("agent_server_features") &&
        this.routeKind("agent_server_features", data, scope, ready))
    );
  }
}
