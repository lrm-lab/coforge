import { Link } from "@tanstack/react-router";
import { MessageChatCircle } from "@untitledui/icons";

import { conversationRoute } from "#src/features/conversations/last-conversation";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { useHomeName, type ArtifactHome } from "./artifact-page-header";

export function ArtifactHomeChip({ home }: { home: ArtifactHome }) {
  const workspaceSlug = useWorkspaceSlug();
  const name = useHomeName(home);
  if (!home.conversationId || home.kind === "workspace" || !name) return null;
  const target =
    home.kind === "channel" ? { channelId: home.conversationId } : { dmId: home.conversationId };
  return (
    <Link
      {...conversationRoute(target, workspaceSlug)}
      aria-label={m.av_home_chip_aria({ name })}
      className="flex min-w-0 max-w-40 shrink items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
    >
      <MessageChatCircle aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </Link>
  );
}
