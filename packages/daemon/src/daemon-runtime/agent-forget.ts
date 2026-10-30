import type { AgentAppInbox } from "#src/agent-app-inbox/agent-app-inbox";
import type { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";
import type { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import type { AgentOfflineResidency } from "#src/daemon-runtime/agent-offline-residency";
import type { SystemCleaner } from "#src/system-cleaner/system-cleaner";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";

/** The local footprint one Agent leaves on this Computer. `DaemonRuntime` hands every store the
 * Agent touches; forgetting it clears each so nothing of the Agent survives its delete or move. */
export interface AgentLocalFootprint {
  systemCleaner: SystemCleaner;
  offlineResidency: AgentOfflineResidency;
  agentInboxes: Map<string, AgentInboxStateMachine>;
  messageAttention: AgentMessageAttentionIndex;
  consumedSeqs: AgentConsumedSeqStore;
  appInboxes: Map<string, Promise<AgentAppInbox>>;
}

/** The Agent no longer lives on this Computer — its workspace was deleted or it moved away — so
 * every local trace goes: its cursor ledger closes and leaves the state directory, its attention
 * state and outstanding notices end, and its open inboxes are dropped. */
export function forgetLocalAgent(agentId: string, footprint: AgentLocalFootprint): void {
  footprint.systemCleaner.replaceOwnerSnapshot(agentId, null);
  footprint.offlineResidency.forget(agentId);
  footprint.agentInboxes.delete(agentId);
  footprint.messageAttention.clearAgent(agentId, { cancelNotices: true });
  footprint.consumedSeqs.remove(agentId);
  // An open still in flight may reject after the delete; keep that rejection handled.
  footprint.appInboxes.get(agentId)?.catch(() => {});
  footprint.appInboxes.delete(agentId);
}
