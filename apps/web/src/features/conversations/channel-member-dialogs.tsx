import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { removePublicChannelMember } from "./channels.functions";
import type { RosterMember } from "./channel-members-query";
import { channelMembersQueryKey } from "./conversation-query-keys";

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
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <DialogHeader title={m.channel_members_server_admin_title()} onClose={close} />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {m.channel_members_server_admin_message({ name: member.displayName })}
              </Text>
              <div className="mt-6 flex justify-end border-t border-secondary px-6 py-4">
                <Button color="secondary" onPress={close}>
                  {m.channel_members_ok()}
                </Button>
              </div>
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
        <Dialog className="overflow-hidden text-left">
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
              <div className="mt-6 flex justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={busy} onPress={close}>
                  {m.channel_members_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {busy ? m.channel_members_removing() : m.channel_members_remove_action()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
