import { getCodexCompatibleCapabilityLease } from "#src/server/agents/codex-compatible-capability.server";
import { getAgentMemoryCapabilityLease } from "./agent-memory-results.server";
import { getAgentMigrationCapabilityLease } from "#src/server/agent-migrations/agent-migration-capability.server";
import { getAppRegistrationNoticeCapabilityLease } from "#src/server/apps/app-registration-notice-capability.server";
import { getReminderCapabilityLease } from "#src/server/reminders/reminder-capability.server";
import { getAppConfigCapabilityLease } from "#src/server/agent-app-configs/app-config-capability.server";
import { getAgentTurnInterruptCapabilityLease } from "#src/server/agents/agent-turn-interrupt-capability.server";
import { getAgentControlAcceptedCapabilityLease } from "#src/server/agents/agent-control-accepted-capability.server";
import { getAgentSessionRejectionCapabilityLease } from "#src/server/agents/agent-session-rejection-capability.server";
import { getAgentConfigCapabilityLease } from "#src/server/agents/agent-config-capability.server";
import {
  getRuntimeAuthCapabilityLease,
  getRuntimeAuthStatusReadCapabilityLease,
  getKiroIdentityCenterCapabilityLease,
} from "#src/server/computers/runtime-auth-capability.server";
import {
  getPiChatCapabilityLease,
  getPiChatControlsLease,
  getPiChatFilesLease,
  getWorkbenchCodexLease,
} from "#src/server/pi-chat/pi-chat-capability.server";
import { getResetCreditCapabilityLease } from "#src/server/computers/reset-credit-capability.server";
import { getAgentUsageCapabilityLease } from "#src/server/computers/agent-usage-capability.server";
import { getAgentContextViewCapabilityLease } from "#src/server/computers/agent-context-view-capability.server";
import { getAgentSideAskCapabilityLease } from "#src/server/computers/agent-side-ask-capability.server";
import { getRuntimeManageCapabilityLease } from "#src/server/computers/runtime-manage-capability.server";

export function daemonCapabilityLeases() {
  const reminderLease = getReminderCapabilityLease();
  const agentUsageLease = getAgentUsageCapabilityLease();
  const leases = [
    reminderLease,
    getAgentMemoryCapabilityLease(),
    getAgentMigrationCapabilityLease(),
    getAppConfigCapabilityLease(),
    getAppRegistrationNoticeCapabilityLease(),
    getAgentTurnInterruptCapabilityLease(),
    getAgentControlAcceptedCapabilityLease(),
    getAgentSessionRejectionCapabilityLease(),
    getAgentConfigCapabilityLease(),
    getCodexCompatibleCapabilityLease(),
    getRuntimeAuthCapabilityLease(),
    getRuntimeAuthStatusReadCapabilityLease(),
    getKiroIdentityCenterCapabilityLease(),
    getPiChatCapabilityLease(),
    getPiChatControlsLease(),
    getPiChatFilesLease(),
    getWorkbenchCodexLease(),
    getAgentContextViewCapabilityLease(),
    getAgentSideAskCapabilityLease(),
    getRuntimeManageCapabilityLease(),
    getResetCreditCapabilityLease(),
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
          [...leases, agentUsageLease].map((lease) =>
            lease.record(workspaceId, computerId, capabilities, identity),
          ),
        ),
      refresh: async (
        workspaceId: string,
        computerId: string,
        identity?: { workerInstanceId: string; startedAt: number },
      ) => {
        const active = identity ? [...leases, agentUsageLease] : leases;
        await Promise.all(active.map((lease) => lease.refresh(workspaceId, computerId, identity)));
      },
    },
  };
}
