import { useState } from "react";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { m } from "#src/paraglide/messages";
import { ARTIFACT_TITLE_MAX } from "./artifact-title-limit";

export function ArtifactRenameDialog({
  title,
  onClose,
  onRename,
}: {
  title: string;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const size = useDialogControlSize();
  const [value, setValue] = useState(title);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const next = value.trim();
  const changed = next !== "" && next !== title;
  const guard = useUnsavedChangesGuard({
    overlayOpen: true,
    dirty: value !== title,
    close: onClose,
  });
  const submit = async () => {
    if (!changed || pending) return;
    setPending(true);
    setFailed(false);
    try {
      await onRename(next);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <ModalOverlay
        isOpen
        isDismissable={!pending}
        onOpenChange={(open) => {
          if (!open && !pending) guard.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog aria-label={m.av_rename_title()}>
            <DialogHeader
              title={m.av_rename_title()}
              onClose={pending ? undefined : guard.requestClose}
            />
            <form
              className="w-full p-6 pt-4 text-left"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Input
                autoFocus
                aria-label={m.av_rename_label()}
                size={size}
                value={value}
                maxLength={ARTIFACT_TITLE_MAX}
                onChange={setValue}
                onFocus={(event) => event.currentTarget.select()}
              />
              {failed && (
                <p role="alert" className="mt-2 text-sm text-error-primary">
                  {m.av_rename_failed()}
                </p>
              )}
              <DialogActions className="mt-5">
                <DialogCancel isDisabled={pending} onPress={guard.requestClose}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction type="submit" isDisabled={!changed} isLoading={pending}>
                  {m.av_rename_save()}
                </DialogAction>
              </DialogActions>
            </form>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
