import type { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { AgentFeatureSync } from "./agent-feature-sync";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentOfflineResidency } from "./agent-offline-residency";
import type { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import type { ProcJobManager } from "#src/proc-jobs/proc-job-manager";
import type { ProviderQuotaState } from "./provider-quota-state";

export function forgetAgent(
  agentId: string,
  contextViewEnabled: Map<string, boolean>,
  contextViewService: Pick<AgentContextViewService, "disable">,
  inboxCoordinator: AgentInboxCoordinator,
  systemCleaner: SystemCleaner,
  offlineResidency: AgentOfflineResidency,
  messageAttention: AgentMessageAttentionIndex,
  consumedSeqs: AgentConsumedSeqStore,
  featureSync: AgentFeatureSync,
  dropOwedRecovery: (agentId: string) => void,
  procJobs?: Pick<ProcJobManager, "forgetAgent">,
  quotaState?: Pick<ProviderQuotaState, "forgetAgent">,
): void {
  dropOwedRecovery(agentId);
  quotaState?.forgetAgent(agentId);
  contextViewEnabled.delete(agentId);
  contextViewService.disable(agentId);
  void procJobs?.forgetAgent(agentId, "agent_deleted").catch(() => {});
  inboxCoordinator.forgetAgent(agentId, {
    systemCleaner,
    offlineResidency,
    messageAttention,
    consumedSeqs,
    featureSync,
  });
}
