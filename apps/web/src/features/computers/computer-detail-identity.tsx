import { ComputerUpgradeSlot, type ComputerUpgradeSlotState } from "./computer-upgrade-slot";
import {
  computerImageVersionLabel,
  computerVersionLabel,
  operatingSystemLabel,
} from "./computer-identity";
import { DetailRow } from "./computer-detail-rows";
import { ComputerDate } from "./computer-detail-date";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { m } from "#src/paraglide/messages";
import type { ComputerDetailView } from "./computer-detail-view";
import {
  isMachineDiskLow,
  machineUsageLabel,
  type MachineStatusReading,
} from "./computer-machine-status";
import { cn } from "#src/lib/utils";

/** Hostname, OS, Disk, Memory, Version/Image rows (and their upgrade slots), and who added the Computer. */
export function ComputerDetailIdentityRows({
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
    <dl className="divide-y divide-secondary">
      <DetailRow
        label={m.computer_hostname()}
        value={<span className="font-mono">{computer.name}</span>}
      />
      <DetailRow label={m.computer_system()} value={operatingSystemLabel(computer)} />
      <DetailRow
        label={m.computer_disk()}
        value={<MachineUsage reading={computer.machine?.disk ?? null} base={1000} warn />}
      />
      <DetailRow
        label={m.computer_memory()}
        value={<MachineUsage reading={computer.machine?.memory ?? null} base={1024} />}
      />
      <DetailRow
        label={m.computer_version()}
        value={
          <span className="font-mono">
            {computerVersionLabel({ computerVersion: currentVersion })}
          </span>
        }
        footer={
          runtimeSlot && (
            <ComputerUpgradeSlot
              slot={runtimeSlot}
              canUpgrade={canUpgrade}
              computerName={label}
              cloud={false}
              online={computer.online}
              onUpgrade={onRuntimeUpgrade}
            />
          )
        }
      />
      {isCloud && (
        <DetailRow
          label={m.computer_image_version()}
          value={
            <span className="font-mono">
              {computerImageVersionLabel({ imageVersion: currentImageVersion })}
            </span>
          }
          footer={
            imageSlot && (
              <ComputerUpgradeSlot
                slot={imageSlot}
                canUpgrade={canUpgrade}
                computerName={label}
                cloud
                online={computer.online}
                onUpgrade={onImageUpgrade}
              />
            )
          }
        />
      )}
      {computer.creator && (
        <DetailRow
          label={m.computer_added_by()}
          value={
            <span className="flex min-w-0 items-center justify-end gap-2">
              <IdentityAvatar size="xs" name={creatorName} src={computer.creator.avatarUrl} />
              <span className="truncate">
                {creatorName} · <ComputerDate value={computer.connectedAt} timeZone={timeZone} />
              </span>
            </span>
          }
        />
      )}
    </dl>
  );
}

/** Used / total, in the warning colour when `warn` and the disk is low; "Unknown" without a
 * current reading. */
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
  return (
    <span
      className={cn("tabular-nums", warn && isMachineDiskLow(reading) && "text-warning-primary")}
    >
      {machineUsageLabel(reading, base)}
    </span>
  );
}
