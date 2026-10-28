import { memoryConversationInstructions } from "#src/code-agent/agent-instructions";
import { ScopedAgentSessions, type ScopedSessionDependencies } from "./scoped-agent-sessions";
export type { ConversationSessionStore } from "./scoped-agent-sessions";

/** Memory has one native history per channel and a lifecycle-only primary session. */
export class MemoryConversationSessions extends ScopedAgentSessions {
  constructor(dependencies: Omit<ScopedSessionDependencies, "scope">) {
    super({
      ...dependencies,
      scope: (options) =>
        options?.conversation
          ? {
              ...options.conversation,
              key: options.conversation.conversationId,
              instructions: memoryConversationInstructions(
                dependencies.options.instructions,
                options.conversation,
              ),
            }
          : undefined,
    });
  }
}
