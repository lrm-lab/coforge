import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { ActorName } from "#src/features/avatars/actor-name";
import { messageSlots } from "#src/lib/message-slots";
import { m } from "#src/paraglide/messages";
import { removePublicChannelMember } from "./channels.functions";
import type { RosterMember } from "./channel-members-query";
import { channelMembersQueryKey } from "./conversation-query-keys";
import { DialogAction, DialogActions } from "#src/components/ui/dialog-actions";

function MemberName({ member }: { member: RosterMember }) {
  return (
    <ActorName
      actor={{
        kind: member.kind,
        id: member.id,
        name: member.displayName,
        avatarUrl: member.avatarUrl,
      }}
    />
  );
}

export function ServerAdminRoleDialog({
  member,
  onClose,
}: {
  member: RosterMember;
  onClose: () => void;
}) {
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(next) => !next && onClose()}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <DialogHeader title={m.channel_members_server_admin_title()} onClose={close} />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {messageSlots(m.channel_members_server_admin_message, {
                  name: <MemberName member={member} />,
                })}
              </Text>
              <DialogActions className="mt-6 px-6 pb-6">
                <DialogAction autoFocus color="secondary" onPress={close}>
                  {m.channel_members_ok()}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function RemoveMemberDialog({
  channelId,
  channelName,
  member,
  onClose,
}: {
  channelId: string;
  channelName: string;
  member: RosterMember;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useServerFn(removePublicChannelMember);

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={m.channel_members_remove_title()}
      description={messageSlots(m.channel_members_remove_message, {
        name: <MemberName member={member} />,
        channel: channelName,
      })}
      cancelLabel={m.channel_members_cancel()}
      confirmLabel={m.channel_members_remove_title()}
      pendingLabel={m.channel_members_removing()}
      errorMessage={m.channel_members_remove_error({ name: member.displayName })}
      onConfirm={async () => {
        await remove({
          data: {
            channelId,
            ...(member.kind === "user" ? { userId: member.id } : { agentId: member.id }),
          },
        });
        await queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
        onClose();
      }}
    />
  );
}
