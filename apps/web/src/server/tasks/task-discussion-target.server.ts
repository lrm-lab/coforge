import type { Transaction } from "./task-board-ports.server";
import { directTargets } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import {
  conversationTarget,
  TARGET_CONVERSATION_SELECT,
} from "#src/server/db/repositories/direct-conversation-agent-message.server";

/** The spelling a task discussion's deliveries and its read's consumption scope share:
 * `#board:#N` on a channel board, `@peer:#N` (with a `~` disambiguator when needed) on a DM
 * board — `conversationTarget` over the discussion from this Agent's seat. `boardLabel`'s
 * `dm:@peer:#N` would key the consumed cursor under a spelling no delivery ever uses. */
export async function taskDiscussionDeliveryTarget(
  db: Transaction,
  workspaceId: string,
  agentId: string,
  conversationId: string,
) {
  const discussion = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: TARGET_CONVERSATION_SELECT,
  });
  const target = conversationTarget(
    discussion,
    await directTargets(db, workspaceId, agentId, [discussion]),
  );
  return {
    canonicalTarget: target,
    consumptionScope: { agentId, conversationId, channelType: "thread" as const, target },
  };
}
