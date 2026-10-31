import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { leavePublicChannel } from "./channels.functions";
import {
  deletePublicChannel,
  setGeneralChannelHidden,
  setPublicChannelArchived,
} from "./channel-lifecycle.functions";

/** The channel actions that ask for confirmation first. */
export type ConfirmedAction = "archive" | "leave" | "hide-general" | "delete";

const CONFIRM_COPY: Record<
  ConfirmedAction,
  {
    title: () => string;
    body: (name: string) => string;
    confirm: () => string;
    pending: () => string;
    error: () => string;
    /** Why the server refused the viewer (`ACCESS_DENIED`), when their role changed meanwhile. */
    denied?: () => string;
    /** Whether the action cannot be undone, which colours its confirm button red. */
    permanent?: boolean;
  }
> = {
  archive: {
    title: m.channel_settings_archive,
    body: (name) => m.channel_settings_archive_confirm({ name }),
    confirm: m.channel_settings_archive_action,
    pending: m.channel_settings_archiving,
    error: m.channel_settings_archive_error,
    denied: m.channel_settings_access_denied,
  },
  leave: {
    title: m.channel_settings_leave,
    body: (name) => m.channel_settings_leave_confirm({ name }),
    confirm: m.channel_settings_leave_action,
    pending: m.channel_settings_leaving,
    error: m.channel_settings_leave_error,
  },
  "hide-general": {
    title: m.channel_settings_hide_general,
    body: () => m.channel_settings_hide_general_confirm(),
    confirm: m.channel_settings_hide_general,
    pending: m.channel_settings_hiding_general,
    error: m.channel_settings_hide_general_error,
    denied: m.channel_settings_hide_general_denied,
  },
  delete: {
    title: m.channel_settings_delete,
    body: (name) => m.channel_settings_delete_confirm({ name }),
    confirm: m.channel_settings_delete_action,
    pending: m.channel_settings_deleting,
    error: m.channel_settings_delete_error,
    denied: m.channel_settings_delete_denied,
    permanent: true,
  },
};

/** Confirms archiving, leaving or deleting the channel, or hiding #general; the write runs here
 * so its error stays inline. */
export function ChannelActionConfirmDialog({
  kind,
  channelId,
  channelName,
  onClose,
  onDone,
}: {
  kind: ConfirmedAction | null;
  channelId: string;
  channelName: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const setArchived = useServerFn(setPublicChannelArchived);
  const leave = useServerFn(leavePublicChannel);
  const setGeneralHidden = useServerFn(setGeneralChannelHidden);
  const deleteChannel = useServerFn(deletePublicChannel);
  const writes: Record<ConfirmedAction, () => Promise<unknown>> = {
    archive: () => setArchived({ data: { channelId, archived: true } }),
    leave: () => leave({ data: { channelId } }),
    "hide-general": () => setGeneralHidden({ data: { hidden: true } }),
    delete: () => deleteChannel({ data: { channelId } }),
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keeps the last action's copy while the dialog animates closed.
  const lastKind = useRef<ConfirmedAction>("archive");
  if (kind) lastKind.current = kind;
  const copy = CONFIRM_COPY[lastKind.current];

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await writes[lastKind.current]();
      await onDone();
    } catch (cause) {
      // Already gone (deleted or hidden by someone else): finishing leaves for Chat all the same.
      if (isAppErrorCode(cause, "NOT_FOUND")) await onDone();
      else if (isAppErrorCode(cause, "ACCESS_DENIED") && copy.denied) setError(copy.denied());
      else setError(copy.error());
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay
      isOpen={kind !== null}
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (next || busy) return;
        setError("");
        onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left">
          {({ close }) => (
            <>
              <DialogHeader title={copy.title()} onClose={busy ? undefined : close} />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {copy.body(channelName)}
              </Text>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={busy} onPress={close}>
                  {m.channel_settings_cancel()}
                </Button>
                <Button
                  color={copy.permanent ? "primary-destructive" : "primary"}
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {busy ? copy.pending() : copy.confirm()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
