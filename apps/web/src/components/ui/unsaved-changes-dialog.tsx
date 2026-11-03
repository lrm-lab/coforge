import { useEffect, useState } from "react";
import { Text } from "react-aria-components";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";

/**
 * The prompt a form overlay raises when it is closed with unsaved edits: Keep Editing, Discard
 * Changes and, when the caller can save in one obvious action, Save and Close. Without `onSave`
 * Discard is the row's one filled button; beside Save it stays outlined.
 */
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
  /** Saves; the caller then closes the overlay behind the prompt. Absent when saving is not one
   * action. */
  onSave?: () => void | Promise<void>;
}) {
  return (
    <ModalOverlay
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
            {/* Beside Save, Discard stays outlined: one filled button per row. */}
            <DialogAction
              color={onSave ? "secondary-destructive" : "primary-destructive"}
              isDisabled={saving}
              onPress={onDiscard}
            >
              {m.unsaved_changes_discard()}
            </DialogAction>
            {onSave && (
              <DialogAction
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

/**
 * The guard a form overlay puts on its close paths. Route Escape, an outside click, the close
 * button and Cancel through `requestClose`: it closes at once while nothing changed, else raises
 * the prompt. Spread `promptProps` on `UnsavedChangesDialog`.
 *
 * `onSave` saves from the prompt and resolves to whether the save went through (the overlay stays
 * open when it did not); leave it out when the form has no single obvious save.
 */
export function useUnsavedChangesGuard({
  overlayOpen,
  dirty,
  close,
  onDiscard,
  onSave,
}: {
  /** Whether the guarded overlay is open: when it closes by any other path (a create that finished
   * meanwhile), the prompt goes with it instead of floating over the page or the next opening. */
  overlayOpen: boolean;
  dirty: boolean;
  close: () => void;
  /** Runs before `close` when the user discards, to drop the edits. */
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

/** For a form that lives inside its overlay: tells the overlay whether the form holds unsaved
 * edits, and that it holds none once the form unmounts. */
export function useReportDirty(dirty: boolean, report: ((dirty: boolean) => void) | undefined) {
  useEffect(() => {
    report?.(dirty);
    return () => report?.(false);
  }, [dirty, report]);
}
