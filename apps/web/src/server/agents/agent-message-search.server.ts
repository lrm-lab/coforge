import type { AgentMessageRepository } from "./agent-messages.server";

export async function searchAgentMessages(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  options: Record<string, unknown>,
) {
  if (!repository.searchMessages) throw new Error("Agent message search is unavailable");
  const page = await repository.searchMessages(scope.workspaceId, scope.agentId, options);
  return {
    ...page,
    messages: page.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}
