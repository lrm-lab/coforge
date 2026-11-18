import { useEffect } from "react";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { m } from "#src/paraglide/messages";
import { InviteLinkPanel, useInviteLink } from "./invite-link-panel";

export function InviteMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inviteLink = useInviteLink();

  useEffect(() => {
    if (open) inviteLink.show();
  }, [open]);

  function close() {
    inviteLink.reset();
    onOpenChange(false);
  }

  return (
    <ModalOverlay
      confirmation
      isOpen={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <Modal className="w-[min(32rem,calc(100vw-2rem))]">
        <Dialog>
          <DialogHeader title={m.workspace_invite_title()} onClose={close} />
          <InviteLinkPanel inviteLink={inviteLink} onDone={close} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
