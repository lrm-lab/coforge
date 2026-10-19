import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Copy01 as Copy,
  RefreshCw01 as RotateCw,
} from "@untitledui/icons";
import { Heading, ProgressBar, Text } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { Alert } from "#src/components/ui/alert";
import { ProgressSteps } from "#src/components/ui/progress-steps";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { cloudImageUpdateConsequences } from "./cloud-image-update";
import { ComputerReleaseNotesLink, useComputerRelease } from "./computer-release-notes";
import { availableUpdateVersion, isPrereleaseVersion } from "./computer-identity";
import type { ComputerUpgradeOutcome, UpgradeRequestErrorCopy } from "./upgrade-failure";

/** An upgrade this panel asked for, with the release it asked for: in flight, held by the server,
 * or refused before the server held it (which leaves no record a reload could find). */
export type ComputerUpgradeRequest =
  | { state: "idle" }
  | { state: "requesting"; version?: string }
  | { state: "accepted"; requestId: string; version?: string }
  | ({ state: "refused"; version?: string } & UpgradeRequestErrorCopy);

/** What the slot under the Version row shows (rules in features/computers/AGENTS.md). `offer` is
 * the newer release, which an available slot installs and a failed one retries; `version` the
 * release an upgrade was to install. */
export type ComputerUpgradeSlotState =
  | { state: "available"; offer: string }
  | { state: "upgrading"; version?: string; delivered: boolean }
  | { state: "failed"; version?: string; failure: UpgradeRequestErrorCopy; offer?: string };

/**
 * The slot's one reading of an upgrade, this panel's own request and the Computer: running and
 * failed upgrades and a newer release for everyone, with Upgrade and Retry only for its owner,
 * nothing otherwise. A stored failure names no release; one this panel requested names the release
 * it asked for.
 */
export function upgradeSlotState({
  upgrade,
  request,
  computer,
  currentVersion,
  latestComputerVersion,
}: {
  upgrade: ComputerUpgradeOutcome | { state: "idle" };
  request: ComputerUpgradeRequest;
  computer: Parameters<typeof availableUpdateVersion>[0];
  /** The version it runs, or the one an upgrade here just reached. */
  currentVersion: string | null | undefined;
  latestComputerVersion: string | null | undefined;
}): ComputerUpgradeSlotState | null {
  // An upgrade that just succeeded used up a cloud Computer's image offer too.
  const offer = availableUpdateVersion(
    {
      ...computer,
      computerVersion: currentVersion,
      imageUpdate: upgrade.state === "succeeded" ? null : computer.imageUpdate,
    },
    latestComputerVersion,
  );
  const requested = request.state === "idle" ? undefined : request.version;
  if (upgrade.state === "running")
    return {
      state: "upgrading",
      version: upgrade.version ?? requested,
      delivered: request.state !== "requesting",
    };
  if (upgrade.state === "failed")
    return {
      state: "failed",
      version: upgrade.version ?? requested,
      failure: upgrade.failure,
      offer,
    };
  return offer ? { state: "available", offer } : null;
}

/** The release a slot is about: the one on offer, the one an upgrade is installing, or after a
 * failure the one Retry would install (the release that failed when nothing newer is on offer). */
function slotRelease(slot: ComputerUpgradeSlotState): string | undefined {
  if (slot.state === "available") return slot.offer;
  if (slot.state === "upgrading") return slot.version;
  return slot.offer ?? slot.version;
}

/** The bordered area under a Computer's Version row, with that release's "What's new" when the
 * catalog has notes for it. Upgrade and Retry show only when `canUpgrade` (the owner); `onUpgrade`
 * opens the confirmation. */
