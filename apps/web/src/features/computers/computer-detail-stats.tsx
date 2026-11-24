import type { ReactNode } from "react";
import { Heading } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "#src/components/ui/modal";
import { StatusDot } from "#src/components/ui/status-dot";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ComputerDate } from "./computer-detail-date";
import type { ComputerDetailView } from "./computer-detail-view";
import { operatingSystemLabel } from "./computer-identity";
import { ComputerReleaseNotesLink, useComputerRelease } from "./computer-release-notes";
import type { RuntimeUpgradeVersionNotice } from "./computer-upgrade-progress-view";
import {
  ComputerUpgradeSlot,
  UpgradeCommand,
  type ComputerUpgradeSlotState,
} from "./computer-upgrade-slot";
import { InstallerRecoveryAdvice } from "./installer-recovery-advice";

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
  runtimesAction,
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
  runtimesAction?: ReactNode;
  runtimes?: ReactNode;
}) {
  const os = operatingSystemLabel(computer);
  const imageVersion = isCloud ? currentImageVersion : null;
  const showInlineRecoveryAdvice = Boolean(
    showRecoveryAdvice && !isCloud && canUpgrade && computer.online && !upgradeInFlight,
  );
  const versionWide = Boolean(versionNotice || showInlineRecoveryAdvice);
  const hasSpecs = Boolean(
    currentVersion || os || imageVersion || computer.connectedAt || computer.creator,
  );

  return (
    <section className="space-y-4 border-b border-secondary px-page py-4 last:border-b-0">
      {runtimes ? (
        <section aria-labelledby="computer-runtimes">
          <div className="flex items-center justify-between gap-2">
            <h2 id="computer-runtimes" className="text-xs font-medium text-tertiary">
              {m.computer_detail_ai_tools()}
            </h2>
            {runtimesAction}
          </div>
          <div className="mt-2.5">{runtimes}</div>
        </section>
      ) : null}

      {hasSpecs ? (
        <div
          className={cn(
            "grid grid-cols-2 gap-x-6 gap-y-3.5",
            runtimes && "border-t border-secondary pt-4",
          )}
        >
          {currentVersion ? (
            <InfoField
              label={m.computer_version()}
              className={versionWide ? "col-span-2" : undefined}
            >
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
                      {m.computer_overview_latest_version()}
                    </span>
                  ) : null}
                </span>
                {versionNotice ? <VersionUpgradeNotice notice={versionNotice} /> : null}
                {showInlineRecoveryAdvice ? (
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

          {os ? (
            <InfoField label={m.computer_os()}>
              <span className="wrap-anywhere">{os}</span>
            </InfoField>
          ) : null}

          {imageVersion ? (
            <InfoField label={m.computer_image_version()}>
              <span dir="ltr" className="font-mono">
                {imageVersion}
              </span>
            </InfoField>
          ) : null}

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
    </section>
  );
}

function InfoField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-xs text-quaternary">{label}</div>
      <div className="mt-0.5 text-sm text-primary">{children}</div>
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
