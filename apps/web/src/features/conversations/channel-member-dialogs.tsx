import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { m } from "#src/paraglide/messages";
import { removePublicChannelMember } from "./channels.functions";
import type { RosterMember } from "./channel-members-query";
import { channelMembersQueryKey } from "./conversation-query-keys";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";

/** A Workspace owner or admin stays a channel admin everywhere; their row explains that instead
 * of demoting them. */
export function ServerAdminRoleDialog({
  member,
  onClose,
}: {
  member: RosterMember;
  onClose: () => void;
}) {
  return (
    <ModalOverlay isOpen onOpenChange={(next) => !next && onClose()}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <DialogHeader title={m.channel_members_server_admin_title()} onClose={close} />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {m.channel_members_server_admin_message({ name: member.displayName })}
              </Text>
              <DialogActions className="mt-6 px-6 pb-6">
                <DialogCancel onPress={close}>{m.channel_members_ok()}</DialogCancel>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await remove({
        data: {
          channelId,
          ...(member.kind === "user" ? { userId: member.id } : { agentId: member.id }),
        },
      });
      await queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      onClose();
    } catch {
      setError(m.channel_members_remove_error({ name: member.displayName }));
      setBusy(false);
    }
  }

  return (
    <ModalOverlay
      isOpen
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <DialogHeader
                title={m.channel_members_remove_title()}
                onClose={busy ? undefined : close}
              />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {m.channel_members_remove_message({
                  name: member.displayName,
                  channel: channelName,
                })}
              </Text>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <DialogActions className="mt-6 px-6 pb-6">
                <DialogCancel isDisabled={busy} onPress={close}>
                  {m.channel_members_cancel()}
                </DialogCancel>
                <DialogAction
                  color="primary-destructive"
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {busy ? m.channel_members_removing() : m.channel_members_remove_action()}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
