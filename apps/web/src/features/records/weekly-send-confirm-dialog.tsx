import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";

export const WEEKLY_SEND_TOAST_MS = 3000;

export function WeeklySendConfirmDialog({
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        onOpenChange(value);
      }}
      tone="default"
      title={m.records_report_confirm_send_title()}
      description={m.records_report_confirm_send_body()}
      cancelLabel={m.records_template_cancel()}
      confirmLabel={m.records_report_send()}
      confirmDisabled={busy}
      errorMessage={m.records_delete_error()}
      onConfirm={async () => {
        await onConfirm();
      }}
    />
  );
}
