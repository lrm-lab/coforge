import { useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";

import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Select } from "#src/components/base/select/select";
import { useAppForm } from "#src/components/ui/form";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { useAppToast } from "#src/components/ui/toast";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { reportPublicArtifactAbuse } from "./artifact-sandbox.functions";

type AbuseReason = "spam" | "phishing" | "harassment" | "copyright" | "other";

const ABUSE_REASONS: readonly AbuseReason[] = [
  "spam",
  "phishing",
  "harassment",
  "copyright",
  "other",
];

export function PublicArtifactReportDialog({
  artifactId,
  onClose,
}: {
  artifactId: string;
  onClose: () => void;
}) {
  const toast = useAppToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [formError, setFormError] = useState("");
  const form = useAppForm({
    defaultValues: { reason: "spam", details: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      setFormError("");
      const reason = ABUSE_REASONS.find((item) => item === value.reason) ?? "spam";
      try {
        await reportPublicArtifactAbuse({
          data: { artifactId, reason, details: value.details.trim() || undefined },
        });
        toast.success(m.ap_report_submitted());
        onClose();
      } catch {
        setFormError(m.ap_report_failed());
      }
    },
  });
  const { details, pending } = useStore(form.store, (state) => ({
    details: state.values.details,
    pending: state.isSubmitting,
  }));
  const guard = useUnsavedChangesGuard({
    overlayOpen: true,
    dirty: details.trim() !== "",
    close: onClose,
  });
  const reasons: { id: AbuseReason; label: string }[] = [
    { id: "spam", label: m.ap_report_reason_spam() },
    { id: "phishing", label: m.ap_report_reason_phishing() },
    { id: "harassment", label: m.ap_report_reason_harassment() },
    { id: "copyright", label: m.ap_report_reason_copyright() },
    { id: "other", label: m.ap_report_reason_other() },
  ];

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
          <Dialog aria-label={m.ap_report_title()}>
            <DialogHeader
              title={m.ap_report_title()}
              description={m.ap_report_body()}
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
                <div>
                  <form.AppField name="reason">
                    {(field) => (
                      <field.Select
                        label={m.ap_report_reason()}
                        items={reasons}
                        isDisabled={pending}
                        onSelectionChange={() => setFormError("")}
                      >
                        {(item) => <Select.Item id={item.id} label={item.label} />}
                      </field.Select>
                    )}
                  </form.AppField>
                </div>
                <div className="mt-3">
                  <form.AppField name="details">
                    {(field) => (
                      <field.TextArea
                        label={m.ap_report_details()}
                        rows={3}
                        maxLength={1000}
                        isDisabled={pending}
                        placeholder={m.ap_report_details_placeholder()}
                        textAreaClassName="resize-none"
                        onChange={() => setFormError("")}
                      />
                    )}
                  </form.AppField>
                </div>
                <form.Alert error={formError} className="mt-2 text-sm text-error-primary" />
                <DialogActions className="mt-5">
                  <DialogCancel isDisabled={pending} onPress={guard.requestClose}>
                    {m.controls_cancel()}
                  </DialogCancel>
                  <DialogAction type="submit" color="primary-destructive" isLoading={pending}>
                    {m.ap_report_submit()}
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
