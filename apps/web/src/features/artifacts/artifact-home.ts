import { conversationRoute } from "#src/features/conversations/last-conversation";

export type ArtifactHome = { kind: "channel" | "dm" | "workspace"; conversationId: string | null };

export function homeConversationOf(home: ArtifactHome | undefined): string | undefined {
  return home?.conversationId && home.kind !== "workspace" ? home.conversationId : undefined;
}

export function homeLinkProps(home: ArtifactHome | undefined, workspaceSlug: string) {
  const conversationId = homeConversationOf(home);
  if (!conversationId) return { to: "/w/$workspaceSlug", params: { workspaceSlug } } as const;
  return conversationRoute(
    home?.kind === "channel" ? { channelId: conversationId } : { dmId: conversationId },
    workspaceSlug,
  );
}
