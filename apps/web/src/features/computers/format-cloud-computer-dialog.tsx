import { useId, useState } from "react";
import { Check, Copy01 as Copy, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
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
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [formatting, guard] = useSubmitGuard();
  const confirmed = typed.trim() === name;
  const dialogTitle = m.computer_format_dialog_title({ name });

  function submit() {
    if (!confirmed || formatting) return;
    setError("");
    void guard(async () => {
      try {
        await onConfirm(typed.trim());
        setTyped("");
        onOpenChange(false);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        setError(
          message === "confirmation does not match"
            ? m.computer_format_mismatch()
            : m.computer_format_error(),
        );
      }
    });
  }

  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (formatting) return;
        if (!nextOpen) {
          setTyped("");
          setCopied(false);
        }
        setError("");
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-start">
          {({ close }) => (
            <>
              <form
                className="contents"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
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
                  <Input
                    size={controlSize}
                    autoFocus
                    value={typed}
                    onChange={setTyped}
                    placeholder={m.computer_format_placeholder()}
                    isDisabled={formatting}
                    autoComplete="off"
                    aria-labelledby={confirmLabelId}
                  />
                </div>
                {error && (
                  <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                    {error}
                  </p>
                )}
                <DialogActions className="mt-6 shrink-0 px-6 pb-6">
                  <DialogCancel isDisabled={formatting} onPress={close}>
                    {m.controls_cancel()}
                  </DialogCancel>
                  <DialogAction
                    color="secondary-destructive"
                    isDisabled={!confirmed || formatting}
                    isLoading={formatting}
                    showTextWhileLoading
                    type="submit"
                  >
                    {formatting ? m.computer_format_pending() : m.computer_format_submit()}
                  </DialogAction>
                </DialogActions>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