export function ComputerUpgradeSlot({
  slot,
  canUpgrade,
  computerName,
  cloud,
  online,
  onUpgrade,
}: {
  slot: ComputerUpgradeSlotState;
  canUpgrade: boolean;
  computerName: string;
  cloud: boolean;
  online: boolean;
  onUpgrade: () => void;
}) {
  const release = useComputerRelease(slotRelease(slot));
  const retry = canUpgrade && slot.state === "failed" && slot.offer !== undefined;
  const whatsNew = release && <ComputerReleaseNotesLink release={release} />;

  if (slot.state === "upgrading")
    return (
      <Alert
        color="brand"
        actions={whatsNew}
        className="mt-3"
        title={
          slot.version
            ? m.computer_upgrade_running_title({ version: slot.version })
            : m.computer_upgrade_in_progress()
        }
        // The sweeping bar is the panel's one animation; the stages under it stay still.
        description={
          <>
            <ProgressBar
              isIndeterminate
              aria-label={m.computer_upgrade_in_progress()}
              className="mt-2 h-1 w-full overflow-hidden rounded-full bg-quaternary"
            >
              <div className="h-full w-1/3 rounded-full bg-fg-brand-primary motion-safe:animate-progress-indeterminate" />
            </ProgressBar>
            <ProgressSteps
              className="mt-3"
              items={[
                {
                  title: m.computer_upgrade_step_delivered({ name: computerName }),
                  status: slot.delivered ? "complete" : "current",
                },
                {
                  title: m.computer_upgrade_step_installing(),
                  status: slot.delivered ? "current" : "incomplete",
                },
              ]}
            />
          </>
        }
      />
    );

  if (slot.state === "failed") {
    const { failure } = slot;
    return (
      <Alert
        color="error"
        className="mt-3"
        title={
          slot.version
            ? m.computer_upgrade_failed_title({ version: slot.version })
            : m.computer_upgrade_failed_title_generic()
        }
        description={
          <>
            <p>{failure.headline}</p>
            {failure.steps.length > 0 && (
              <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-secondary">
                {failure.steps.map((step, index) => (
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
            {failure.errorId && (
              <p className="mt-2 text-xs">{m.error_reference({ errorId: failure.errorId })}</p>
            )}
          </>
        }
        actions={
          (whatsNew || retry) && (
            <>
              {whatsNew}
              {retry && (
                <Button
                  type="button"
                  size="sm"
                  color="secondary"
                  iconLeading={RotateCw}
                  isDisabled={!online}
                  onPress={onUpgrade}
                >
                  {m.computer_upgrade_retry()}
                </Button>
              )}
            </>
          )
        }
      />
    );
  }

  // A member who cannot upgrade is told the release exists, and nothing they cannot act on.
  if (!canUpgrade)
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary">
        <span className="min-w-0 wrap-anywhere">
          {m.computer_upgrade_available_notice({ version: slot.offer })}
        </span>
        {isPrereleaseVersion(slot.offer) && (
          <Badge type="pill-color" color="warning" size="sm">
            {m.computer_upgrade_prerelease()}
          </Badge>
        )}
        {whatsNew}
      </div>
    );

  return (
    <Alert
      className="mt-3"
      // Offline, the default gray icon instead of the green one.
      icon={
        online ? <FeaturedIcon color="success" theme="light" size="sm" icon={ArrowUp} /> : ArrowUp
      }
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 wrap-anywhere">
            {cloud
              ? m.computer_cloud_image_update_available_title({ version: slot.offer })
              : m.computer_upgrade_available_title({ version: slot.offer })}
          </span>
          {isPrereleaseVersion(slot.offer) && (
            <Badge type="pill-color" color="warning" size="sm">
              {m.computer_upgrade_prerelease()}
            </Badge>
          )}
        </span>
      }
      description={
        !online
          ? m.computer_upgrade_offline()
          : cloud
            ? m.computer_cloud_image_update_available_body()
            : m.computer_upgrade_available_body({ name: computerName })
      }
      actions={
        <>
          {whatsNew}
          <Button type="button" size="sm" color="primary" isDisabled={!online} onPress={onUpgrade}>
            {cloud ? m.computer_cloud_image_update_action() : m.computer_upgrade()}
          </Button>
        </>
      }
    />
  );
}

/** One failure-recovery command, in the app's mono command style, with a copy-to-clipboard
 * affordance - the same `ButtonUtility` + Copy/Check pattern `ComputerInstallCommand` already
 * uses, sized for an inline list item rather than a terminal block. */
function UpgradeCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 align-middle font-mono text-xs text-secondary">
      {command}
      <ButtonUtility
        icon={copied ? Check : Copy}
        size="xs"
        color="tertiary"
        aria-label={m.computer_copy_command()}
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
        }}
      />
    </span>
  );
}

