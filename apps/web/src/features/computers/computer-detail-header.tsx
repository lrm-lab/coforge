import { Monitor01 as Monitor, RefreshCw01 as RotateCw } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { BackToComputers } from "./back-to-computers";
import { cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";
import { useCloudDesktopOrigin } from "./cloud-desktop-origin";

/** Restart control next to Open desktop. The detail page owns the request. */
export type ComputerDetailRestart = {
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
};

/**
 * Detail header band: back to the list, the owner's cloud desktop, and restart.
 * Open desktop uses this deployment's proxy and stays disabled while the computer is offline.
 */
export function ComputerDetailHeader({
  computerId,
  showDesktop,
  online,
  restart,
}: {
  computerId: string;
  showDesktop: boolean;
  online: boolean;
  restart: ComputerDetailRestart | undefined;
}) {
  const desktopOrigin = useCloudDesktopOrigin();
  const desktopUrl =
    showDesktop && desktopOrigin ? cloudDesktopUrl(desktopOrigin, computerId) : undefined;
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page">
      <BackToComputers />
      {desktopUrl ? (
        <Button
          type="button"
          size="sm"
          color="primary"
          className="ml-auto"
          iconLeading={Monitor}
          isDisabled={!online}
          onPress={() => {
            openCloudDesktopWindow(desktopUrl, computerId);
          }}
        >
          {m.computer_open_desktop()}
        </Button>
      ) : null}
      {restart ? (
        <Button
          type="button"
          size="sm"
          color="secondary"
          className={desktopUrl ? undefined : "ml-auto"}
          iconLeading={RotateCw}
          isDisabled={restart.disabled}
          onPress={restart.onPress}
        >
          {restart.pending ? m.computer_restart_requesting() : m.computer_restart_action()}
        </Button>
      ) : null}
    </div>
  );
}
