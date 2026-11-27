import { useEffect, useEffectEvent, useRef } from "react";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { useAppForm } from "#src/components/ui/form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";

export function RecordSideRenameDialog({
  open,
  draft,
  busy,
  onDraftChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const controlSize = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);

  const form = useAppForm({
    defaultValues: { title: draft },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: () => {
      onSubmit();
    },
  });

  const resetOnOpen = useEffectEvent(() => {
    form.reset({ title: draft });
  });

  useEffect(() => {
    if (open) resetOnOpen();
  }, [open]);

  useEffect(() => {
    if (form.getFieldValue("title") !== draft) {
      form.setFieldValue("title", draft);
    }
  }, [draft, form]);

  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-sm">
        <Dialog className="outline-none">
          <DialogHeader
            title={m.records_side_chat_rename_title()}
            onClose={busy ? undefined : onClose}
          />
          <form.AppForm>
            <form
              ref={formRef}
              noValidate
              className="p-6 pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              <form.AppField
                name="title"
                validators={{
                  onSubmit: ({ value }) =>
                    value.trim() ? undefined : m.records_side_chat_rename_placeholder(),
                }}
              >
                {(field) => (
                  <field.Input
                    size={controlSize}
                    placeholder={m.records_side_chat_rename_placeholder()}
                    isDisabled={busy}
                    autoFocus
                    onChange={onDraftChange}
                  />
                )}
              </form.AppField>
              <form.Alert className="mt-2 text-sm text-error-primary" />
              <DialogActions className="mt-4">
                <DialogCancel isDisabled={busy} onPress={onClose}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  isDisabled={!draft.trim() || busy}
                  isLoading={busy}
                  showTextWhileLoading
                  type="submit"
                >
                  {m.records_side_chat_rename_save()}
                </DialogAction>
              </DialogActions>
            </form>
          </form.AppForm>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
