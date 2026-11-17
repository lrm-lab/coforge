import type {
  PushAgentState,
  PushAttemptUpdate,
  PushWebhookRow,
  PushWebhookStore,
} from "#src/server/agents/external-push-webhook-store";

export class MemoryPushWebhookStore implements PushWebhookStore {
  rows = new Map<string, PushWebhookRow>();
  agents = new Map<string, PushAgentState>();

  addAgent(agentId: string, over: Partial<PushAgentState> = {}) {
    this.agents.set(agentId, {
      workspaceId: "w1",
      deletedAt: null,
      stoppedAt: null,
      hosting: "external",
      ...over,
    });
  }

  async find(agentId: string) {
    return this.rows.get(agentId);
  }

  async save(input: { agentId: string; workspaceId: string; url: string; secretSealed: string }) {
    const before = this.rows.get(input.agentId);
    this.rows.set(input.agentId, {
      ...input,
      enabled: true,
      disabledReason: null,
      revision: (before?.revision ?? 0) + 1,
      lastDeliveryAt: before?.lastDeliveryAt ?? null,
      lastError: null,
      consecutiveFailures: 0,
      rejectionStreak: 0,
      retryAt: null,
      retryNoticeId: null,
    });
  }

  async remove(agentId: string) {
    return this.rows.delete(agentId);
  }

  async deliveryTarget(agentId: string) {
    const row = this.rows.get(agentId);
    const agent = this.agents.get(agentId);
    return row && agent ? { row, agent } : undefined;
  }

  async record(agentId: string, revision: number, update: PushAttemptUpdate) {
    const row = this.rows.get(agentId);
    if (!row || row.revision !== revision) return false;
    this.rows.set(agentId, {
      ...row,
      lastError: update.lastError,
      consecutiveFailures: update.consecutiveFailures,
      rejectionStreak: update.rejectionStreak,
      retryAt: update.retryAt,
      retryNoticeId: update.retryNoticeId,
      lastDeliveryAt: update.lastDeliveryAt ?? row.lastDeliveryAt,
      ...(update.disabledReason ? { enabled: false, disabledReason: update.disabledReason } : {}),
    });
    return true;
  }
}
