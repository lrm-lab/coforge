import type {
  AgentActivityProbe,
  AgentConfigSync,
  AgentInboxPurge,
  AgentMessageDelivery,
  AgentStartIntent,
  AgentStopIntent,
  AgentTurnInterruptIntent,
  AgentWorkspaceResetRequest,
} from "@lrm/coforge-sdk/internal";
import { acceptAppRegistrationNotice } from "#src/agent-app-inbox/app-registration-notice";
import type { MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import type { AgentFeatureSync } from "./agent-feature-sync";
import { controlPublications, type AgentControlIntentPorts } from "./runtime-agent-flows";
import type { DaemonRuntimeLifecycle } from "./runtime-lifecycle";
import type { RuntimeStartupPorts } from "./runtime-startup";
import { migrationRoute, type RuntimeServices } from "./runtime-services-composition";

export type RuntimeStartupPublicationHandlers = Readonly<{
  handleAgentStart(intent: AgentStartIntent): Promise<unknown>;
  handleAgentStop(intent: AgentStopIntent): Promise<void>;
  handleAgentConfig(sync: AgentConfigSync): Promise<void>;
  handleAgentTurnInterrupt(intent: AgentTurnInterruptIntent): Promise<void>;
  handleAgentActivityProbe(probe: AgentActivityProbe): Promise<void>;
  handleAgentInboxPurge(purge: AgentInboxPurge): void;
  handleAgentWorkspaceReset(request: AgentWorkspaceResetRequest): Promise<void>;
  handleAgentMessage(message: AgentMessageDelivery): Promise<void>;
  stop(): Promise<void>;
  mintAppItem(agentId: string, item: MintAppItem): Promise<unknown>;
}>;

export type RuntimeStartupPublicationsDeps = Readonly<{
  handlers: RuntimeStartupPublicationHandlers;
  controlIntentPorts(): AgentControlIntentPorts;
  lifecycle: Pick<DaemonRuntimeLifecycle, "connectionRefused">;
  services: Pick<RuntimeServices, "reminders" | "appConfigs" | "migrations">;
  sync: Pick<AgentFeatureSync, "applyServerFeatures">;
  readyRunningAgentIds(): string[];
}>;

export function startupPublications(
  deps: RuntimeStartupPublicationsDeps,
): RuntimeStartupPorts["publications"] {
  const { handlers } = deps;
  return {
    startAgent: (intent) => handlers.handleAgentStart(intent),
    stopAgent: (intent) => handlers.handleAgentStop(intent),
    ...controlPublications(() => deps.controlIntentPorts()),
    applyAgentConfigSync: (sync) => handlers.handleAgentConfig(sync),
    interruptAgent: (intent) => handlers.handleAgentTurnInterrupt(intent),
    probeAgent: (probe) => handlers.handleAgentActivityProbe(probe),
    purgeAgentInbox: (purge) => handlers.handleAgentInboxPurge(purge),
    resetWorkspace: (request) => handlers.handleAgentWorkspaceReset(request),
    deliverMessage: (message) => handlers.handleAgentMessage(message),
    stopRuntime: () => handlers.stop(),
    connectionRefused: (reason) => deps.lifecycle.connectionRefused?.(reason),
    receiveReminderDue: (due) => deps.services.reminders.receive(due),
    applyAppConfigSync: (sync) => deps.services.appConfigs.apply(sync),
    applyAgentServerFeatures: (sync) => deps.sync.applyServerFeatures(sync),
    acceptAppRegistrationNotice: (notice) =>
      acceptAppRegistrationNotice(notice, {
        isRunning: (agentId) => deps.readyRunningAgentIds().includes(agentId),
        mint: (agentId, item) => handlers.mintAppItem(agentId, item),
      }).then(() => {}),
    migration: migrationRoute(deps.services.migrations),
  };
}
