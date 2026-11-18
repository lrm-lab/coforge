import { Link } from "@tanstack/react-router";

import { homeConversationOf, homeLinkProps, type ArtifactHome } from "./artifact-home";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { VisibilityChoice } from "./artifact-scope";
import { PRESSABLE_CHIP_CLASS } from "#src/features/conversations/review-chrome";

export function ArtifactHomeChip({
  home,
  homeName,
  scope,
}: {
  home: ArtifactHome;
  homeName: string | undefined;
  scope: VisibilityChoice;
}) {
  const workspaceSlug = useWorkspaceSlug();
  if (scope === "conversation" || !homeConversationOf(home) || !homeName) return null;
  return (
    <Link
      {...homeLinkProps(home, workspaceSlug)}
      aria-label={m.av_home_chip_aria({ name: homeName })}
      className={cn(PRESSABLE_CHIP_CLASS, "max-w-40")}
    >
      <span className="truncate">{homeName}</span>
    </Link>
  );
}
