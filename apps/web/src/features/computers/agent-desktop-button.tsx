import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Monitor01 as Monitor } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { getCloudDesktopOrigin } from "./cloud-desktop-origin.functions";
import { cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";

/**
 * Opens this Agent's screen on its cloud computer, in its own window.
 * Shown to the computer's owner when this deployment has a desktop proxy.
 * The address is `/desktop/<computer id>/<agent id>/` and carries no token.
 * `title` is the Agent's name and becomes the window title.
 */
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
  if (kind !== "cloud" || !owned) return null;
  const url = origin.data ? cloudDesktopUrl(origin.data, computerId, agentId, title) : undefined;
  if (!url) return null;
  return (
    <Button
      type="button"
      size="sm"
      color="secondary"
      iconLeading={Monitor}
      isDisabled={!online}
      onPress={() => {
        openCloudDesktopWindow(url, computerId, agentId);
      }}
    >
      {m.computer_open_desktop()}
    </Button>
  );
}
