import type { DaemonRuntime } from "./runtime";
import type { RuntimeStartupPorts } from "./runtime-startup";
import type { AgentFeatureSync } from "./agent-feature-sync";
import { type RuntimeServices, migrationRoute } from "./runtime-services-composition";
import { acceptAppRegistrationNotice } from "#src/agent-app-inbox/app-registration-notice";
import { controlPublications, type AgentControlIntentPorts } from "./runtime-agent-flows";

type PublicationRuntime = Pick<
  DaemonRuntime,
  | "handleAgentStart"
  | "handleAgentStop"
  | "handleAgentConfig"
  | "handleAgentTurnInterrupt"
  | "handleAgentActivityProbe"
  | "handleAgentInboxPurge"
  | "handleAgentWorkspaceReset"
  | "handleAgentMessage"
  | "stop"
  | "mintAppItem"
>;

export function runtimePublicationHandlers(
  runtime: PublicationRuntime,
  services: RuntimeServices,
  features: AgentFeatureSync,
  control: () => AgentControlIntentPorts,
  running: () => string[],
  connectionRefused: RuntimeStartupPorts["publications"]["connectionRefused"],
): RuntimeStartupPorts["publications"] {
  return {
    startAgent: (intent) => runtime.handleAgentStart(intent),
    stopAgent: (intent) => runtime.handleAgentStop(intent),
    ...controlPublications(control),
    applyAgentConfigSync: (sync) => runtime.handleAgentConfig(sync),
    interruptAgent: (intent) => runtime.handleAgentTurnInterrupt(intent),
    probeAgent: (probe) => runtime.handleAgentActivityProbe(probe),
    purgeAgentInbox: (purge) => runtime.handleAgentInboxPurge(purge),
    resetWorkspace: (request) => runtime.handleAgentWorkspaceReset(request),
    deliverMessage: (message) => runtime.handleAgentMessage(message),
    stopRuntime: () => runtime.stop(),
    connectionRefused,
    receiveReminderDue: (due) => services.reminders.receive(due),
    applyAppConfigSync: (sync) => services.appConfigs.apply(sync),
    applyAgentServerFeatures: (sync) => features.applyServerFeatures(sync),
    acceptAppRegistrationNotice: (notice) =>
      acceptAppRegistrationNotice(notice, {
        isRunning: (agentId) => running().includes(agentId),
        mint: (agentId, item) => runtime.mintAppItem(agentId, item),
      }).then(() => {}),
    migration: migrationRoute(services.migrations),
  };
}
