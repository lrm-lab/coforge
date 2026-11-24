import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import type { AgentTokenUsageBucketSlice } from "#src/features/agents/agent-token-usage-model";

export type AgentTokenUsageTurnInput = Readonly<{
  workspaceId: string;
  agentId: string;
  computerId?: string | null;
  launchId: string;
  sessionId?: string | null;
  turnSeq: number;
  provider: RuntimeProvider;
  model: string;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number | null;
  contextUsedTokens?: number | null;
  contextWindowTokens?: number | null;
  recordedAt: Date;
}>;

export interface AgentTokenUsageRepository {
  recordTurn(input: AgentTokenUsageTurnInput): Promise<void>;
  aggregateTurnsInRange(scope: {
    workspaceId: string;
    agentId: string;
    since: Date;
    timeZone: string;
    byHour: boolean;
  }): Promise<AgentTokenUsageBucketSlice[]>;
  findEarliestRecordedAt(scope: { workspaceId: string; agentId: string }): Promise<Date | null>;
}

type RawAggregatedSlice = {
  date_key: string;
  hour: number | null;
  provider: string;
  model: string;
  turns: number;
  uncached_input_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  output_tokens: string;
  context_used_tokens: number | null;
  context_window_tokens: number | null;
  context_recorded_at: Date | null;
};

function toSafeNumber(value: bigint): number {
  const clamped = value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value;
  return Number(clamped < 0n ? 0n : clamped);
}

export class PrismaAgentTokenUsageRepository implements AgentTokenUsageRepository {
  constructor(private readonly db: PrismaClient) {}

  async recordTurn(input: AgentTokenUsageTurnInput): Promise<void> {
    await this.db.agentTokenUsageTurn.createMany({
      data: [
        {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          computerId: input.computerId ?? null,
          launchId: input.launchId,
          sessionId: input.sessionId ?? null,
          turnSeq: input.turnSeq,
          provider: input.provider,
          model: input.model,
          uncachedInputTokens: BigInt(input.uncachedInputTokens),
          cacheReadTokens: BigInt(input.cacheReadTokens),
          cacheWriteTokens: BigInt(input.cacheWriteTokens),
          outputTokens: BigInt(input.outputTokens),
          reasoningOutputTokens:
            input.reasoningOutputTokens != null ? BigInt(input.reasoningOutputTokens) : null,
          contextUsedTokens: input.contextUsedTokens ?? null,
          contextWindowTokens: input.contextWindowTokens ?? null,
          recordedAt: input.recordedAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  async aggregateTurnsInRange(scope: {
    workspaceId: string;
    agentId: string;
    since: Date;
    timeZone: string;
    byHour: boolean;
  }): Promise<AgentTokenUsageBucketSlice[]> {
    const rows = await this.db.$queryRaw<RawAggregatedSlice[]>(Prisma.sql`
      SELECT
        to_char(local_ts, 'YYYY-MM-DD') AS date_key,
        CASE WHEN ${scope.byHour} THEN EXTRACT(HOUR FROM local_ts)::int ELSE NULL END AS hour,
        provider,
        model,
        COUNT(*)::int AS turns,
        COALESCE(SUM(uncached_input_tokens), 0)::text AS uncached_input_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
        COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
        (ARRAY_AGG(context_used_tokens ORDER BY recorded_at DESC)
          FILTER (WHERE context_used_tokens IS NOT NULL AND context_window_tokens IS NOT NULL AND context_window_tokens > 0))[1] AS context_used_tokens,
        (ARRAY_AGG(context_window_tokens ORDER BY recorded_at DESC)
          FILTER (WHERE context_used_tokens IS NOT NULL AND context_window_tokens IS NOT NULL AND context_window_tokens > 0))[1] AS context_window_tokens,
        MAX(recorded_at)
          FILTER (WHERE context_used_tokens IS NOT NULL AND context_window_tokens IS NOT NULL AND context_window_tokens > 0) AS context_recorded_at
      FROM (
        SELECT
          provider,
          model,
          uncached_input_tokens,
          cache_read_tokens,
          cache_write_tokens,
          output_tokens,
          context_used_tokens,
          context_window_tokens,
          recorded_at,
          (recorded_at AT TIME ZONE 'UTC') AT TIME ZONE ${scope.timeZone} AS local_ts
        FROM agent_token_usage_turns
        WHERE workspace_id = ${scope.workspaceId}::uuid
          AND agent_id = ${scope.agentId}::uuid
          AND recorded_at >= ${scope.since}
      ) t
      GROUP BY 1, 2, 3, 4
      ORDER BY 1 ASC, 2 ASC NULLS FIRST
    `);

    return rows.map((row) => ({
      dateKey: row.date_key,
      hour: row.hour,
      provider: row.provider,
      model: row.model,
      turns: Number(row.turns),
      uncachedInputTokens: toSafeNumber(BigInt(row.uncached_input_tokens)),
      cacheReadTokens: toSafeNumber(BigInt(row.cache_read_tokens)),
      cacheWriteTokens: toSafeNumber(BigInt(row.cache_write_tokens)),
      outputTokens: toSafeNumber(BigInt(row.output_tokens)),
      contextUsedTokens: row.context_used_tokens,
      contextWindowTokens: row.context_window_tokens,
      contextRecordedAt: row.context_recorded_at ? new Date(row.context_recorded_at) : null,
    }));
  }

  async findEarliestRecordedAt(scope: {
    workspaceId: string;
    agentId: string;
  }): Promise<Date | null> {
    const row = await this.db.agentTokenUsageTurn.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        agentId: scope.agentId,
      },
      orderBy: { recordedAt: "asc" },
      select: { recordedAt: true },
    });
    return row?.recordedAt ?? null;
  }
}
