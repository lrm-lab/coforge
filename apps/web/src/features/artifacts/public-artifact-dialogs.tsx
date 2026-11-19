import { useState } from "react";
import { Heading } from "react-aria-components";

import { Select } from "#src/components/base/select/select";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { reportPublicArtifactAbuse } from "./artifact-sandbox.functions";
import { buildForkPrompt } from "./artifact-short-id";

type AbuseReason = "spam" | "phishing" | "harassment" | "copyright" | "other";

export function PublicArtifactForkDialog({
  title,
  url,
  onClose,
}: {
  title: string;
  url: string;
  onClose: () => void;
}) {
  const toast = useAppToast();
  const prompt = buildForkPrompt({ title, url });

  const copyPrompt = async () => {
    if (await copyText(prompt)) {
      toast.success(m.ap_fork_copied());
      onClose();
    } else {
      toast.error(m.conversation_copy_failed());
    }
  };

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => !open && onClose()}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog aria-label={m.ap_fork_title()}>
          <div className="w-full p-5 text-left">
            <Heading slot="title" className="text-lg font-semibold text-primary">
              {m.ap_fork_title()}
            </Heading>
            <p className="mt-2 text-sm text-secondary">{m.ap_fork_body()}</p>
            <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-secondary bg-secondary p-3 font-mono text-xs whitespace-pre-wrap text-primary">
              {prompt}
            </pre>
            <DialogActions className="mt-5">
              <DialogCancel onPress={onClose}>{m.controls_cancel()}</DialogCancel>
              <DialogAction onPress={() => void copyPrompt()}>
                {m.ap_fork_copy_prompt()}
              </DialogAction>
            </DialogActions>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

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
            <label className="mt-3 block text-sm font-medium text-secondary">
              {m.ap_report_details()}
              <textarea
                rows={3}
                maxLength={1000}
                disabled={pending}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                placeholder={m.ap_report_details_placeholder()}
                className="mt-1.5 block w-full resize-none rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs focus:ring-2 focus:ring-brand focus:outline-hidden"
              />
            </label>
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
