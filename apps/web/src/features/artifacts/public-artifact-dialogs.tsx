import { useState } from "react";
import { Heading } from "react-aria-components";

import { Select } from "#src/components/base/select/select";
import { TextArea } from "#src/components/base/textarea/textarea";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { reportPublicArtifactAbuse } from "./artifact-sandbox.functions";

type AbuseReason = "spam" | "phishing" | "harassment" | "copyright" | "other";

export function PublicArtifactReportDialog({
  artifactId,
  onClose,
}: {
  artifactId: string;
  onClose: () => void;
}) {
  const toast = useAppToast();
  const [reason, setReason] = useState<AbuseReason>("spam");
  const [details, setDetails] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const reasons: { id: AbuseReason; label: string }[] = [
    { id: "spam", label: m.ap_report_reason_spam() },
    { id: "phishing", label: m.ap_report_reason_phishing() },
    { id: "harassment", label: m.ap_report_reason_harassment() },
    { id: "copyright", label: m.ap_report_reason_copyright() },
    { id: "other", label: m.ap_report_reason_other() },
  ];

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await reportPublicArtifactAbuse({
        data: { artifactId, reason, details: details.trim() || undefined },
      });
      toast.success(m.ap_report_submitted());
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <ModalOverlay isOpen isDismissable={!pending} onOpenChange={(open) => !open && onClose()}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog aria-label={m.ap_report_title()}>
          <form
            className="w-full p-5 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Heading slot="title" className="text-lg font-semibold text-primary">
              {m.ap_report_title()}
            </Heading>
            <p className="mt-1.5 text-sm text-secondary">{m.ap_report_body()}</p>
            <div className="mt-4">
              <Select
                label={m.ap_report_reason()}
                items={reasons}
                selectedKey={reason}
                isDisabled={pending}
                onSelectionChange={(key) => {
                  if (typeof key === "string") setReason(key as AbuseReason);
                }}
              >
                {(item) => <Select.Item id={item.id} label={item.label} />}
              </Select>
            </div>
            <div className="mt-3">
              <TextArea
                label={m.ap_report_details()}
                rows={3}
                maxLength={1000}
                isDisabled={pending}
                value={details}
                onChange={setDetails}
                placeholder={m.ap_report_details_placeholder()}
                textAreaClassName="resize-none"
              />
            </div>
            {failed && (
              <p role="alert" className="mt-2 text-sm text-error-primary">
                {m.ap_report_failed()}
              </p>
            )}
            <DialogActions className="mt-5">
              <DialogCancel isDisabled={pending} onPress={onClose}>
                {m.controls_cancel()}
              </DialogCancel>
              <DialogAction type="submit" color="primary-destructive" isLoading={pending}>
                {m.ap_report_submit()}
              </DialogAction>
            </DialogActions>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
