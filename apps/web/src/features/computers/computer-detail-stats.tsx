import type { ReactNode } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Heading,
  Popover as AriaPopover,
} from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "#src/components/ui/modal";
import { StatusDot } from "#src/components/ui/status-dot";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import { ComputerDate } from "./computer-detail-date";
import type { ComputerDetailView } from "./computer-detail-view";
import {
  isMachineDiskLow,
  machineUsageLabel,
  machineUsedPercent,
  type MachineStatusReading,
} from "./computer-machine-status";
import { ComputerReleaseNotesLink, useComputerRelease } from "./computer-release-notes";
import type { RuntimeUpgradeVersionNotice } from "./computer-upgrade-progress-view";
import {
  ComputerUpgradeSlot,
  UpgradeCommand,
  type ComputerUpgradeSlotState,
} from "./computer-upgrade-slot";
import { InstallerRecoveryAdvice } from "./installer-recovery-advice";
import { usedPercentText } from "./usage-window";

export function ComputerDetailStats({
  computer,
  label,
  timeZone,
  creatorName,
  isCloud,
  currentVersion,
  currentImageVersion,
  versionNotice,
  showRecoveryAdvice = false,
  imageSlot,
  canUpgrade,
  upgradeInFlight,
  onImageUpgrade,
}: {
  computer: ComputerDetailView;
  label: string;
  timeZone: string | null;
  creatorName: string;
  isCloud: boolean;
  currentVersion: string | null | undefined;
  currentImageVersion: string | null | undefined;
  versionNotice?: RuntimeUpgradeVersionNotice;
  showRecoveryAdvice?: boolean;
  imageSlot: ComputerUpgradeSlotState | null;
  canUpgrade: boolean;
  upgradeInFlight: boolean;
  onImageUpgrade: () => void;
}) {
  const disk = computer.machine?.disk;
  const memory = computer.machine?.memory;
  const imageVersion = isCloud ? currentImageVersion : null;
  const hasFacts = Boolean(disk || memory || currentVersion || imageVersion || computer.creator);
  if (!hasFacts && !(isCloud && imageSlot)) return null;
  return (
    <div className="flex flex-col gap-4">
      {hasFacts && (
        <dl className="flex flex-wrap gap-x-12 gap-y-5">
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
              <div className="flex min-w-0 flex-col items-start gap-1">
                <span className="inline-flex flex-wrap items-baseline gap-x-1.5" dir="ltr">
                  <span>{currentVersion}</span>
                  {versionNotice?.kind === "upgrading" &&
                    versionNotice.version &&
                    versionNotice.version !== currentVersion && (
                      <span className="text-tertiary">→ {versionNotice.version}</span>
                    )}
                </span>
                {versionNotice && <VersionUpgradeNotice notice={versionNotice} />}
                {showRecoveryAdvice &&
                  !isCloud &&
                  canUpgrade &&
                  computer.online &&
                  !upgradeInFlight && (
                    <div className="text-xs">
                      <InstallerRecoveryAdvice
                        computerId={computer.id}
                        command={<UpgradeCommand command="coforge-computer repair" />}
                      />
                    </div>
                  )}
              </div>
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

function VersionUpgradeNotice({ notice }: { notice: RuntimeUpgradeVersionNotice }) {
  if (notice.kind === "issue") {
    return <VersionUpgradeIssueNotice notice={notice} />;
  }
  return <VersionUpgradeReleaseNotice notice={notice} />;
}

function VersionUpgradeReleaseNotice({
  notice,
}: {
  notice: Extract<RuntimeUpgradeVersionNotice, { kind: "available" | "upgrading" }>;
}) {
  const release = useComputerRelease(notice.version);
  if (notice.kind === "upgrading") {
    if (!release) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <ComputerReleaseNotesLink release={release} size="xs" />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 wrap-anywhere",
          notice.offline ? "text-tertiary" : "font-medium text-fg-success-primary",
        )}
      >
        {!notice.offline && <StatusDot tone="online" className="size-1.5" />}
        {m.computer_upgrade_available_title({ version: notice.version })}
      </span>
      {notice.prerelease && (
        <Badge type="pill-color" color="warning" size="sm">
          {m.computer_upgrade_prerelease()}
        </Badge>
      )}
      {release && <ComputerReleaseNotesLink release={release} size="xs" />}
    </div>
  );
}

function VersionUpgradeIssueNotice({
  notice,
}: {
  notice: Extract<RuntimeUpgradeVersionNotice, { kind: "issue" }>;
}) {
  const hasDetails = Boolean(
    notice.detail ||
    (notice.steps && notice.steps.length > 0) ||
    (notice.unsettledWorkspaces && notice.unsettledWorkspaces.length > 0) ||
    notice.errorId,
  );
  const textColor = notice.tone === "error" ? "text-error-primary" : "text-warning-primary";

  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 font-medium wrap-anywhere",
          textColor,
        )}
      >
        <StatusDot tone={notice.tone} className="size-1.5" />
        {notice.title}
      </span>
      {hasDetails && (
        <DialogTrigger>
          <Button type="button" size="xs" color="link-gray">
            {m.computer_upgrade_issue_details()}
          </Button>
          <ModalOverlay isDismissable>
            <Modal className="w-[calc(100vw-2rem)] max-w-lg">
              <Dialog className="text-left">
                <div className="px-6 pt-6">
                  <Heading
                    slot="title"
                    className="text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                  >
                    {notice.title}
                  </Heading>
                  <p className="mt-2 text-sm text-tertiary">{notice.detail}</p>
                  {notice.steps && notice.steps.length > 0 && (
                    <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm text-secondary">
                      {notice.steps.map((step, index) => (
                        <li key={index}>
                          {step.text}
                          {step.command && (
                            <>
                              {" "}
                              <UpgradeCommand command={step.command} />
                            </>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                  {notice.unsettledWorkspaces && notice.unsettledWorkspaces.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-secondary">
                      {notice.unsettledWorkspaces.map((name, index) => (
                        <li key={`${name}-${index}`} className="wrap-anywhere">
                          {name}
                        </li>
                      ))}
                    </ul>
                  )}
                  {notice.errorId && (
                    <p className="mt-3 text-xs text-quaternary">
                      {m.error_reference({ errorId: notice.errorId })}
                    </p>
                  )}
                </div>
                <DialogActions className="px-6 py-4">
                  <DialogCancel slot="close">{m.controls_close()}</DialogCancel>
                </DialogActions>
              </Dialog>
            </Modal>
          </ModalOverlay>
        </DialogTrigger>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-tertiary">{label}</dt>
      <dd className="mt-1 min-h-6 text-sm text-primary">{children}</dd>
    </div>
  );
}

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
  const details = machineUsageLabel(reading, base);
  return (
    <AriaDialogTrigger>
      <AriaButton className="flex cursor-pointer flex-col items-start gap-1.5 rounded-sm text-start outline-focus-ring focus-visible:outline-2">
        <span className={cn("tabular-nums", low && "text-warning-primary")}>
          {usedPercentText(percent)}
        </span>
        <ProgressBarBase
          value={percent}
          className="h-1.5 w-32 rounded-full"
          progressClassName={cn("rounded-full", low && "bg-warning-solid")}
        />
      </AriaButton>
      <AriaPopover
        placement="bottom start"
        offset={6}
        className={cn(
          "origin-(--trigger-anchor-point) rounded-lg bg-primary px-3 py-2 text-xs font-medium text-secondary shadow-lg ring-1 ring-secondary_alt outline-hidden will-change-transform",
          POPOVER_MOTION,
        )}
      >
        <AriaDialog aria-label={details} className="outline-hidden">
          {details}
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
