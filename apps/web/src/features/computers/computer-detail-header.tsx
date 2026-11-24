import { useState, type ReactNode } from "react";
import { ArrowUp, Monitor01 as Monitor, RefreshCw01 as RotateCw } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { BackToComputers, ComputerDetailPaneActions } from "./back-to-computers";
import { CloudDesktopOverlay } from "./cloud-desktop-overlay";
import { cloudDesktopOpening, cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";
import { useCloudDesktopOrigin } from "./cloud-desktop-origin";

export type ComputerDetailRestart = {
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
};

export type ComputerDetailUpgrade = {
  kind: "upgrade" | "upgrading" | "retry";
  label: string;
  disabled: boolean;
  onPress: () => void;
};

export function ComputerDetailHeader({
  computerId,
  identity,
  desktopTitle,
  showDesktop,
  online,
  upgrade,
  restart,
  menu,
}: {
  computerId: string;
  identity: ReactNode;
  desktopTitle: string;
  showDesktop: boolean;
  online: boolean;
  upgrade?: ComputerDetailUpgrade;
  restart: ComputerDetailRestart | undefined;
  menu?: ReactNode;
}) {
  const desktopOrigin = useCloudDesktopOrigin();
  const desktopUrl =
    showDesktop && desktopOrigin ? cloudDesktopUrl(desktopOrigin, computerId) : undefined;
  const phone = !useBreakpoint("sm");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const toast = useAppToast();
  const restartLabel = restart?.pending
    ? m.computer_restart_requesting()
    : m.computer_restart_action();
  const upgradeColor = desktopUrl || upgrade?.kind === "upgrading" ? "secondary" : "primary";
  const upgradeLoading = upgrade?.kind === "upgrading";
  const openDesktop = () => {
    if (!desktopUrl) return;
    const opening = cloudDesktopOpening({ online, phone });
    if (opening === "offline") toast.error(m.computer_desktop_offline());
    else if (opening === "overlay") setOverlayOpen(true);
    else openCloudDesktopWindow(desktopUrl, computerId);
  };
  return (
    <div className="@container/comp-header flex h-12 shrink-0 items-center gap-1.5 border-b border-secondary px-page @md/comp-header:gap-3">
      <BackToComputers />
      <div className="min-w-0 flex-1">{identity}</div>
      {desktopUrl ? (
        <>
          <Button
            type="button"
            size="sm"
            color="primary"
            className="hidden shrink-0 @xs/comp-header:inline-flex"
            iconLeading={Monitor}
            onPress={openDesktop}
          >
            {m.computer_open_desktop()}
          </Button>
          <Button
            type="button"
            size="sm"
            color="primary"
            aria-label={m.computer_open_desktop()}
            className="shrink-0 @xs/comp-header:hidden"
            iconLeading={Monitor}
            onPress={openDesktop}
          />
        </>
      ) : null}
      {overlayOpen && desktopUrl ? (
        <CloudDesktopOverlay
          url={desktopUrl}
          title={desktopTitle}
          onClose={() => setOverlayOpen(false)}
        />
      ) : null}
      {upgrade ? (
        <>
          <Button
            type="button"
            size="sm"
            color={upgradeColor}
            className="hidden shrink-0 @xs/comp-header:inline-flex"
            iconLeading={ArrowUp}
            isLoading={upgradeLoading}
            showTextWhileLoading
            isDisabled={upgrade.disabled}
            onPress={upgrade.onPress}
          >
            {upgrade.label}
          </Button>
          <Button
            type="button"
            size="sm"
            color={upgradeColor}
            aria-label={upgrade.label}
            className="shrink-0 @xs/comp-header:hidden"
            iconLeading={ArrowUp}
            isLoading={upgradeLoading}
            isDisabled={upgrade.disabled}
            onPress={upgrade.onPress}
          />
        </>
      ) : null}
      {restart ? (
        <>
          <Button
            type="button"
            size="sm"
            color="secondary"
            className="hidden shrink-0 @md/comp-header:inline-flex"
            iconLeading={RotateCw}
            isDisabled={restart.disabled}
            onPress={restart.onPress}
          >
            {restartLabel}
          </Button>
          <ButtonUtility
            icon={RotateCw}
            size="sm"
            color="tertiary"
            className="shrink-0 @md/comp-header:hidden"
            tooltip={restartLabel}
            isDisabled={restart.disabled}
            onClick={restart.onPress}
          />
        </>
      ) : null}
      {menu}
      <ComputerDetailPaneActions />
    </div>
  );
}
