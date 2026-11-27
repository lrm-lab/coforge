import { useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { submitOnModEnter } from "#src/components/ui/dialog-form-keys";
import { Alert } from "#src/components/ui/alert";
import { useAppForm } from "#src/components/ui/form";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { REVIEW_REASON_MAX_LENGTH } from "./app-publish-status";

export function RejectReviewDialog({
  appName,
  open,
  onOpenChange,
  onReject,
}: {
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReject: (reason: string) => Promise<void>;
}) {
  const controlSize = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState(false);
  const [pending, guard] = useSubmitGuard();
  const form = useAppForm({
    defaultValues: { reason: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      await guard(async () => {
        setError(false);
        try {
          await onReject(value.reason);
        } catch {
          setError(true);
        }
      });
    },
  });
  const reason = useStore(form.store, (state) => state.values.reason);
  const unsaved = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty: reason.trim() !== "",
    close: () => onOpenChange(false),
    onDiscard: () => {
      form.reset();
      setError(false);
    },
  });
  return (
    <>
      <ModalOverlay
        isOpen={open}
        isDismissable={!pending}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else if (!pending) unsaved.requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="text-left">
            <form.AppForm>
              <form
                ref={formRef}
                className="grid gap-4 p-6"
                onKeyDown={submitOnModEnter}
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
              >
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {m.apps_review_reject_title({ name: appName })}
                </Heading>
                <form.AppField name="reason">
                  {(field) => (
                    <field.TextArea
                      size={controlSize}
                      label={m.apps_review_reject_reason()}
                      rows={4}
                      maxLength={REVIEW_REASON_MAX_LENGTH}
                      isDisabled={pending}
                      onChange={() => setError(false)}
                    />
                  )}
                </form.AppField>
                {error && <Alert color="error" title={m.apps_review_reject_error()} />}
                <DialogActions>
                  <DialogCancel type="button" isDisabled={pending} onPress={unsaved.requestClose}>
                    {m.apps_review_cancel()}
                  </DialogCancel>
                  <DialogAction
                    type="submit"
                    color="secondary-destructive"
                    isLoading={pending}
                    showTextWhileLoading
                  >
                    {pending ? m.apps_review_rejecting() : m.apps_review_reject_confirm()}
                  </DialogAction>
                </DialogActions>
              </form>
            </form.AppForm>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...unsaved.promptProps} />
    </>
  );
}
