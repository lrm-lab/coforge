import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { useConversationName } from "./artifact-gallery-filters";
import { useScopeOf, type GalleryCard } from "./artifact-scope";
import { useArtifactLinkSharing } from "./artifact-link-sharing";
import { artifactCardQuery, artifactLinkSharingQuery } from "./artifact-queries";
import { VisibilityMenu, useArtifactVisibility } from "./use-artifact-visibility";

export function GalleryCardVisibility({ card }: { card: GalleryCard }) {
  const [opened, setOpened] = useState(false);
  const nameOf = useConversationName();
  const scope = useScopeOf()(card);
  const read = useQuery({ ...artifactCardQuery(card.id), enabled: opened });
  const sharing = useQuery({ ...artifactLinkSharingQuery(card.id), enabled: opened });
  const link = useArtifactLinkSharing(card.id, opened);
  const visibility = useArtifactVisibility({
    artifactId: card.id,
    tier: card.access,
    link,
    homeName: nameOf(card.homeKey.replace(/^conversation:/, "")),
  });
  const detail = read.data;
  return (
    <>
      <Dropdown.Root onOpenChange={(open) => open && setOpened(true)}>
        <AriaButton
          aria-label={m.av_vis_aria({ scope: scope.label })}
          className="relative z-10 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-quaternary outline-focus-ring hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2"
        >
          <scope.Icon aria-hidden="true" className="size-4" />
        </AriaButton>
        <Dropdown.Popover placement="bottom end">
          {detail && sharing.data ? (
            <VisibilityMenu
              visibility={visibility}
              linkAvailable={link.available}
              narrowable={detail.canChange && (detail.homeKey ?? "").startsWith("conversation:")}
              canChange={detail.canChange}
            />
          ) : (
            <div aria-busy="true" className="h-24 w-56" />
          )}
        </Dropdown.Popover>
      </Dropdown.Root>
      {visibility.dialog}
    </>
  );
}
