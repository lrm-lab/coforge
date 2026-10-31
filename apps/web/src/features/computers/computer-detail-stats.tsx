import { ComputerUpgradeSlot, type ComputerUpgradeSlotState } from "./computer-upgrade-slot";
import { computerImageVersionLabel, computerVersionLabel } from "./computer-identity";
import { ComputerDate } from "./computer-detail-date";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
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
 * Image), who added it — each a small label over its value, with no box around them (Coder's
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
  onRuntimeUpgrade: () => void;
  onImageUpgrade: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-wrap gap-x-12 gap-y-5">
        <Stat label={m.computer_disk()}>
          <MachineUsage reading={computer.machine?.disk ?? null} base={1000} warn />
        </Stat>
        <Stat label={m.computer_memory()}>
          <MachineUsage reading={computer.machine?.memory ?? null} base={1024} />
        </Stat>
        <Stat label={m.computer_version()}>
          <span className="font-mono">
            {computerVersionLabel({ computerVersion: currentVersion })}
          </span>
        </Stat>
        {isCloud && (
          <Stat label={m.computer_image_version()}>
            <span className="font-mono">
              {computerImageVersionLabel({ imageVersion: currentImageVersion })}
            </span>
          </Stat>
        )}
        {computer.creator && (
          <Stat label={m.computer_added_by()}>
            <span className="flex min-w-0 items-center gap-2">
              <IdentityAvatar size="xs" name={creatorName} src={computer.creator.avatarUrl} />
              <span className="truncate">
                {creatorName} · <ComputerDate value={computer.connectedAt} timeZone={timeZone} />
              </span>
            </span>
          </Stat>
        )}
      </dl>
      {runtimeSlot && (
        <ComputerUpgradeSlot
          slot={runtimeSlot}
          canUpgrade={canUpgrade}
          computerName={label}
          cloud={false}
          online={computer.online}
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
 * and the disk is low; the amounts in its tooltip. "Unknown", with no bar, without a current
 * reading. */
function MachineUsage({
  reading,
  base,
  warn = false,
}: {
  reading: MachineStatusReading | null;
  base: 1000 | 1024;
  warn?: boolean;
}) {
  if (!reading) return m.computer_metadata_unknown();
  const percent = machineUsedPercent(reading);
  const low = warn && isMachineDiskLow(reading);
  return (
    <Tooltip title={machineUsageLabel(reading, base)}>
      <TooltipTrigger className="flex flex-col items-start gap-1.5 rounded-sm text-left">
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
