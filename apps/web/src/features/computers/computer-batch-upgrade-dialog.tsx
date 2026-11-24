import { AlertTriangle, Check, XClose } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import type { BatchUpgradeCandidate } from "./computer-overview-model";
import { ComputerReleaseNotesLink, useComputerRelease } from "./computer-release-notes";

function BatchUpgradeReleaseBadge({ version }: { version: string }) {
  const release = useComputerRelease(version);
  if (!release) return null;
  return <ComputerReleaseNotesLink release={release} size="sm" />;
}

export function ComputerBatchUpgradeDialog({
  open,
  onOpenChange,
  candidates,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: readonly BatchUpgradeCandidate[];
  onConfirm: () => Promise<void>;
}) {
  const [confirming, guard] = useSubmitGuard();
  const uniqueTargets = [...new Set(candidates.map((candidate) => candidate.targetVersion))];

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
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <div className="px-6 pt-6">
                <div className="flex items-start justify-between gap-4">
                  <Heading
                    slot="title"
                    className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                  >
                    {m.computer_upgrade_all_title({ count: candidates.length })}
                  </Heading>
                  <ButtonUtility
                    data-dialog-close
                    aria-label={m.controls_close()}
                    icon={XClose}
                    size="sm"
                    color="tertiary"
                    isDisabled={confirming}
                    onClick={close}
                  />
                </div>

                {uniqueTargets.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {uniqueTargets.map((version) => (
                      <BatchUpgradeReleaseBadge key={version} version={version} />
                    ))}
                  </div>
                ) : null}

                <ul className="mt-4 max-h-48 divide-y divide-secondary overflow-y-auto rounded-lg border border-secondary bg-secondary_subtle">
                  {candidates.map((candidate) => (
                    <li
                      key={candidate.computerId}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium text-primary">
                        {candidate.label}
                      </span>
                      <span dir="ltr" className="shrink-0 font-mono text-xs text-secondary">
                        {candidate.currentVersion ?? "—"} <span className="text-quaternary">→</span>{" "}
                        <span className="font-medium text-primary">{candidate.targetVersion}</span>
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="mt-4 flex gap-2.5 rounded-lg bg-warning-primary px-3 py-2.5 text-sm text-warning-primary">
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-fg-warning-primary"
                  />
                  <p>{m.computer_upgrade_all_runs_stop()}</p>
                </div>
                <div className="mt-2.5 flex gap-2.5 px-3 text-sm text-secondary">
                  <Check
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-fg-success-primary"
                  />
                  <p>{m.computer_upgrade_all_kept()}</p>
                </div>
              </div>

              <DialogActions className="px-6 py-4">
                <DialogCancel type="button" isDisabled={confirming} onPress={() => close()}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  autoFocus
                  type="button"
                  isDisabled={confirming || candidates.length === 0}
                  isLoading={confirming}
                  showTextWhileLoading
                  onPress={() => void guard(onConfirm)}
                >
                  {m.computer_upgrade_all_confirm()}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
