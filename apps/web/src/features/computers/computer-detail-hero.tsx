import { useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  Monitor01 as Monitor,
  RefreshCw01 as RotateCw,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { useAppToast } from "#src/components/ui/toast";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useCloudDesktopOrigin } from "./cloud-desktop-origin";
import { CloudDesktopOverlay } from "./cloud-desktop-overlay";
import { cloudDesktopOpening, cloudDesktopUrl, openCloudDesktopWindow } from "./cloud-desktop-url";
import type { ComputerDetailView } from "./computer-detail-view";
import { operatingSystemLabel } from "./computer-identity";
import {
  isMachineDiskLow,
  machineAvailableLabel,
  machineUsedPercent,
  type MachineStatusReading,
} from "./computer-machine-status";

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
  isCloud,
  currentVersion,
  isLatestVersion,
  showDesktop,
  showOfflineHint,
  canTroubleshoot,
  upgrade,
  restart,
}: {
  computer: ComputerDetailView;
  label: string;
  isCloud: boolean;
  currentVersion?: string | null;
  isLatestVersion: boolean;
  showDesktop: boolean;
  showOfflineHint: boolean;
  canTroubleshoot: boolean;
  upgrade?: ComputerDetailUpgrade;
  restart?: ComputerDetailRestart;
}) {
  const desktopOrigin = useCloudDesktopOrigin();
  const desktopUrl =
    showDesktop && desktopOrigin ? cloudDesktopUrl(desktopOrigin, computer.id) : undefined;
  const phone = !useBreakpoint("sm");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const toast = useAppToast();
  const os = operatingSystemLabel(computer);
  const rawHostname = computer.name.trim();
  const hostname = rawHostname && rawHostname !== label ? rawHostname : null;
  const disk = computer.machine?.disk ?? null;
  const memory = computer.machine?.memory ?? null;
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

  const metaParts: string[] = [
    isCloud ? m.computer_detail_kind_cloud() : m.computer_detail_kind_local(),
  ];
  if (os) metaParts.push(os);
  if (currentVersion) {
    metaParts.push(
      isLatestVersion
        ? `v${currentVersion} · ${m.computer_overview_latest_version()}`
        : `v${currentVersion}`,
    );
  }
  const hasActions = Boolean(desktopUrl || upgrade || restart);
  const hasResources = Boolean(disk || memory);

  return (
    <section className="border-b border-secondary px-page py-4">
      <div className="text-xs leading-relaxed text-tertiary wrap-anywhere">
        {metaParts.map((part, index) => (
          <span key={`${index}-${part}`}>
            {index > 0 ? (
              <span aria-hidden="true" className="mx-1.5 text-quaternary">
                ·
              </span>
            ) : null}
            <span>{part}</span>
          </span>
        ))}
        {hostname ? (
          <span>
            <span aria-hidden="true" className="mx-1.5 text-quaternary">
              ·
            </span>
            <span dir="ltr" className="font-mono wrap-anywhere">
              {hostname}
            </span>
          </span>
        ) : null}
      </div>

      {showOfflineHint ? (
        <div
          role="status"
          className="mt-3 flex items-start gap-2 rounded-lg bg-warning-primary px-3 py-2.5 text-xs leading-relaxed text-warning-primary ring-1 ring-inset ring-warning_subtle"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {canTroubleshoot
              ? m.computer_detail_offline_hint()
              : m.computer_detail_offline_hint_viewer()}
          </span>
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

      {hasResources ? (
        <div className="mt-4 border-t border-secondary pt-3.5">
          <div className="grid max-w-lg grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2.5 text-xs">
            {disk ? (
              <ResourceMeterRow label={m.computer_disk()} reading={disk} base={1000} warn />
            ) : null}
            {memory ? (
              <ResourceMeterRow label={m.computer_memory()} reading={memory} base={1024} />
            ) : null}
          </div>
        </div>
      ) : null}

      {overlayOpen && desktopUrl ? (
        <CloudDesktopOverlay url={desktopUrl} title={label} onClose={() => setOverlayOpen(false)} />
      ) : null}
    </section>
  );
}

function ResourceMeterRow({
  label,
  reading,
  base,
  warn = false,
}: {
  label: string;
  reading: MachineStatusReading;
  base: 1000 | 1024;
  warn?: boolean;
}) {
  const percent = machineUsedPercent(reading);
  const low = warn && isMachineDiskLow(reading);
  const available = machineAvailableLabel(reading, base);

  return (
    <>
      <span className="font-medium text-tertiary">{label}</span>
      <ProgressBarBase
        value={percent}
        className="h-1.5 w-full rounded-full"
        progressClassName={cn("rounded-full", low && "bg-warning-solid")}
      />
      <span className="text-right whitespace-nowrap tabular-nums">
        <span className={cn("font-semibold", low ? "text-warning-primary" : "text-primary")}>
          {percent}%
        </span>
        <span className="text-quaternary">
          {" · "}
          {m.computer_detail_free_capacity({ amount: available })}
        </span>
      </span>
    </>
  );
}
