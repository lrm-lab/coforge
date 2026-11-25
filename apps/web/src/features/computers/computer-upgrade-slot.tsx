import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy01 as Copy, XClose } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { ComputerReleaseNotesLink, useComputerRelease } from "./computer-release-notes";
import type { ComputerUpgradeRequest } from "./computer-upgrade-slot-state";

export type { ComputerUpgradeRequest };

export function UpgradeCommand({ command }: { command: string }) {
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
    <ModalOverlay
      confirmation
      isOpen={open}
      onOpenChange={(next) => {
        if (confirming) return;
        onOpenChange(next);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-start">
          {({ close }) => (
            <>
              <div className="px-6 pt-6">
                <div className="flex items-start justify-between gap-4">
                  <Heading
                    slot="title"
                    dir="auto"
                    className="line-clamp-3 min-w-0 text-lg font-semibold text-primary wrap-anywhere sm:text-xl"
                  >
                    {title}
                  </Heading>
                  <ButtonUtility
                    data-dialog-close
                    aria-label={m.controls_close()}
                    icon={XClose}
                    size="sm"
                    color="tertiary"
                    className="shrink-0"
                    isDisabled={confirming}
                    onClick={close}
                  />
                </div>
                {children}
              </div>
              <DialogActions className="px-6 py-4">
                <DialogCancel type="button" isDisabled={confirming} onPress={() => close()}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  autoFocus
                  type="button"
                  isDisabled={confirming}
                  isLoading={confirming}
                  showTextWhileLoading
                  onPress={() => void guard(onConfirm)}
                >
                  {confirmLabel}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

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
  const release = useComputerRelease(targetVersion ?? undefined);
  return (
    <UpgradeConfirmFrame
      open={open}
      onOpenChange={onOpenChange}
      title={m.computer_upgrade_confirm_title({ name: computerName })}
      confirmLabel={m.computer_upgrade_confirm_submit()}
      onConfirm={onConfirm}
    >
      {(currentVersion && targetVersion) || release ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {currentVersion && targetVersion && (
            <p dir="ltr" className="font-mono text-secondary wrap-anywhere">
              {currentVersion} <span className="text-quaternary">→</span>{" "}
              <span className="font-medium text-primary">{targetVersion}</span>
            </p>
          )}
          {release && <ComputerReleaseNotesLink release={release} size="sm" />}
        </div>
      ) : null}
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

export function CloudImageUpdateDialog({
  open,
  name,
  currentVersion,
  version,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  name: string;
  currentVersion?: string | null;
  version?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const release = useComputerRelease(version ?? undefined);
  return (
    <UpgradeConfirmFrame
      open={open}
      onOpenChange={onOpenChange}
      title={m.computer_cloud_image_update_confirm_title({ name })}
      confirmLabel={m.computer_cloud_image_update_confirm()}
      onConfirm={onConfirm}
    >
      {(currentVersion && version) || version || release ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {currentVersion && version ? (
            <p dir="ltr" className="font-mono text-secondary wrap-anywhere">
              {currentVersion} <span className="text-quaternary">→</span>{" "}
              <span className="font-medium text-primary">{version}</span>
            </p>
          ) : version ? (
            <p dir="ltr" className="font-mono font-medium text-primary wrap-anywhere">
              {version}
            </p>
          ) : null}
          {release && <ComputerReleaseNotesLink release={release} size="sm" />}
        </div>
      ) : null}
      <div className="mt-4 flex gap-2.5 rounded-lg bg-warning-primary px-3 py-2.5 text-sm text-warning-primary">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-warning-primary" />
        <p>{m.computer_cloud_image_update_confirm_runs_stop()}</p>
      </div>
      <div className="mt-2.5 flex gap-2.5 px-3 text-sm text-secondary">
        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-success-primary" />
        <p>{m.computer_cloud_image_update_confirm_kept()}</p>
      </div>
    </UpgradeConfirmFrame>
  );
}
