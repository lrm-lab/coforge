import { useState } from "react";
import { Heading, Text } from "react-aria-components";
import { AlertCircle, XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";

/** Confirms an irreversible change (a delete, or rotating an app's secret); a refusal stays in the
 * dialog. Used by the Computer page, an archived Agent's profile and Settings → Applications. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  errorMessage,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /** What the confirm button says while the change runs ("Deleting…"); without it, `confirmLabel`. */
  pendingLabel?: string;
  /** What a refusal says: one text, or one chosen by what was thrown. */
  errorMessage: string | ((cause: unknown) => string);
  /** Performs the change; throws when it is refused. */
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, guard] = useSubmitGuard();
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (pending) return;
        setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="overflow-hidden text-left">
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
              <div className="mx-6 mt-4 flex items-start gap-3">
                <FeaturedIcon color="error" theme="light" size="sm" icon={AlertCircle} />
                <Text slot="description" className="text-sm text-secondary">
                  {description}
                </Text>
              </div>
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
                  color="primary-destructive"
                  isLoading={pending}
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
