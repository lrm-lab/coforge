import { getAgentMigrationCapabilityLease } from "#src/server/agent-migrations/agent-migration-capability.server";
import { getReminderCapabilityLease } from "#src/server/reminders/reminder-capability.server";
import { getAppConfigCapabilityLease } from "#src/server/agent-app-configs/app-config-capability.server";
import { getPiChatCapabilityLease } from "#src/server/pi-chat/pi-chat-capability.server";

/** Every ready and heartbeat updates the same set of feature capability leases. */
export function daemonCapabilityLeases() {
  const reminderLease = getReminderCapabilityLease();
  const leases = [
    reminderLease,
    getAgentMigrationCapabilityLease(),
    getAppConfigCapabilityLease(),
    getPiChatCapabilityLease(),
  ];
  return {
    reminderLease,
    capabilityLeases: {
      record: (workspaceId: string, computerId: string, capabilities: readonly string[]) =>
        Promise.all(leases.map((lease) => lease.record(workspaceId, computerId, capabilities))),
      refresh: async (workspaceId: string, computerId: string) => {
        await Promise.all(leases.map((lease) => lease.refresh(workspaceId, computerId)));
      },
    },
  };
}
