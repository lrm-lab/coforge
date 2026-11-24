import type { ReactNode } from "react";
import { Heading } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "#src/components/ui/modal";
import { StatusDot } from "#src/components/ui/status-dot";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ComputerDate } from "./computer-detail-date";
import type { ComputerDetailView } from "./computer-detail-view";
import { operatingSystemLabel } from "./computer-identity";
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
  isLatestVersion = false,
  versionNotice,
  showRecoveryAdvice = false,
  imageSlot,
  canUpgrade,
  upgradeInFlight,
  onImageUpgrade,
  runtimes,
}: {
  computer: ComputerDetailView;
  label: string;
  timeZone: string | null;
  creatorName: string;
  isCloud: boolean;
  currentVersion: string | null | undefined;
  currentImageVersion: string | null | undefined;
  isLatestVersion?: boolean;
  versionNotice?: RuntimeUpgradeVersionNotice;
  showRecoveryAdvice?: boolean;
  imageSlot: ComputerUpgradeSlotState | null;
  canUpgrade: boolean;
  upgradeInFlight: boolean;
  onImageUpgrade: () => void;
  runtimes?: ReactNode;
}) {
  const os = operatingSystemLabel(computer);
  const disk = computer.machine?.disk;
  const memory = computer.machine?.memory;
  const imageVersion = isCloud ? currentImageVersion : null;

  return (
    <section className="space-y-4 border-b border-secondary px-page py-4">
      <h2 className="text-xs font-medium text-tertiary">{m.computer_detail_info_section()}</h2>

      <div className="space-y-4">
        {os ? (
          <InfoField label={m.computer_os()}>
            <span>{os}</span>
          </InfoField>
        ) : null}

        {currentVersion ? (
          <InfoField label={m.computer_version()}>
            <div className="flex min-w-0 flex-col items-start gap-1">
              <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                <span dir="ltr" className="font-mono">
                  {currentVersion}
                </span>
                {versionNotice?.kind === "upgrading" &&
                versionNotice.version &&
                versionNotice.version !== currentVersion ? (
                  <span dir="ltr" className="font-mono text-tertiary">
                    → {versionNotice.version}
                  </span>
                ) : isLatestVersion ? (
                  <span className="text-xs text-tertiary">
                    · {m.computer_overview_latest_version()}
                  </span>
                ) : null}
              </span>
              {versionNotice ? <VersionUpgradeNotice notice={versionNotice} /> : null}
              {showRecoveryAdvice &&
              !isCloud &&
              canUpgrade &&
              computer.online &&
              !upgradeInFlight ? (
                <div className="text-xs">
                  <InstallerRecoveryAdvice
                    computerId={computer.id}
                    command={<UpgradeCommand command="coforge-computer repair" />}
                  />
                </div>
              ) : null}
            </div>
          </InfoField>
        ) : null}

        {imageVersion ? (
          <InfoField label={m.computer_image_version()}>
            <span dir="ltr" className="font-mono">
              {imageVersion}
            </span>
          </InfoField>
        ) : null}

        {disk || memory ? (
          <div className="grid max-w-md grid-cols-2 gap-6">
            {disk ? (
              <InfoField label={m.computer_disk()}>
                <MachineUsage reading={disk} base={1000} warn />
              </InfoField>
            ) : null}
            {memory ? (
              <InfoField label={m.computer_memory()}>
                <MachineUsage reading={memory} base={1024} />
              </InfoField>
            ) : null}
          </div>
        ) : null}

        {runtimes ? (
          <section aria-labelledby="computer-runtimes">
            <h3 id="computer-runtimes" className="text-xs text-tertiary">
              {m.computer_runtimes()}
            </h3>
            <div className="mt-2">{runtimes}</div>
          </section>
        ) : null}

        {computer.connectedAt || computer.creator ? (
          <div className="flex flex-wrap gap-x-10 gap-y-3 pt-1">
            {computer.connectedAt ? (
              <InfoField label={m.computer_connected_at()}>
                <ComputerDate value={computer.connectedAt} timeZone={timeZone} />
              </InfoField>
            ) : null}
            {computer.creator ? (
              <InfoField label={m.computer_added_by()}>
                <span className="flex min-w-0 items-center gap-2">
                  <ActorAvatar
                    presence={false}
                    size="xs"
                    className="size-5"
                    name={creatorName}
                    src={computer.creator.avatarUrl}
                  />
                  <span className="truncate font-medium">{creatorName}</span>
                </span>
              </InfoField>
            ) : null}
          </div>
        ) : null}

        {isCloud && imageSlot ? (
          <ComputerUpgradeSlot
            slot={imageSlot}
            canUpgrade={canUpgrade}
            computerName={label}
            cloud
            online={computer.online}
            upgradeInFlight={upgradeInFlight}
            onUpgrade={onImageUpgrade}
          />
        ) : null}
      </div>
    </section>
  );
}

function InfoField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-tertiary">{label}</div>
      <div className="mt-1 text-sm text-primary">{children}</div>
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
    <div className="flex w-full flex-col items-start gap-1.5">
      <span className={cn("text-xs font-medium tabular-nums", low && "text-warning-primary")}>
        {usedPercentText(percent)}
      </span>
      <ProgressBarBase
        value={percent}
        className="h-1.5 w-full rounded-full"
        progressClassName={cn("rounded-full", low && "bg-warning-solid")}
      />
      <span className="truncate text-xs text-quaternary tabular-nums">{details}</span>
    </div>
  );
}
