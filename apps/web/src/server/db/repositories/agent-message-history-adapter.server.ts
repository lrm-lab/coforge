import type { PrismaClient } from "#src/generated/prisma/client";
import { readAgentMessagePage } from "./agent-message-history.repositories.server";
import {
  agentHistoryConsumptionScope,
  type ResolvedAgentTarget,
} from "./resolved-agent-target.server";
import type { DirectConversationPageOptions } from "./direct-conversation-types.server";

export function readDirectConversationMessagesPage(input: {
  db: PrismaClient;
  workspaceId: string;
  agentId: string;
  target: string;
  page: DirectConversationPageOptions;
  resolveTarget(target: string): Promise<ResolvedAgentTarget>;
  resolveAnchor(
    conversationId: string,
    anchor: string,
  ): Promise<{ id: string; sequence: number; threadRootId: string | null }>;
  agentReadChanged?: (input: {
    workspaceId: string;
    conversationId: string;
    agentId: string;
    readThroughSequence: number;
  }) => Promise<void>;
}) {
  return input.resolveTarget(input.target).then((resolved) => {
    const { conversationId, threadRootId, canonicalTarget, isChannel } = resolved;
    return readAgentMessagePage(input.db, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      conversationId,
      threadRootId,
      canonicalTarget,
      isChannel,
      page: input.page,
      consumptionScope: agentHistoryConsumptionScope(input.agentId, resolved),
      agentReadChanged: input.agentReadChanged,
      resolveAnchor: (anchor) => input.resolveAnchor(conversationId, anchor),
    });
  });
}
