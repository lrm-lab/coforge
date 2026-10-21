import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Monitor01 as Monitor } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { getCloudDesktopOrigin } from "./cloud-desktop-origin.functions";
import { cloudDesktopUrl } from "./cloud-desktop-url";

/**
 * Opens this Agent's screen on its cloud computer.
 * Shown to the computer's owner when this deployment has a desktop proxy.
 * The address is `/desktop/<computer id>/<agent id>/` and carries no token.
 */
export function AgentDesktopButton({
  computerId,
  agentId,
  kind,
  online,
  owned,
}: {
  computerId: string;
  agentId: string;
  kind: string;
  online: boolean;
  owned: boolean;
}) {
  const loadOrigin = useServerFn(getCloudDesktopOrigin);
  const origin = useQuery({
    queryKey: ["cloud-desktop-origin"],
    queryFn: () => loadOrigin(),
    enabled: kind === "cloud" && owned,
    staleTime: 60_000,
  });
  if (kind !== "cloud" || !owned) return null;
  const url = origin.data ? cloudDesktopUrl(origin.data, computerId, agentId) : undefined;
  if (!url) return null;
  return (
    <Button
      type="button"
      size="sm"
      color="secondary"
      className="mt-3"
      iconLeading={Monitor}
      isDisabled={!online}
      onPress={() => {
        window.open(url, "_blank", "noopener,noreferrer");
      }}
    >
      {m.computer_open_desktop()}
    </Button>
  );
}
