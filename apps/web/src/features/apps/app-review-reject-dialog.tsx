import { useState } from "react";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Alert } from "#src/components/ui/alert";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { REVIEW_REASON_MAX_LENGTH } from "./app-publish-status";

/** Rejects a review request with an optional reason, which is kept for reviewers and never shown
 * to the app's developers. A refusal stays in the dialog. */
export function RejectReviewDialog({
  appName,
  open,
  onOpenChange,
  onReject,
}: {
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Throws when the server refuses the decision. */
  onReject: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState(false);
  const [pending, guard] = useSubmitGuard();
  return (
    <ModalOverlay isOpen={open} isDismissable={!pending} onOpenChange={onOpenChange}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="grid gap-4 p-6 text-left">
          <Heading slot="title" className="text-lg font-semibold text-primary">
            {m.apps_review_reject_title({ name: appName })}
          </Heading>
          <TextArea
            label={m.apps_review_reject_reason()}
            value={reason}
            onChange={setReason}
            rows={4}
            maxLength={REVIEW_REASON_MAX_LENGTH}
            isDisabled={pending}
          />
          {error && <Alert color="error" title={m.apps_review_reject_error()} />}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              size="sm"
              color="secondary"
              isDisabled={pending}
              onPress={() => onOpenChange(false)}
            >
              {m.apps_review_cancel()}
            </Button>
            <Button
              type="button"
              size="sm"
              color="primary-destructive"
              isLoading={pending}
              showTextWhileLoading
              onPress={() =>
                void guard(async () => {
                  setError(false);
                  try {
                    await onReject(reason);
                  } catch {
                    setError(true);
                  }
                })
              }
            >
              {pending ? m.apps_review_rejecting() : m.apps_review_reject_confirm()}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
