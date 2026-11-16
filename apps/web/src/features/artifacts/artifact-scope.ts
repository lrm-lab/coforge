import { Globe02, MessageChatCircle, Users01 } from "@untitledui/icons";

import { useWorkspaceName } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { loadArtifactGallery } from "./artifact-gallery.functions";
import { artifactHomeConversation } from "./artifact-queries";
import { useConversationName } from "./use-conversation-name";

export type VisibilityChoice = "conversation" | "workspace" | "link";

export const visibilityIcon = {
  conversation: MessageChatCircle,
  workspace: Users01,
  link: Globe02,
} as const;

export type GalleryCard = Awaited<ReturnType<typeof loadArtifactGallery>>["artifacts"][number];

export function useScopeLabels(): Record<VisibilityChoice, string> {
  const workspace = useWorkspaceName();
  return {
    conversation: m.av_vis_home_dm(),
    workspace: m.av_vis_workspace({ workspace }),
    link: m.av_vis_link(),
  };
}

export function useScopeOf() {
  const nameOf = useConversationName();
  const labels = useScopeLabels();
  return (card: Pick<GalleryCard, "link" | "access" | "homeKey">) => {
    const choice: VisibilityChoice = card.link ? "link" : card.access;
    const conversationId = artifactHomeConversation(card.homeKey);
    const homeName = conversationId ? nameOf(conversationId) : undefined;
    return {
      choice,
      Icon: visibilityIcon[choice],
      homeName,
      label: choice === "conversation" ? (homeName ?? labels.conversation) : labels[choice],
    };
  };
}
