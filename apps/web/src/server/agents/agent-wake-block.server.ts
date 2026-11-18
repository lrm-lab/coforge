import type { PrismaClient } from "#src/generated/prisma/client";

export type AgentWakeBlockReason = "stopped" | "start_failed" | "operation_in_flight";

const REASONS: readonly AgentWakeBlockReason[] = ["stopped", "start_failed", "operation_in_flight"];

const SETTLED_PHASES: readonly string[] = ["completed", "failed"];

const TRANSIENT_BLOCK_MS = 24 * 60 * 60 * 1_000;

export type AgentWakeBlock = {
  reason: AgentWakeBlockReason;
  messageCount: number;
  at: Date;
};

export type AgentWakeBlockWriter = {
  record(agentId: string, reason: AgentWakeBlockReason, roundStartedAt?: Date): Promise<void>;
};

export type AgentWakeBlockRow = {
  wakeBlockedReason: string | null;
  wakeBlockedCount: number;
  wakeBlockedAt: Date | null;
};

export class PrismaAgentWakeBlocks implements AgentWakeBlockWriter {
  constructor(private readonly db: PrismaClient) {}

  async record(
    agentId: string,
    reason: AgentWakeBlockReason,
    roundStartedAt?: Date,
  ): Promise<void> {
    const round = roundStartedAt ?? null;
    await this.db.$executeRaw`
      UPDATE "agents"
         SET "wakeBlockedReason" = ${reason},
             "wakeBlockedCount" = CASE
               WHEN "wakeBlockedReason" = ${reason}
                AND (${round}::timestamp IS NULL OR "wakeBlockedAt" >= ${round}::timestamp)
                 THEN "wakeBlockedCount" + 1
               ELSE 1
             END,
             "wakeBlockedAt" = now()
       WHERE "id" = ${agentId}::uuid`;
  }
}

export function agentWakeBlockReason(
  value: string | null | undefined,
): AgentWakeBlockReason | null {
  return REASONS.find((reason) => reason === value) ?? null;
}

export function agentWakeBlock(
  row: AgentWakeBlockRow,
  state: {
    stopped: boolean;
    stoppedAt?: Date | null;
    controlPhase?: string;
    now?: number;
  },
): AgentWakeBlock | null {
  const reason = agentWakeBlockReason(row.wakeBlockedReason);
  const at = row.wakeBlockedAt;
  if (!reason || !at || row.wakeBlockedCount <= 0) return null;
  const recent = (state.now ?? Date.now()) - at.getTime() <= TRANSIENT_BLOCK_MS;
  const holds =
    reason === "stopped"
      ? state.stopped && (!state.stoppedAt || at >= state.stoppedAt)
      : reason === "start_failed"
        ? state.controlPhase === "failed" && recent
        : recent &&
          state.controlPhase !== undefined &&
          !SETTLED_PHASES.includes(state.controlPhase);
  return holds ? { reason, messageCount: row.wakeBlockedCount, at } : null;
}
