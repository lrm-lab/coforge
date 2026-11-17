import { useState, type ReactNode } from "react";
import { Heading, Text } from "react-aria-components";
import { XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";

const CONFIRM_COLORS = {
  destructive: "secondary-destructive",
  warning: "secondary-warning",
  default: "primary",
} as const;

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  detail,
  confirmDisabled = false,
  confirmLabel,
  pendingLabel,
  errorMessage,
  onConfirm,
  tone = "destructive",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  detail?: ReactNode;
  confirmDisabled?: boolean;
  confirmLabel: string;
  pendingLabel?: string;
  errorMessage: string | ((cause: unknown) => string);
  onConfirm: () => Promise<void>;
  tone?: "destructive" | "warning" | "default";
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, guard] = useSubmitGuard();
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setError(null);
  }
  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (pending) return;
        setError(null);
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
                  {title}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={pending}
                  onClick={close}
                />
              </div>
              <Text
                slot="description"
                elementType="div"
                className="mx-6 mt-4 block text-sm text-secondary"
              >
                {description}
                {detail}
              </Text>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <DialogActions className="mt-6 shrink-0 px-6 pb-6">
                <DialogCancel isDisabled={pending} onPress={close}>
                  {m.controls_cancel()}
                </DialogCancel>
                <DialogAction
                  autoFocus
                  data-tone={tone}
                  color={CONFIRM_COLORS[tone]}
                  isLoading={pending}
                  isDisabled={confirmDisabled}
                  showTextWhileLoading
                  onPress={() => {
                    if (pending) return;
                    setError(null);
                    void guard(async () => {
                      try {
                        await onConfirm();
                      } catch (cause) {
                        setError(
                          typeof errorMessage === "string" ? errorMessage : errorMessage(cause),
                        );
                      }
                    });
                  }}
                >
                  {pending && pendingLabel ? pendingLabel : confirmLabel}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
