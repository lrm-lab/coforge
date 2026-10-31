import { Prisma } from "#src/generated/prisma/client";
import { liveDeliverySql } from "./agent-attention-deliveries.repositories.server";

export {
  liveDeliverySql,
  NOTIFIED_AGENT_WHERE,
  pendingDeliveryWhere,
  unreadAgentMessagesFragment,
} from "./agent-attention-deliveries.repositories.server";

/**
 * An Agent's attention rule: which messages it still owes attention to, as the Prisma filters and
 * the SQL that the direct-conversation repository's recovery, drain, pending-context and delivery
 * reads share, so those reads cannot drift apart. The raw SQL names the tables and columns Prisma
 * maps the models to (`@@map`), which a migration must keep in step. The human counterpart is
 * `server/conversations/human-unread.server.ts`; the delivery-side filters and the unread-message
 * fragment live in `agent-attention-deliveries.repositories.server.ts`.
 */
/**
 * One target an Agent owes attention in: above `afterSequence` (no bound when absent), less
 * `excludeSequences` (the messages the Agent reported it was shown one by one, `seenExactSeqs`),
 * and never the Agent's own messages (`ownMemberId`; they count as seen).
 */
export type AgentAttentionScope = {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  isChannel: boolean;
  afterSequence?: number;
  excludeSequences?: readonly number[];
  ownMemberId?: string;
};

/**
 * The messages of one target the Agent owes attention to, as the `FROM … WHERE` of a statement
 * whose rows are `m`. A message counts when a user sent it or it was delivered to the Agent, and in
 * a channel only when delivered: a channel message the Agent was not addressed by is not its
 * attention to owe (`(human ∨ delivered) ∧ delivered` is exactly `delivered`, which keeps the
 * channel case strict while a DM's Agent-authored handoff still counts through its delivery row).
 *
 * A channel's top level reads the Agent's delivery rows (`agentId, conversationId, sequence`
 * index) instead of walking the channel's history and probing every message for a delivery. A
 * thread and a direct message read the target's own messages: the delivery index cannot narrow to
 * one thread. The exclusion is one array parameter, so the statement has the same shape and one
 * bind however many sequences the Agent reports; sequences at or below the lower bound are left out
 * of it, since the bound already excludes them.
 */
function agentAttentionSource(scope: AgentAttentionScope) {
  const readsDeliveries = scope.isChannel && scope.threadRootId === null;
  const sequence = readsDeliveries ? Prisma.raw(`d."sequence"`) : Prisma.raw(`m."sequence"`);
  const lower = scope.afterSequence ?? 0;
  const excluded = scope.excludeSequences?.filter((value) => value > lower) ?? [];
  const bounds = Prisma.sql`${
    scope.afterSequence !== undefined
      ? Prisma.sql` AND ${sequence} > ${scope.afterSequence}`
      : Prisma.empty
  }${excluded.length ? Prisma.sql` AND ${sequence} <> ALL(${excluded}::int[])` : Prisma.empty}${
    scope.ownMemberId
      ? Prisma.sql` AND m."senderMemberId" IS DISTINCT FROM ${scope.ownMemberId}::uuid`
      : Prisma.empty
  }`;
  if (readsDeliveries)
    return {
      sequence,
      from: Prisma.sql`FROM "agent_message_deliveries" d
        JOIN "messages" m ON m."id" = d."messageId" AND m."threadRootId" IS NULL
        WHERE d."agentId" = ${scope.agentId}::uuid AND d."conversationId" = ${scope.conversationId}::uuid
          AND ${liveDeliverySql("d")}${bounds}`,
    };
  const delivered = Prisma.sql`EXISTS (SELECT 1 FROM "agent_message_deliveries" d
    WHERE d."messageId" = m."id" AND d."agentId" = ${scope.agentId}::uuid AND ${liveDeliverySql("d")})`;
  return {
    sequence,
    from: Prisma.sql`FROM "messages" m
      WHERE m."conversationId" = ${scope.conversationId}::uuid AND ${
        scope.threadRootId
          ? Prisma.sql`m."threadRootId" = ${scope.threadRootId}::uuid`
          : Prisma.sql`m."threadRootId" IS NULL`
      }${bounds}
        AND (EXISTS (SELECT 1 FROM "conversation_members" sm
          WHERE sm."id" = m."senderMemberId" AND sm."userId" IS NOT NULL) OR ${delivered})${
            scope.isChannel ? Prisma.sql` AND ${delivered}` : Prisma.empty
          }`,
  };
}

/** The ids of the `take` newest messages of an attention scope, newest first. */
export function agentAttentionIdsSql(scope: AgentAttentionScope, take: number) {
  const { sequence, from } = agentAttentionSource(scope);
  return Prisma.sql`SELECT m."id" ${from} ORDER BY ${sequence} DESC LIMIT ${take}`;
}

/** How many messages an attention scope holds, as `{ count }`. */
export function agentAttentionCountSql(scope: AgentAttentionScope) {
  return Prisma.sql`SELECT COUNT(*)::int AS "count" ${agentAttentionSource(scope).from}`;
}

/** The newest sequence in an attention scope, as `{ max }` (`null` when it holds nothing). */
export function agentAttentionMaxSql(scope: AgentAttentionScope) {
  const { sequence, from } = agentAttentionSource(scope);
  return Prisma.sql`SELECT MAX(${sequence})::int AS "max" ${from}`;
}

/**
 * A target's first-touch window (the target's newest rows): the `take` newest of the messages the
 * Agent owes attention to and its own messages, as `{ id, sequence, seen }`, newest first. The
 * scope's `ownMemberId` is the Agent's member; `seen` marks the Agent's own messages and the
 * scope's excluded sequences.
 * Each half is its own index range, so the window never walks a channel's history.
 */
export function agentRecentContextSql(scope: AgentAttentionScope, take: number) {
  const attention = agentAttentionSource({
    ...scope,
    afterSequence: undefined,
    excludeSequences: undefined,
  });
  const excluded = scope.excludeSequences?.length ? [...scope.excludeSequences] : [];
  const others = Prisma.sql`(SELECT m."id", ${attention.sequence} AS "sequence",
      ${attention.sequence} = ANY(${excluded}::int[]) AS "seen"
    ${attention.from} ORDER BY ${attention.sequence} DESC LIMIT ${take})`;
  // No member of the Agent's own: the window is the attention half alone, already ordered and
  // bounded (an ORDER BY outside the parenthesized select is not valid SQL).
  if (!scope.ownMemberId) return Prisma.sql`${others}`;
  const own = Prisma.sql`(SELECT o."id", o."sequence", TRUE AS "seen" FROM "messages" o
    WHERE o."conversationId" = ${scope.conversationId}::uuid AND ${
      scope.threadRootId
        ? Prisma.sql`o."threadRootId" = ${scope.threadRootId}::uuid`
        : Prisma.sql`o."threadRootId" IS NULL`
    } AND o."senderMemberId" = ${scope.ownMemberId}::uuid
    ORDER BY o."sequence" DESC LIMIT ${take})`;
  return Prisma.sql`${others} UNION ALL ${own} ORDER BY "sequence" DESC LIMIT ${take}`;
}
