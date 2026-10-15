import type { PrismaClient, Prisma } from "#src/generated/prisma/client";
import {
  MEMORY_DISPOSITION_TOOL,
  type MemoryCitation,
  type MemoryDispositionRecord,
  type MemoryHintDelivery,
} from "@lrm/coforge-sdk/agent";
import type {
  MemoryDispositionStore,
  MemoryDispositionTransaction,
  MemoryHintSource,
} from "#src/server/workspace-memory/memory-dispositions.server";

export class PrismaMemoryDispositionStore implements MemoryDispositionStore {
  constructor(private readonly db: PrismaClient) {}

  async prepare(input: {
    workspaceId: string;
    operationId: string;
    targetAgentId: string;
    memoryAgentId: string;
    conversationId: string;
    body: string;
    citations: readonly MemoryCitation[];
    ttlMilliseconds: number;
  }): Promise<MemoryHintDelivery> {
    if (
      !Number.isSafeInteger(input.ttlMilliseconds) ||
      input.ttlMilliseconds <= 0 ||
      input.ttlMilliseconds > 2_147_483_647
    )
      throw new Error("Memory Hint TTL must be explicitly configured in milliseconds");
    const bodyHash = new Bun.CryptoHasher("sha256").update(input.body).digest("hex");
    const sources = [
      ...new Map(
        input.citations.map((source) => [
          source.citationId,
          {
            citationId: source.citationId,
            accountId: source.accountId,
            uri: source.uri,
            ...(source.contentHash ? { contentHash: source.contentHash } : {}),
            ...(source.contentVersion ? { contentVersion: source.contentVersion } : {}),
          },
        ]),
      ).values(),
    ];
    const row = await this.db.memoryHintRecord.upsert({
      where: {
        workspaceId_operationId: { workspaceId: input.workspaceId, operationId: input.operationId },
      },
      create: {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        targetAgentId: input.targetAgentId,
        memoryAgentId: input.memoryAgentId,
        conversationId: input.conversationId,
        bodyHash,
        sources,
        ttlMilliseconds: input.ttlMilliseconds,
      },
      update: {},
    });
    if (
      row.targetAgentId !== input.targetAgentId ||
      row.memoryAgentId !== input.memoryAgentId ||
      row.conversationId !== input.conversationId ||
      row.bodyHash !== bodyHash ||
      sourceIdentity(row.sources as MemoryHintSource[]) !== sourceIdentity(sources)
    )
      throw new Error("Memory Hint operation replay conflict");
    return { hint_id: row.id, tool: MEMORY_DISPOSITION_TOOL };
  }

  async withHint<T>(
    workspaceId: string,
    hintId: string,
    action: (transaction: MemoryDispositionTransaction) => Promise<T>,
  ): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hintId))
      return action({
        hint: null,
        latest: null,
        async append() {
          throw new Error("Hint not found");
        },
      });
    return this.db.$transaction(
      async (tx) => {
        // PostgreSQL row locking is required: separate daemon/server processes must
        // serialize authentication, replay/TTL checks, ACL checks, and append together.
        await tx.$queryRaw`SELECT id FROM memory_hint_records
        WHERE workspace_id = ${workspaceId}::uuid AND id = ${hintId}::uuid FOR UPDATE`;
        const row = await tx.memoryHintRecord.findFirst({ where: { workspaceId, id: hintId } });
        const latest = row
          ? await tx.memoryDispositionEvent.findFirst({
              where: { workspaceId, hintId },
              orderBy: { sequence: "desc" },
            })
          : null;
        return action({
          hint: row
            ? {
                id: row.id,
                targetAgentId: row.targetAgentId,
                deliveredAt: row.deliveredAt,
                expiresAt: row.expiresAt ?? new Date(0),
                sources: row.sources as MemoryHintSource[],
              }
            : null,
          latest: latest
            ? {
                hint_id: latest.hintId,
                target_agent_id: latest.targetAgentId,
                decision: latest.decision as MemoryDispositionRecord["decision"],
                reason: latest.reason,
                intended_action_refs: latest.intendedActionRefs,
                decided_at: latest.decidedAt.toISOString(),
                skipped_source_refs: latest.skippedSourceRefs,
              }
            : null,
          async append(record, sources) {
            await tx.memoryDispositionEvent.create({
              data: {
                workspaceId,
                hintId,
                sequence: (latest?.sequence ?? 0) + 1,
                targetAgentId: record.target_agent_id,
                decision: record.decision,
                reason: record.reason,
                intendedActionRefs: record.intended_action_refs,
                skippedSourceRefs: record.skipped_source_refs,
                decidedAt: new Date(record.decided_at),
                citations: {
                  create: sources.map((source) => ({
                    citationId: source.citationId,
                    role: record.decision === "reject" ? "rejected" : "considered",
                    source: source as Prisma.InputJsonValue,
                  })),
                },
              },
            });
          },
        });
      },
      { timeout: 30_000 },
    );
  }
}

function sourceIdentity(sources: readonly MemoryHintSource[]): string {
  return JSON.stringify(
    sources
      .map((source) => [
        source.citationId,
        source.accountId,
        source.uri,
        source.contentHash ?? null,
        source.contentVersion ?? null,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
