import { useState } from "react";
import { ArrowUp, Monitor01 as Monitor, RefreshCw01 as RotateCw } from "@untitledui/icons";

import { BadgeWithDot } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { useAppToast } from "#src/components/ui/toast";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { useCloudDesktopOrigin } from "./cloud-desktop-origin";
import { CloudDesktopOverlay } from "./cloud-desktop-overlay";
import { cloudDesktopOpening, cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";
import type { ComputerDetailView } from "./computer-detail-view";
import { computerIcon, operatingSystemLabel } from "./computer-identity";

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

export function ComputerDetailHero({
  computer,
  label,
  showDesktop,
  upgrade,
  restart,
}: {
  computer: ComputerDetailView;
  label: string;
  showDesktop: boolean;
  upgrade?: ComputerDetailUpgrade;
  restart?: ComputerDetailRestart;
}) {
  const desktopOrigin = useCloudDesktopOrigin();
  const desktopUrl =
    showDesktop && desktopOrigin ? cloudDesktopUrl(desktopOrigin, computer.id) : undefined;
  const phone = !useBreakpoint("sm");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const toast = useAppToast();
  const Icon = computerIcon(computer);
  const os = operatingSystemLabel(computer);
  const rawHostname = computer.name.trim();
  const hostname = rawHostname && rawHostname !== label ? rawHostname : null;
  const restartLabel = restart?.pending
    ? m.computer_restart_requesting()
    : m.computer_restart_action();
  const upgradeLoading = upgrade?.kind === "upgrading";
  const upgradeColor = desktopUrl || upgradeLoading ? "secondary" : "primary";

  const openDesktop = () => {
    if (!desktopUrl) return;
    const opening = cloudDesktopOpening({ online: computer.online, phone });
    if (opening === "offline") toast.error(m.computer_desktop_offline());
    else if (opening === "overlay") setOverlayOpen(true);
    else openCloudDesktopWindow(desktopUrl, computer.id);
  };

  const hasActions = Boolean(desktopUrl || upgrade || restart);

  return (
    <section className="border-b border-secondary px-page py-5">
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-secondary bg-secondary_subtle text-tertiary"
        >
          <Icon className="size-6" />
        </span>

        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-primary wrap-anywhere">{label}</h1>
          <div className="mt-1.5">
            <BadgeWithDot type="color" color={computer.online ? "success" : "gray"} size="sm">
              {computer.online ? m.computer_status_online() : m.computer_status_offline()}
            </BadgeWithDot>
          </div>

          {hostname || os ? (
            <div className="mt-2 space-y-0.5 text-xs text-tertiary">
              {hostname ? (
                <p dir="ltr" className="truncate font-mono">
                  {hostname}
                </p>
              ) : null}
              {os ? <p className="truncate">{os}</p> : null}
            </div>
          ) : null}

          {hasActions ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {desktopUrl ? (
                <Button
                  type="button"
                  size="sm"
                  color="primary"
                  iconLeading={Monitor}
                  onPress={openDesktop}
                >
                  {m.computer_open_desktop()}
                </Button>
              ) : null}
              {upgrade ? (
                <Button
                  type="button"
                  size="sm"
                  color={upgradeColor}
                  iconLeading={ArrowUp}
                  isLoading={upgradeLoading}
                  showTextWhileLoading
                  isDisabled={upgrade.disabled}
                  onPress={upgrade.onPress}
                >
                  {upgrade.label}
                </Button>
              ) : null}
              {restart ? (
                <Button
                  type="button"
                  size="sm"
                  color="secondary"
                  iconLeading={RotateCw}
                  isDisabled={restart.disabled}
                  onPress={restart.onPress}
                >
                  {restartLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {overlayOpen && desktopUrl ? (
        <CloudDesktopOverlay url={desktopUrl} title={label} onClose={() => setOverlayOpen(false)} />
      ) : null}
    </section>
  );
}
