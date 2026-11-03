import { getAgentMigrationCapabilityLease } from "#src/server/agent-migrations/agent-migration-capability.server";
import { getAppRegistrationNoticeCapabilityLease } from "#src/server/apps/app-registration-notice-capability.server";
import { getReminderCapabilityLease } from "#src/server/reminders/reminder-capability.server";
import { getAppConfigCapabilityLease } from "#src/server/agent-app-configs/app-config-capability.server";
import { getAgentTurnInterruptCapabilityLease } from "#src/server/agents/agent-turn-interrupt-capability.server";
import {
  getRuntimeAuthCapabilityLease,
  getRuntimeAuthStatusReadCapabilityLease,
  getKiroIdentityCenterCapabilityLease,
} from "#src/server/computers/runtime-auth-capability.server";
import {
  getPiChatCapabilityLease,
  getPiChatControlsLease,
  getPiChatFilesLease,
} from "#src/server/pi-chat/pi-chat-capability.server";
import { getLocalSessionHandoffCapabilityLease } from "#src/server/computers/local-session-capability.server";
import { getComputerFileUploadCapabilityLease } from "#src/server/computers/computer-file-upload-capability.server";

/** Every ready and heartbeat updates the same set of feature capability leases. */
export function daemonCapabilityLeases() {
  const reminderLease = getReminderCapabilityLease();
  const leases = [
    reminderLease,
    getAgentMigrationCapabilityLease(),
    getAppConfigCapabilityLease(),
    getAppRegistrationNoticeCapabilityLease(),
    getAgentTurnInterruptCapabilityLease(),
    getRuntimeAuthCapabilityLease(),
    getRuntimeAuthStatusReadCapabilityLease(),
    getKiroIdentityCenterCapabilityLease(),
    getPiChatCapabilityLease(),
    getPiChatControlsLease(),
    getPiChatFilesLease(),
    getLocalSessionHandoffCapabilityLease(),
    getComputerFileUploadCapabilityLease(),
  ];
  return {
    reminderLease,
    capabilityLeases: {
      record: (
        workspaceId: string,
        computerId: string,
        capabilities: readonly string[],
        identity: { workerInstanceId: string; startedAt: number },
      ) =>
        Promise.all(
          leases.map((lease) => lease.record(workspaceId, computerId, capabilities, identity)),
        ),
      refresh: async (
        workspaceId: string,
        computerId: string,
        identity?: { workerInstanceId: string; startedAt: number },
      ) => {
        await Promise.all(leases.map((lease) => lease.refresh(workspaceId, computerId, identity)));
      },
    },
  };
}
