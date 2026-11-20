import { HELD_CONTEXT_LIMIT } from "@lrm/coforge-sdk/internal";
import type { AgentMessageRecord, TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AgentTaskPrincipal } from "#src/server/tasks/task-principal.server";
import { findSourceMessageRootId } from "#src/server/tasks/task-claims.server";
import { resolveTaskScope } from "#src/server/tasks/task-scope.server";
import type { TaskBoard } from "#src/server/tasks/task-board.server";
import { workspaceAssistantUser } from "./workspace-assistant-authority.server";
import { agentResolvedTargetFreshness } from "#src/server/db/repositories/agent-target-freshness.repositories.server";
import type { AgentTargetFreshness } from "./agent-target-freshness.server";

const FRESHNESS_HELD_OPERATIONS = ["create", "claim", "assign"];
const FRESHNESS_ATTACH_OPERATIONS = ["unclaim", "update", "amend"];

type FreshnessMessage = Omit<AgentMessageRecord, "createdAt"> & { createdAt: Date };

const toWireMessage = (message: FreshnessMessage): AgentMessageRecord =>
  ({ ...message, createdAt: message.createdAt.toISOString() }) as AgentMessageRecord;

export async function agentTaskBoardFreshness(
  db: PrismaClient,
  principal: AgentTaskPrincipal,
  command: TaskCommand,
): Promise<
  | {
      freshness: AgentTargetFreshness;
      scope: Awaited<ReturnType<typeof resolveTaskScope>>;
    }
  | undefined
> {
  if (await workspaceAssistantUser(db, principal.workspaceId, principal.agentId)) return undefined;
  const scope = await resolveTaskScope({ db }, principal, command);
  if (!scope.member) return undefined;
  let threadRootId: string | null = null;
  let canonicalTarget = command.target!;
  if (command.operation === "create" && command.messageId) {
    const rootId = await findSourceMessageRootId(db, scope.conversationId, command.messageId).catch(
      () => null,
    );
    if (rootId) {
      threadRootId = rootId;
      canonicalTarget = `${command.target!}:${rootId.slice(0, 13)}`;
    }
  }
  return {
    freshness: agentResolvedTargetFreshness({ db }, principal.workspaceId, principal.agentId, {
      conversationId: scope.conversationId,
      threadRootId,
      canonicalTarget,
      isChannel: scope.channel,
    }),
    scope,
  };
}

/**
 * The server-side freshness gate around an Agent's task write, the same judgment
 * `executeAgentSendMessageWithPolicy` applies to a send: the daemon's local check can hold first,
 * but the route re-decides authoritatively against the boundary the command reported
 * (`seenUpToSeq`, `seenExactSeqs`). A held operation answers `state: "held"` without executing;
 * an attached operation executes and carries its unread context in `recentUnread`. Without a
 * resolvable target freshness the board decides alone, exactly as it did before the gate.
 */
export async function executeAgentTaskWithFreshness(
  deps: {
    board: Pick<TaskBoard, "execute">;
    freshness?(command: TaskCommand): Promise<
      | {
          freshness: AgentTargetFreshness;
          scope: Awaited<ReturnType<typeof resolveTaskScope>>;
        }
      | undefined
    >;
  },
  principal: AgentTaskPrincipal,
  command: TaskCommand,
): Promise<TaskResult> {
  const heldOperation = FRESHNESS_HELD_OPERATIONS.includes(command.operation);
  const attachOperation = FRESHNESS_ATTACH_OPERATIONS.includes(command.operation);
  if ((!heldOperation && !attachOperation) || !command.target || !deps.freshness)
    return deps.board.execute(principal, command);
  const resolved = await deps.freshness(command);
  if (!resolved) return deps.board.execute(principal, command);
  const { freshness, scope } = resolved;
  const execute = () => deps.board.execute(principal, command, scope);

  const withheld = command.freshnessContextMode === "withheld";
  const excluded = command.seenExactSeqs?.length ? command.seenExactSeqs : undefined;
  // The Agent's reported boundary advances the server's read-through (monotone) and becomes the
  // freshness boundary; what lies above it, minus the messages shown one by one, is pending.
  const seen = command.seenUpToSeq
    ? ((await freshness.advanceReadThrough?.(command.seenUpToSeq)) ?? 0)
    : 0;
  const pending = async () => (await freshness.readPending?.(seen || undefined, excluded)) ?? [];
  const pendingCount = async () =>
    (await freshness.countPending?.(seen || undefined, excluded)) ?? 0;
  const held = (messages: readonly FreshnessMessage[], messageCount: number): TaskResult =>
    withheld
      ? {
          tasks: [],
          state: "held",
          freshnessContextMode: "withheld",
          withheldMessageCount: messageCount,
        }
      : {
          tasks: [],
          state: "held",
          freshnessContextMode: "inline",
          heldMessages: messages.map(toWireMessage),
          newMessageCount: messageCount,
        };
  // Pending the Agent had already been shown one by one: pass, advancing the boundary over it
  // when a boundary already known reaches its newest message (the send's consume effect).
  const advanceSeenPending = async (): Promise<void> => {
    const pendingMaxSeq = excluded
      ? ((await freshness.maxPendingSequence?.(seen || undefined)) ?? 0)
      : 0;
    if (pendingMaxSeq === 0) return;
    const known = Math.max(seen, (await freshness.readThrough?.()) ?? 0);
    if (known >= pendingMaxSeq) await freshness.advanceReadThrough?.(pendingMaxSeq);
  };

  if (heldOperation) {
    if (command.continueAnyway === true) {
      // The caller confirmed the held review: advance over everything the target holds and
      // execute — the task write's own "send anyway".
      const recent = await freshness.readRecent?.(HELD_CONTEXT_LIMIT, excluded);
      if (recent?.maxSequence !== undefined)
        await freshness.advanceReadThrough?.(recent.maxSequence);
      return execute();
    }
    const unconsumed = await pending();
    if (unconsumed.length > 0) return held(unconsumed, await pendingCount());
    if (seen > 0 || excluded?.length) {
      await advanceSeenPending();
      return execute();
    }
    // A first touch: no boundary at all. The target's recent context decides, exactly as a send's
    // syncing hold does.
    const recent = await freshness.readRecent?.(HELD_CONTEXT_LIMIT, excluded);
    if (recent?.unseen.length) return held(recent.unseen, recent.unseen.length);
    if (recent?.maxSequence !== undefined) await freshness.advanceReadThrough?.(recent.maxSequence);
    return execute();
  }

  const result = await execute();
  const unconsumed = await pending();
  if (unconsumed.length === 0) {
    await advanceSeenPending();
    return result;
  }
  const attached = unconsumed.slice(-HELD_CONTEXT_LIMIT);
  const count = await pendingCount();
  await freshness.advanceReadThrough?.(Math.max(...attached.map(({ sequence }) => sequence)));
  return withheld
    ? { ...result, freshnessContextMode: "withheld", withheldMessageCount: count }
    : {
        ...result,
        recentUnread: attached.map(toWireMessage),
        newMessageCount: count,
      };
}
