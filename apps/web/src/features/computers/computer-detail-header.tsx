import { useState, type ReactNode } from "react";
import { Monitor01 as Monitor, RefreshCw01 as RotateCw } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useMediaQuery } from "#src/hooks/use-media-query";
import { m } from "#src/paraglide/messages";
import { BackToComputers } from "./back-to-computers";
import { CloudDesktopOverlay } from "./cloud-desktop-overlay";
import { cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";
import { useCloudDesktopOrigin } from "./cloud-desktop-origin";

/** Restart control next to Open desktop. The detail page owns the request. */
export type ComputerDetailRestart = {
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
};

/**
 * Detail header band: back to the list, which Computer this is (`identity`), the owner's cloud
 * desktop, restart, and a "more" menu — what the machine is and what can be done to it on one line, as on Coder's
 * workspace page. Open desktop uses this deployment's proxy and stays disabled while the computer
 * is offline.
 */
export function ComputerDetailHeader({
  computerId,
  identity,
  desktopTitle,
  showDesktop,
  online,
  restart,
  menu,
}: {
  computerId: string;
  identity: ReactNode;
  /** Window chrome title for the in-page desktop overlay (phone). */
  desktopTitle: string;
  showDesktop: boolean;
  online: boolean;
  restart: ComputerDetailRestart | undefined;
  /** The "more" menu at the end of the line: the rare actions that change or end the Computer. */
  menu?: ReactNode;
}) {
  const desktopOrigin = useCloudDesktopOrigin();
  const desktopUrl =
    showDesktop && desktopOrigin ? cloudDesktopUrl(desktopOrigin, computerId) : undefined;
  const phone = useMediaQuery("(max-width: 639px)", false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const restartLabel = restart?.pending
    ? m.computer_restart_requesting()
    : m.computer_restart_action();
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page max-sm:gap-1.5">
      <BackToComputers />
      <div className="min-w-0 flex-1">{identity}</div>
      {desktopUrl ? (
        <Button
          type="button"
          size="sm"
          color="primary"
          className="shrink-0"
          iconLeading={Monitor}
          isDisabled={!online}
          onPress={() => {
            if (phone) setOverlayOpen(true);
            else openCloudDesktopWindow(desktopUrl, computerId);
          }}
        >
          {m.computer_open_desktop()}
        </Button>
      ) : null}
      {overlayOpen && desktopUrl ? (
        <CloudDesktopOverlay
          url={desktopUrl}
          title={desktopTitle}
          onClose={() => setOverlayOpen(false)}
        />
      ) : null}
      {restart ? (
        <>
          <Button
            type="button"
            size="sm"
            color="secondary"
            className="shrink-0 max-sm:hidden"
            iconLeading={RotateCw}
            isDisabled={restart.disabled}
            onPress={restart.onPress}
          >
            {restartLabel}
          </Button>
          {/* A phone keeps the line for the Computer's name: Restart is its icon, named in the
              tooltip. */}
          <ButtonUtility
            icon={RotateCw}
            size="sm"
            color="tertiary"
            className="shrink-0 sm:hidden"
            tooltip={restartLabel}
            isDisabled={restart.disabled}
            onClick={restart.onPress}
          />
        </>
      ) : null}
      {menu}
    </div>
  );
}
