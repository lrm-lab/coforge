import { ComputerUpgradeSlot, type ComputerUpgradeSlotState } from "./computer-upgrade-slot";
import { ComputerDate } from "./computer-detail-date";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { m } from "#src/paraglide/messages";
import type { ComputerDetailView } from "./computer-detail-view";
import {
  isMachineDiskLow,
  machineUsageLabel,
  machineUsedPercent,
  type MachineStatusReading,
} from "./computer-machine-status";
import type { ReactNode } from "react";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { usedPercentText } from "./usage-window";
import { cn } from "#src/lib/utils";

/**
 * What the machine is, as one strip of short facts — Disk, Memory, Version (and a cloud Computer's
 * Image), who added it, each only once the Computer has reported it — each a small label over its value, with no box around them (Coder's
 * workspace page). An upgrade on offer shows below the strip.
 */
export function ComputerDetailStats({
  computer,
  label,
  timeZone,
  creatorName,
  isCloud,
  currentVersion,
  currentImageVersion,
  runtimeSlot,
  imageSlot,
  canUpgrade,
  upgradeInFlight,
  onRuntimeUpgrade,
  onImageUpgrade,
}: {
  computer: ComputerDetailView;
  label: string;
  timeZone: string | null;
  creatorName: string;
  isCloud: boolean;
  currentVersion: string | null | undefined;
  currentImageVersion: string | null | undefined;
  runtimeSlot: ComputerUpgradeSlotState | null;
  imageSlot: ComputerUpgradeSlotState | null;
  canUpgrade: boolean;
  upgradeInFlight: boolean;
  onRuntimeUpgrade: () => void;
  onImageUpgrade: () => void;
}) {
  const disk = computer.machine?.disk;
  const memory = computer.machine?.memory;
  const imageVersion = isCloud ? currentImageVersion : null;
  const hasFacts = Boolean(disk || memory || currentVersion || imageVersion || computer.creator);
  if (!hasFacts && !runtimeSlot && !(isCloud && imageSlot)) return null;
  return (
    <div className="flex flex-col gap-4">
      {hasFacts && (
        <dl className="flex flex-wrap gap-x-12 gap-y-5">
          {/* A fact the Computer has not reported is left out, not written as "Unknown". */}
          {disk && (
            <Stat label={m.computer_disk()}>
              <MachineUsage reading={disk} base={1000} warn />
            </Stat>
          )}
          {memory && (
            <Stat label={m.computer_memory()}>
              <MachineUsage reading={memory} base={1024} />
            </Stat>
          )}
          {currentVersion && (
            <Stat label={m.computer_version()}>
              <span dir="ltr">{currentVersion}</span>
            </Stat>
          )}
          {imageVersion && (
            <Stat label={m.computer_image_version()}>
              <span dir="ltr">{imageVersion}</span>
            </Stat>
          )}
          {computer.creator && (
            <Stat label={m.computer_added_by()}>
              <span className="flex min-w-0 items-center gap-2">
                <ActorAvatar
                  presence={false}
                  size="xs"
                  name={creatorName}
                  src={computer.creator.avatarUrl}
                />
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate">{creatorName}</span>
                  <span className="shrink-0 text-tertiary">
                    <ComputerDate value={computer.connectedAt} timeZone={timeZone} />
                  </span>
                </span>
              </span>
            </Stat>
          )}
        </dl>
      )}
      {runtimeSlot && (
        <ComputerUpgradeSlot
          slot={runtimeSlot}
          canUpgrade={canUpgrade}
          computerName={label}
          cloud={false}
          online={computer.online}
          upgradeInFlight={upgradeInFlight}
          onUpgrade={onRuntimeUpgrade}
        />
      )}
      {isCloud && imageSlot && (
        <ComputerUpgradeSlot
          slot={imageSlot}
          canUpgrade={canUpgrade}
          computerName={label}
          cloud
          online={computer.online}
          upgradeInFlight={upgradeInFlight}
          onUpgrade={onImageUpgrade}
        />
      )}
    </div>
  );
}

/** One fact of the strip: its label over its value. */
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-tertiary">{label}</dt>
      <dd className="mt-1 min-h-6 text-sm text-primary">{children}</dd>
    </div>
  );
}

/** How full the disk or memory is: "9% used" ("已用 9%") over a thin bar, in the warning colour when `warn`
 * and the disk is low; the amounts in its tooltip. */
function MachineUsage({
  reading,
  base,
  warn = false,
}: {
  reading: MachineStatusReading;
  base: 1000 | 1024;
  warn?: boolean;
}) {
  const percent = machineUsedPercent(reading);
  const low = warn && isMachineDiskLow(reading);
  return (
    <Tooltip title={machineUsageLabel(reading, base)}>
      <TooltipTrigger className="flex flex-col items-start gap-1.5 rounded-sm text-start">
        <span className={cn("tabular-nums", low && "text-warning-primary")}>
          {usedPercentText(percent)}
        </span>
        <ProgressBarBase
          value={percent}
          className="h-1.5 w-32 rounded-full"
          progressClassName={cn("rounded-full", low && "bg-warning-solid")}
        />
      </TooltipTrigger>
    </Tooltip>
  );
}
