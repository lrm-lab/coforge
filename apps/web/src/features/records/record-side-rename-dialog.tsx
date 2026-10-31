import { Input } from "#src/components/base/input/input";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";

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
  if (!open) return null;
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(next) => !next && onClose()}>
      <Modal className="w-full max-w-sm p-5">
        <Dialog className="outline-none">
          <h2 className="text-md font-semibold text-primary">
            {m.records_side_chat_rename_title()}
          </h2>
          <div className="mt-3">
            <Input
              value={draft}
              onChange={onDraftChange}
              placeholder={m.records_side_chat_rename_placeholder()}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
          </div>
          <DialogActions className="mt-4">
            <DialogCancel onPress={onClose}>{m.controls_cancel()}</DialogCancel>
            <DialogAction
              className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
              isDisabled={!draft.trim() || busy}
              onPress={onSubmit}
            >
              {m.records_side_chat_rename_save()}
            </DialogAction>
          </DialogActions>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
