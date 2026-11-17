import { useEffect, useState } from "react";
import { Text } from "react-aria-components";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";

export function UnsavedChangesDialog({
  open,
  saving = false,
  description = m.unsaved_changes_message(),
  onKeepEditing,
  onDiscard,
  onSave,
}: {
  open: boolean;
  saving?: boolean;
  description?: string;
  onKeepEditing: () => void;
  onDiscard: () => void;
  onSave?: () => void | Promise<void>;
}) {
  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      isDismissable={!saving}
      onOpenChange={(next) => {
        if (!next && !saving) onKeepEditing();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-left">
          <DialogHeader title={m.unsaved_changes_title()} />
          <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
            {description}
          </Text>
          <DialogActions className="mt-6 px-6 pb-6">
            <DialogCancel isDisabled={saving} onPress={onKeepEditing}>
              {m.unsaved_changes_keep_editing()}
            </DialogCancel>
            <DialogAction
              autoFocus={!onSave}
              color="secondary-destructive"
              outlinedInSheet={Boolean(onSave)}
              isDisabled={saving}
              onPress={onDiscard}
            >
              {m.unsaved_changes_discard()}
            </DialogAction>
            {onSave && (
              <DialogAction
                autoFocus
                isDisabled={saving}
                isLoading={saving}
                showTextWhileLoading
                onPress={() => void onSave()}
              >
                {saving ? m.unsaved_changes_saving() : m.unsaved_changes_save_and_close()}
              </DialogAction>
            )}
          </DialogActions>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function useUnsavedChangesGuard({
  overlayOpen,
  dirty,
  close,
  onDiscard,
  onSave,
}: {
  overlayOpen: boolean;
  dirty: boolean;
  close: () => void;
  onDiscard?: () => void;
  onSave?: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  if (open && !overlayOpen) setOpen(false);

  function requestClose() {
    if (dirty) setOpen(true);
    else close();
  }

  return {
    requestClose,
    promptProps: {
      open,
      saving,
      onKeepEditing: () => setOpen(false),
      onDiscard: () => {
        setOpen(false);
        onDiscard?.();
        close();
      },
      onSave: onSave
        ? async () => {
            setSaving(true);
            let saved = false;
            try {
              saved = await onSave();
            } finally {
              setSaving(false);
              setOpen(false);
            }
            if (saved) close();
          }
        : undefined,
    },
  };
}

export function useReportDirty(dirty: boolean, report: ((dirty: boolean) => void) | undefined) {
  useEffect(() => {
    report?.(dirty);
    return () => report?.(false);
  }, [dirty, report]);
}
