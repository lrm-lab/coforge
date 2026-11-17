export const PUSH_DISABLED_REASONS = [
  "endpoint_rejected",
  "endpoint_invalid",
  "agent_unavailable",
] as const;
export type PushDisabledReason = (typeof PUSH_DISABLED_REASONS)[number];

export type PushWebhookRow = {
  agentId: string;
  workspaceId: string;
  url: string;
  secretSealed: string;
  enabled: boolean;
  disabledReason: PushDisabledReason | null;
  revision: number;
  lastDeliveryAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  rejectionStreak: number;
  retryAt: Date | null;
  retryNoticeId: string | null;
};

export type PushAgentState = {
  workspaceId: string;
  deletedAt: Date | null;
  stoppedAt: Date | null;
  hosting: string;
};

export type PushAttemptUpdate = {
  lastDeliveryAt?: Date;
  lastError: string | null;
  consecutiveFailures: number;
  rejectionStreak: number;
  retryAt: Date | null;
  retryNoticeId: string | null;
  disabledReason?: PushDisabledReason;
};

export interface PushWebhookStore {
  find(agentId: string): Promise<PushWebhookRow | undefined>;
  save(input: {
    agentId: string;
    workspaceId: string;
    url: string;
    secretSealed: string;
  }): Promise<void>;
  remove(agentId: string): Promise<boolean>;
  deliveryTarget(
    agentId: string,
  ): Promise<{ row: PushWebhookRow; agent: PushAgentState } | undefined>;
  record(agentId: string, revision: number, update: PushAttemptUpdate): Promise<boolean>;
}