/** The shell both upgrade confirmations share: title, body, Cancel and the confirm button. */
function UpgradeConfirmFrame({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  children: ReactNode;
}) {
  const [confirming, guard] = useSubmitGuard();
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange}>
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <div className="px-6 pt-6">
                <Heading
                  slot="title"
                  className="text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                >
                  {title}
                </Heading>
                {children}
              </div>
              <div className="flex justify-end gap-2 px-6 py-4">
                <Button
                  type="button"
                  size="sm"
                  color="secondary"
                  isDisabled={confirming}
                  onPress={() => close()}
                >
                  {m.controls_cancel()}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  isDisabled={confirming}
                  isLoading={confirming}
                  showTextWhileLoading
                  onPress={() => void guard(onConfirm)}
                >
                  {confirmLabel}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * Confirms a local Computer's upgrade before it restarts the daemon. The copy is generic: the panel
 * does not count running Agents, so it states what any restart stops and what it keeps.
 */
export function ComputerUpgradeConfirmDialog({
  open,
  onOpenChange,
  computerName,
  currentVersion,
  targetVersion,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computerName: string;
  currentVersion?: string | null;
  targetVersion?: string | null;
  onConfirm: () => Promise<void>;
}) {
  return (
    <UpgradeConfirmFrame
      open={open}
      onOpenChange={onOpenChange}
      title={m.computer_upgrade_confirm_title({ name: computerName })}
      confirmLabel={m.computer_upgrade_confirm_submit()}
      onConfirm={onConfirm}
    >
      {currentVersion && targetVersion && (
        <p className="mt-2 font-mono text-sm text-secondary wrap-anywhere">
          {currentVersion} <span className="text-quaternary">→</span>{" "}
          <span className="font-medium text-primary">{targetVersion}</span>
        </p>
      )}
      <div className="mt-4 flex gap-2.5 rounded-lg bg-warning-primary px-3 py-2.5 text-sm text-warning-primary">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-warning-primary" />
        <p>{m.computer_upgrade_confirm_runs_stop()}</p>
      </div>
      <div className="mt-2.5 flex gap-2.5 px-3 text-sm text-secondary">
        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-success-primary" />
        <p>{m.computer_upgrade_confirm_kept()}</p>
      </div>
    </UpgradeConfirmFrame>
  );
}

/** Confirms replacing a cloud Computer's container image: what the update loses and what it keeps. */
export function CloudImageUpdateDialog({
  open,
  name,
  version,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  name: string;
  version?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const lossCopy: Record<(typeof cloudImageUpdateConsequences.lost)[number], string> = {
    in_flight_runs: m.computer_cloud_image_update_loss_in_flight_runs(),
    volatile_memory: m.computer_cloud_image_update_loss_volatile_memory(),
    brief_disconnect: m.computer_cloud_image_update_loss_brief_disconnect(),
  };
  const keepCopy: Record<(typeof cloudImageUpdateConsequences.kept)[number], string> = {
    volume_files: m.computer_cloud_image_update_keep_volume_files(),
    workspace_bindings: m.computer_cloud_image_update_keep_workspace_bindings(),
    agents_after_reconnect: m.computer_cloud_image_update_keep_agents_after_reconnect(),
  };
  return (
    <UpgradeConfirmFrame
      open={open}
      onOpenChange={onOpenChange}
      title={m.computer_cloud_image_update_dialog_title({ name, version: version ?? "" })}
      confirmLabel={m.computer_cloud_image_update_confirm()}
      onConfirm={onConfirm}
    >
      <Text className="mt-2 block text-sm text-tertiary">
        {m.computer_cloud_image_update_body()}
      </Text>
      <p className="mt-4 text-sm font-medium text-primary">
        {m.computer_cloud_image_update_lost_title()}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-tertiary">
        {cloudImageUpdateConsequences.lost.map((item) => (
          <li key={item}>{lossCopy[item]}</li>
        ))}
      </ul>
      <p className="mt-4 text-sm font-medium text-primary">
        {m.computer_cloud_image_update_kept_title()}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-tertiary">
        {cloudImageUpdateConsequences.kept.map((item) => (
          <li key={item}>{keepCopy[item]}</li>
        ))}
      </ul>
    </UpgradeConfirmFrame>
  );
}
