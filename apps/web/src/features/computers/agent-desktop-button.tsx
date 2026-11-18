import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Monitor01 as Monitor } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { m } from "#src/paraglide/messages";
import { CloudDesktopOverlay } from "./cloud-desktop-overlay";
import { getCloudDesktopOrigin } from "./cloud-desktop-origin.functions";
import { cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";

export function AgentDesktopButton({
  computerId,
  agentId,
  kind,
  online,
  owned,
  title,
}: {
  computerId: string;
  agentId: string;
  kind: string;
  online: boolean;
  owned: boolean;
  title: string;
}) {
  const loadOrigin = useServerFn(getCloudDesktopOrigin);
  const origin = useQuery({
    queryKey: ["cloud-desktop-origin"],
    queryFn: () => loadOrigin(),
    enabled: kind === "cloud" && owned,
    staleTime: 60_000,
  });
  const phone = useMediaQuery("(max-width: 639px)", false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  if (kind !== "cloud" || !owned) return null;
  const url = origin.data ? cloudDesktopUrl(origin.data, computerId, agentId, title) : undefined;
  if (!url) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        color="secondary"
        iconLeading={Monitor}
        isDisabled={!online}
        onPress={() => {
          if (phone) setOverlayOpen(true);
          else openCloudDesktopWindow(url, computerId, agentId);
        }}
      >
        {m.computer_open_desktop()}
      </Button>
      {overlayOpen ? (
        <CloudDesktopOverlay url={url} title={title} onClose={() => setOverlayOpen(false)} />
      ) : null}
    </>
  );
}
