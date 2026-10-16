import { useState } from "react";
import { Heading, Text } from "react-aria-components";
import { AlertCircle, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";

/** Confirms an irreversible delete; a refusal stays in the dialog. Used by the Computer page and an
 * archived Agent's profile. */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  errorMessage,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  errorMessage: string;
  /** Performs the delete; throws when it is refused. */
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState(false);
  const [deleting, guard] = useSubmitGuard();
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen: boolean) => {
        if (deleting) return;
        setError(false);
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
                  isDisabled={deleting}
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
                  {errorMessage}
                </p>
              )}
              <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={deleting} onPress={close}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  isLoading={deleting}
                  showTextWhileLoading
                  onPress={() => {
                    if (deleting) return;
                    setError(false);
                    void guard(async () => {
                      try {
                        await onConfirm();
                      } catch {
                        setError(true);
                      }
                    });
                  }}
                >
                  {confirmLabel}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** An Agent workspace's size as the Computer page and an archived Agent's profile show it. */
export function formatWorkspaceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
