import type { AgentMessageDelivery, AgentRecoveryMessage } from "@lrm/coforge-sdk/internal";

/** Memory shares a channel history; ordinary isolated workers share only a task thread. */
export function scopedDeliveryBatches(
  messages: readonly AgentMessageDelivery[],
  memory: boolean,
): AgentMessageDelivery[][] {
  const groups = new Map<string, AgentMessageDelivery[]>();
  for (const message of messages) {
    const key = memory ? message.conversationId : message.target!;
    const batch = groups.get(key) ?? [];
    batch.push(message);
    groups.set(key, batch);
  }
  return [...groups.values()];
}

/** Split restart notices by the same scope as live notices, without loading message bodies. */
export function scopedRecoveryBatches(
  messages: readonly AgentRecoveryMessage[],
  summary: Readonly<Record<string, number>>,
  conversationId: (target: string) => string | undefined,
  memory: boolean,
) {
  const scopes = new Map<string, { conversationId: string; target: string }>();
  for (const message of messages)
    scopes.set(memory ? message.conversationId : message.target, {
      conversationId: message.conversationId,
      target: message.target,
    });
  for (const [target, count] of Object.entries(summary)) {
    if (count < 1) continue;
    const id = conversationId(target);
    if (!id) throw new Error("Scoped recovery requires a canonical conversation id");
    scopes.set(memory ? id : target, { conversationId: id, target });
  }
  return [...scopes.values()].map((scope) => ({
    scope,
    messages: messages.filter((message) =>
      memory ? message.conversationId === scope.conversationId : message.target === scope.target,
    ),
    summary: Object.fromEntries(
      Object.entries(summary).filter(([target]) =>
        memory ? conversationId(target) === scope.conversationId : target === scope.target,
      ),
    ),
  }));
}
