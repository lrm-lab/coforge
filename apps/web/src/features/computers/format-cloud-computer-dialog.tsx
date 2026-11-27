import { useId, useRef, useState } from "react";
import { Check, Copy01 as Copy, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";

export function FormatCloudComputerDialog({
  open,
  onOpenChange,
  name,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onConfirm: (confirmName: string) => Promise<void>;
}) {
  const controlSize = useDialogControlSize();
  const confirmLabelId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [formatting, guard] = useSubmitGuard();
  const dialogTitle = m.computer_format_dialog_title({ name });

  const form = useAppForm({
    defaultValues: { confirmName: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current, "confirmName"),
    onSubmit: async ({ value }) => {
      const trimmed = value.confirmName.trim();
      if (trimmed !== name || formatting) return;
      setError("");
      await guard(async () => {
        try {
          await onConfirm(trimmed);
          form.reset();
          onOpenChange(false);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "";
          if (message === "confirmation does not match") {
            setFieldServerError(form, "confirmName", m.computer_format_mismatch(), formRef.current);
          } else {
            setError(m.computer_format_error());
          }
        }
      });
    },
  });

  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (formatting) return;
        if (!nextOpen) {
          form.reset();
          setCopied(false);
        }
        setError("");
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-start">
          {({ close }) => (
            <form.AppForm>
              <form
                ref={formRef}
                className="contents"
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
              >
                <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                  <Heading
                    slot="title"
                    dir="auto"
                    className="line-clamp-3 min-w-0 text-lg font-semibold text-primary wrap-anywhere"
                  >
                    {dialogTitle}
                  </Heading>
                  <ButtonUtility
                    data-dialog-close
                    aria-label={m.controls_close()}
                    icon={X}
                    size="sm"
                    color="tertiary"
                    className="shrink-0"
                    isDisabled={formatting}
                    onClick={close}
                  />
                </div>
                <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                  {m.computer_format_description()}
                </Text>
                <div className="grid gap-2 px-6 pt-5">
                  <p id={confirmLabelId} className="text-sm font-medium text-primary">
                    {m.computer_format_confirm({ name })}
                  </p>
                  <div className="flex min-w-0 items-center gap-2 rounded-lg bg-secondary px-3 py-1.5">
                    <code
                      dir="auto"
                      className="min-w-0 flex-1 truncate font-mono text-xs text-secondary select-all"
                    >
                      {name}
                    </code>
                    <ButtonUtility
                      type="button"
                      size="xs"
                      color="tertiary"
                      className="shrink-0"
                      icon={copied ? Check : Copy}
                      tooltip={
                        copied ? m.computer_detail_name_copied() : m.computer_detail_copy_name()
                      }
                      onClick={() => {
                        void navigator.clipboard.writeText(name);
                        setCopied(true);
                      }}
                    />
                  </div>
                  <form.AppField name="confirmName">
                    {(field) => (
                      <field.Input
                        size={controlSize}
                        autoFocus
                        placeholder={m.computer_format_placeholder()}
                        isDisabled={formatting}
                        autoComplete="off"
                        aria-labelledby={confirmLabelId}
                      />
                    )}
                  </form.AppField>
                </div>
                <form.Alert error={error} className="px-6 pt-4 text-sm text-error-primary" />
                <DialogActions className="mt-6 shrink-0 px-6 pb-6">
                  <DialogCancel isDisabled={formatting} onPress={close}>
                    {m.controls_cancel()}
                  </DialogCancel>
                  <form.Subscribe selector={(state) => state.values.confirmName.trim() === name}>
                    {(confirmed) => (
                      <DialogAction
                        color="secondary-destructive"
                        isDisabled={!confirmed || formatting}
                        isLoading={formatting}
                        showTextWhileLoading
                        type="submit"
                      >
                        {formatting ? m.computer_format_pending() : m.computer_format_submit()}
                      </DialogAction>
                    )}
                  </form.Subscribe>
                </DialogActions>
              </form>
            </form.AppForm>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
