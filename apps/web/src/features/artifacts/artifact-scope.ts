import { useWorkspaceName } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import type { loadArtifactGallery } from "./artifact-gallery.functions";
import { useConversationName } from "./artifact-gallery-filters";
import { visibilityIcon, type VisibilityChoice } from "./use-artifact-visibility";

export type GalleryCard = Awaited<ReturnType<typeof loadArtifactGallery>>["artifacts"][number];

export function useScopeOf() {
  const nameOf = useConversationName();
  const workspace = useWorkspaceName();
  return (card: Pick<GalleryCard, "link" | "access" | "homeKey">) => {
    const choice: VisibilityChoice = card.link ? "link" : card.access;
    const label = {
      link: m.av_vis_link(),
      workspace: m.av_vis_workspace({ workspace }),
      conversation: nameOf(card.homeKey.replace(/^conversation:/, "")) ?? m.av_vis_home_dm(),
    }[choice];
    return { choice, Icon: visibilityIcon[choice], label };
  };
}
