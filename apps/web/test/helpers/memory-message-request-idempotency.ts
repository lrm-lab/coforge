import type {
  MessageRequestIdempotency,
  MessageRequestScope,
  PersistedDirectMessage,
} from "#src/server/conversations/message-request-idempotency.server";

/** Request records kept in memory: a send repeated under one idempotency key returns the first
 * one's message instead of persisting again. */
export class MemoryMessageRequestIdempotency implements MessageRequestIdempotency {
  readonly results = new Map<string, PersistedDirectMessage>();

  async execute(scope: MessageRequestScope, persist: () => Promise<PersistedDirectMessage>) {
    const key = `${scope.workspaceId}:${scope.senderKind}:${scope.senderId}:${scope.idempotencyKey}`;
    const existing = this.results.get(key);
    if (existing) return existing;
    const message = await persist();
    this.results.set(key, message);
    return message;
  }
}
