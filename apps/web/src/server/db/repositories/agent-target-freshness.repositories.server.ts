import type { DirectConversationPorts } from "./agent-targets.repositories.server";

import {
  advanceResolvedAgentReadThrough,
  agentMessagesByIds,
} from "./agent-message-reads.repositories.server";
import { resolveAgentSendTarget } from "./agent-targets.repositories.server";
import { HELD_CONTEXT_LIMIT } from "@lrm/coforge-sdk/internal";
import type { AgentTargetFreshness } from "#src/server/agents/agent-target-freshness.server";
import {
  agentAttentionCountSql,
  agentAttentionIdsSql,
  agentAttentionMaxSql,
  agentRecentContextSql,
  type AgentAttentionScope,
} from "#src/server/db/repositories/agent-attention.repositories.server";

/**
 * One Agent-facing target resolved once, with the freshness reads and the read-through advance
 * a send checks against it (`executeAgentSendMessageWithPolicy`), so they share that resolution,
 * the Agent's membership lookup, and each pending scope (a read and its count share one).
 */
export async function agentTargetFreshness(
  ports: DirectConversationPorts,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  const resolved = await resolveAgentSendTarget(ports, workspaceId, agentId, target);
  const { conversationId, threadRootId, canonicalTarget, isChannel } = resolved;
  // One membership lookup for every read of this send. Its read-through may predate this send's
  // own advance, which only raises it: the planner takes the larger of the two.
  let member: Promise<{ id: string; agentReadThroughSequence: number } | null> | undefined;
  const agentMember = () =>
    (member ??= ports.db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true, agentReadThroughSequence: true },
    }));
  const pendingScopes = new Map<number | undefined, Promise<AgentAttentionScope>>();
  // A pending scope starts above the boundary the Agent reported, or, with none, above its own
  // latest message in the target.
  const pendingScope = (afterSequence?: number) => {
    let scope = pendingScopes.get(afterSequence);
    if (!scope) {
      scope = (async () => {
        const own = await agentMember();
        const latestOwn =
          afterSequence === undefined && own
            ? await ports.db.message.findFirst({
                where: { conversationId, threadRootId, senderMemberId: own.id },
                orderBy: { sequence: "desc" },
                select: { sequence: true },
              })
            : undefined;
        return {
          agentId,
          conversationId,
          threadRootId,
          isChannel,
          ownMemberId: own?.id,
          afterSequence: afterSequence ?? latestOwn?.sequence ?? 0,
        };
      })();
      pendingScopes.set(afterSequence, scope);
    }
    return scope;
  };
  const freshness = {
    advanceReadThrough: (seenUpToSequence: number) =>
      advanceResolvedAgentReadThrough(ports, workspaceId, agentId, resolved, seenUpToSequence),
    readThrough: async () => {
      const own = await agentMember();
      if (!own) return 0;
      if (!threadRootId) return own.agentReadThroughSequence;
      const read = await ports.db.threadRead.findUnique({
        where: { memberId_rootMessageId: { memberId: own.id, rootMessageId: threadRootId } },
        select: { readThroughSequence: true },
      });
      return read?.readThroughSequence ?? 0;
    },
    readPending: async (afterSequence?: number, excludingSequences?: readonly number[]) =>
      agentMessagesByIds(
        ports,
        await ports.db.$queryRaw<{ id: string }[]>(
          agentAttentionIdsSql(
            { ...(await pendingScope(afterSequence)), excludeSequences: excludingSequences },
            HELD_CONTEXT_LIMIT,
          ),
        ),
        canonicalTarget,
        { workspaceId, agentId },
      ),
    countPending: async (afterSequence?: number, excludingSequences?: readonly number[]) => {
      const scope = {
        ...(await pendingScope(afterSequence)),
        excludeSequences: excludingSequences,
      };
      const [row] = await ports.db.$queryRaw<{ count: number }[]>(agentAttentionCountSql(scope));
      return row?.count ?? 0;
    },
    maxPendingSequence: async (afterSequence?: number) => {
      const [row] = await ports.db.$queryRaw<{ max: number | null }[]>(
        agentAttentionMaxSql(await pendingScope(afterSequence)),
      );
      return row?.max ?? undefined;
    },
    // The target's newest messages, whatever the Agent's boundary, the Agent's own included (they
    // count as seen); `unseen` is the rest of the window less what it was shown one by one.
    readRecent: async (limit: number, excludingSequences?: readonly number[]) => {
      const window = await ports.db.$queryRaw<{ id: string; sequence: number; seen: boolean }[]>(
        agentRecentContextSql(
          {
            agentId,
            conversationId,
            threadRootId,
            isChannel,
            ownMemberId: (await agentMember())?.id,
            excludeSequences: excludingSequences,
          },
          limit,
        ),
      );
      return {
        unseen: await agentMessagesByIds(
          ports,
          window.filter((row) => !row.seen),
          canonicalTarget,
          { workspaceId, agentId },
        ),
        maxSequence: window[0]?.sequence,
      };
    },
  };
  return freshness satisfies Required<AgentTargetFreshness>;
}
