import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { useArtifactLinkSharing } from "./artifact-link-sharing";
import { artifactCardQuery, artifactHomeConversation } from "./artifact-queries";
import type { VisibilityChoice, useScopeOf } from "./artifact-scope";
import { VisibilityMenu, useArtifactVisibility } from "./use-artifact-visibility";

type CardScope = ReturnType<ReturnType<typeof useScopeOf>>;

export function GalleryCardVisibility({
  artifactId,
  tier,
  scope,
}: {
  artifactId: string;
  tier: VisibilityChoice;
  scope: CardScope;
}) {
  const [open, setOpen] = useState(false);
  const [engaged, setEngaged] = useState(false);
  return (
    <Dropdown.Root
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setEngaged(true);
      }}
    >
      <AriaButton
        aria-label={m.av_vis_aria({ scope: scope.label })}
        className="relative z-10 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-quaternary outline-focus-ring hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2"
      >
        <scope.Icon aria-hidden="true" className="size-4" />
      </AriaButton>
      {engaged && (
        <VisibilityPopover
          artifactId={artifactId}
          tier={tier}
          homeName={scope.homeName}
          open={open}
          onIdle={() => setEngaged(false)}
        />
      )}
    </Dropdown.Root>
  );
}

function VisibilityPopover({
  artifactId,
  tier,
  homeName,
  open,
  onIdle,
}: {
  artifactId: string;
  tier: VisibilityChoice;
  homeName: string | undefined;
  open: boolean;
  onIdle: () => void;
}) {
  const read = useQuery(artifactCardQuery(artifactId));
  const link = useArtifactLinkSharing(artifactId, true);
  const visibility = useArtifactVisibility({
    artifactId,
    tier,
    link,
    homeName,
    canChange: read.data?.canChange === true,
    narrowable: artifactHomeConversation(read.data?.homeKey ?? "") !== null,
  });
  const idle = !open && !visibility.confirming;
  useEffect(() => {
    if (idle) onIdle();
  }, [idle, onIdle]);
  return (
    <>
      <Dropdown.Popover placement="bottom end">
        {read.data === null || read.isError ? (
          <p className="w-56 px-3 py-2 text-sm text-tertiary">{m.doc_unavailable_title()}</p>
        ) : read.data && link.loaded ? (
          <VisibilityMenu visibility={visibility} />
        ) : (
          <div aria-busy="true" className="h-24 w-56" />
        )}
      </Dropdown.Popover>
      {visibility.dialog}
    </>
  );
}
