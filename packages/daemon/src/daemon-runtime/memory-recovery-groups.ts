import type { AgentRecoveryMessage } from "@lrm/coforge-sdk/internal";

export type MemoryRecoveryGroup = Readonly<{
  conversationId: string;
  target: string;
  messages: readonly AgentRecoveryMessage[];
  unreadSummary: Readonly<Record<string, number>>;
}>;

/** Partitions one Memory Agent recovery payload once, preserving the old target and row order. */
export function groupMemoryRecovery(
  messages: readonly AgentRecoveryMessage[],
  unreadSummary: Readonly<Record<string, number>>,
  unreadConversationIds: Readonly<Record<string, string>>,
  consumedConversations: ReadonlyMap<string, string>,
): MemoryRecoveryGroup[] {
  const firstConversationByTarget = new Map<string, string>();
  const messagesByConversation = new Map<string, AgentRecoveryMessage[]>();
  const scopes = new Map<string, string>();
  for (const message of messages) {
    firstConversationByTarget.set(
      message.target,
      firstConversationByTarget.get(message.target) ?? message.conversationId,
    );
    const conversationMessages = messagesByConversation.get(message.conversationId) ?? [];
    conversationMessages.push(message);
    messagesByConversation.set(message.conversationId, conversationMessages);
    scopes.set(message.conversationId, message.target);
  }

  const conversationOf = (target: string) =>
    unreadConversationIds[target] ??
    firstConversationByTarget.get(target) ??
    consumedConversations.get(target);
  const summariesByConversation = new Map<string, Record<string, number>>();
  for (const [target, count] of Object.entries(unreadSummary)) {
    const conversationId = conversationOf(target);
    if (count > 0) {
      if (!conversationId) throw new Error("Memory recovery requires a canonical conversation id");
      scopes.set(conversationId, target);
    }
    if (conversationId) {
      const summary = summariesByConversation.get(conversationId) ?? {};
      summary[target] = count;
      summariesByConversation.set(conversationId, summary);
    }
  }

  return [...scopes].map(([conversationId, target]) => ({
    conversationId,
    target,
    messages: messagesByConversation.get(conversationId) ?? [],
    unreadSummary: summariesByConversation.get(conversationId) ?? {},
  }));
}
