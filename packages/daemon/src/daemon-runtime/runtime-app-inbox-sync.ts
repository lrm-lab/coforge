import type { AgentAppConfigSync } from "#src/agent-app-config/agent-app-config-sync";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import type { ReminderScheduler } from "#src/agent-reminder/reminder-scheduler";
import type {
  InboxResponse,
  LocalInboxRequest,
  ReminderScope,
  ReminderSync,
} from "@lrm/coforge-sdk/internal";
import { diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type RuntimeAppInboxSyncPorts = {
  transport: () => DaemonConnectionClient;
  appConfigs: AgentAppConfigSync;
  reminders: ReminderScheduler;
  inboxCoordinator: AgentInboxCoordinator;
  env(): Omit<ReminderScope, "agentId">;
  readyRunningAgentIds(): string[];
  launchingAgentIds: Iterable<string>;
};

/** A new connection: asks again for every running Agent's App config. */
export function resyncAppConfigs(ports: RuntimeAppInboxSyncPorts): void {
  ports.appConfigs.connected();
  // A launch in progress asked on the old connection, whose answer is now dropped.
  for (const agentId of new Set([...ports.readyRunningAgentIds(), ...ports.launchingAgentIds]))
    requestAppConfigSnapshot(ports, agentId);
}

/** Asks once per connection for the Agent's App config; the cloud resends on the next one. */
export function requestAppConfigSnapshot(ports: RuntimeAppInboxSyncPorts, agentId: string): void {
  if (!ports.transport().requestAppConfigSnapshot) return;
  void ports.appConfigs.request(agentId).catch((error: unknown) =>
    logger.warn("Asking for an Agent's App config failed; the next connection asks again", {
      event: "agent_app_config:snapshot_failed",
      agent_id: agentId,
      error_code: diagnosticErrorName(error),
    }),
  );
}

export async function requestReminderSnapshot(
  ports: RuntimeAppInboxSyncPorts,
  agentId: string,
): Promise<void> {
  const transport = ports.transport();
  if (!transport.requestSnapshot) return;
  const sync: ReminderSync = await transport.requestSnapshot({ ...ports.env(), agentId });
  await ports.reminders.apply(sync);
}

export function inbox(
  ports: RuntimeAppInboxSyncPorts,
  context: string,
  request: LocalInboxRequest,
): Promise<InboxResponse> {
  return ports.inboxCoordinator.inbox(context, request);
}

export function drainAppInboxNotices(
  ports: RuntimeAppInboxSyncPorts,
  agentId: string,
): Promise<void> {
  return ports.inboxCoordinator.drainAppInboxNotices(agentId);
}
