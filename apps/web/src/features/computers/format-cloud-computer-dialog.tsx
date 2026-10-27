import { useState } from "react";
import { AlertCircle, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";

/** Formats a cloud computer's disk only after the owner types its name. The server checks it again. */
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
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [formatting, guard] = useSubmitGuard();
  const confirmed = typed.trim() === name;

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
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (formatting) return;
        if (!nextOpen) setTyped("");
        setError("");
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                <Heading
                  slot="title"
                  className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-display-xs"
                >
                  {m.computer_format_dialog_title({ name })}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={formatting}
                  onClick={close}
                />
              </div>
              <div className="mx-6 mt-4 flex items-start gap-3">
                <FeaturedIcon color="error" theme="light" size="sm" icon={AlertCircle} />
                <Text slot="description" className="text-sm text-secondary">
                  {m.computer_format_description()}
                </Text>
              </div>
              <label className="grid gap-1 px-6 pt-5 text-sm font-medium">
                {m.computer_format_confirm({ name })}
                <Input
                  autoFocus
                  value={typed}
                  onChange={setTyped}
                  placeholder={m.computer_format_placeholder()}
                  isDisabled={formatting}
                  autoComplete="off"
                  aria-label={m.computer_format_confirm({ name })}
                />
              </label>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={formatting} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  isDisabled={!confirmed || formatting}
                  isLoading={formatting}
                  showTextWhileLoading
                  onPress={submit}
                >
                  {formatting ? m.computer_format_pending() : m.computer_format_submit()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
