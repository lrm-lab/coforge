import { DialogHeader } from "#src/components/application/modals/dialog-header";
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
  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-sm">
        <Dialog className="outline-none">
          <DialogHeader
            title={m.records_side_chat_rename_title()}
            onClose={busy ? undefined : onClose}
          />
          <form
            className="p-6 pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <Input
              size={controlSize}
              value={draft}
              onChange={onDraftChange}
              placeholder={m.records_side_chat_rename_placeholder()}
              isDisabled={busy}
              autoFocus
            />
            <DialogActions className="mt-4">
              <DialogCancel isDisabled={busy} onPress={onClose}>
                {m.controls_cancel()}
              </DialogCancel>
              <DialogAction
                isDisabled={!draft.trim() || busy}
                isLoading={busy}
                showTextWhileLoading
                type="submit"
              >
                {m.records_side_chat_rename_save()}
              </DialogAction>
            </DialogActions>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
