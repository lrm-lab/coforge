import { Input } from "#src/components/base/input/input";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";

export function RecordSideRenameDialog({
  open,
  draft,
  busy,
  onDraftChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  draft: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const controlSize = useDialogControlSize();
  if (!open) return null;
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(next) => !next && onClose()}>
      <Modal className="w-full max-w-sm p-5">
        <Dialog className="outline-none">
          <h2 className="text-md font-semibold text-primary">
            {m.records_side_chat_rename_title()}
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <div className="mt-3">
              <Input
                size={controlSize}
                value={draft}
                onChange={onDraftChange}
                placeholder={m.records_side_chat_rename_placeholder()}
                autoFocus
              />
            </div>
            <DialogActions className="mt-4">
              <DialogCancel onPress={onClose}>{m.controls_cancel()}</DialogCancel>
              <DialogAction isDisabled={!draft.trim() || busy} type="submit">
                {m.records_side_chat_rename_save()}
              </DialogAction>
            </DialogActions>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
