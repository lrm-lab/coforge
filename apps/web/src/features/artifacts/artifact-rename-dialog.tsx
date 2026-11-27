import { useRef } from "react";
import { useStore } from "@tanstack/react-form";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
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
  const formRef = useRef<HTMLFormElement>(null);
  const form = useAppForm({
    defaultValues: { title },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const next = value.title.trim();
      if (!next || next === title) return;
      try {
        await onRename(next);
        onClose();
      } catch {
        setFieldServerError(form, "title", m.av_rename_failed(), formRef.current);
      }
    },
  });
  const { value, pending } = useStore(form.store, (state) => ({
    value: state.values.title,
    pending: state.isSubmitting,
  }));
  const next = value.trim();
  const changed = next !== "" && next !== title;
  const guard = useUnsavedChangesGuard({
    overlayOpen: true,
    dirty: value !== title,
    close: onClose,
  });
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
            <form.AppForm>
              <form
                ref={formRef}
                className="w-full p-6 pt-4 text-left"
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
              >
                <form.AppField name="title">
                  {(field) => (
                    <field.Input
                      autoFocus
                      aria-label={m.av_rename_label()}
                      size={size}
                      maxLength={ARTIFACT_TITLE_MAX}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                </form.AppField>
                <DialogActions className="mt-5">
                  <DialogCancel isDisabled={pending} onPress={guard.requestClose}>
                    {m.controls_cancel()}
                  </DialogCancel>
                  <DialogAction type="submit" isDisabled={!changed} isLoading={pending}>
                    {m.av_rename_save()}
                  </DialogAction>
                </DialogActions>
              </form>
            </form.AppForm>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
