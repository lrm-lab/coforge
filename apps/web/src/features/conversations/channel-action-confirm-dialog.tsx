import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { CHANNEL_VISIBILITY } from "./channel-visibility";
import { leavePublicChannel } from "./channels.functions";
import { deletePublicChannel, setPublicChannelVisibility } from "./channel-lifecycle.functions";

/** The channel actions that still ask first: what Undo cannot put back (task #7). Leaving asks only
 * for a private channel, which its leaver cannot join again; the rest run at once
 * (`channel-direct-actions`). */
export type ConfirmedAction = "leave" | "delete" | "make-public";

/** What making a channel private and making it public both say while and after they run. */
const VISIBILITY_COPY = {
  pending: m.channel_settings_changing_visibility,
  error: m.channel_settings_visibility_error,
  denied: m.channel_settings_visibility_denied,
};

const CONFIRM_COPY: Record<
  ConfirmedAction,
  {
    title: (name: string) => string;
    /** What follows from it, when the title alone does not say. */
    body?: (name: string) => string;
    confirm: () => string;
    pending: () => string;
    error: () => string;
    /** Why the server refused the viewer (`ACCESS_DENIED`), when their role changed meanwhile. */
    denied?: () => string;
    /** Whether the action cannot be undone, which colours its confirm button red. */
    permanent?: boolean;
  }
> = {
  leave: {
    title: () => m.channel_settings_leave(),
    body: (name) => m.channel_settings_leave_confirm({ name }),
    confirm: m.channel_settings_leave_action,
    pending: m.channel_settings_leaving,
    error: m.channel_settings_leave_error,
  },
  delete: {
    title: () => m.channel_settings_delete(),
    body: (name) => m.channel_settings_delete_confirm({ name }),
    confirm: m.channel_settings_delete_action,
    pending: m.channel_settings_deleting,
    error: m.channel_settings_delete_error,
    denied: m.channel_settings_delete_denied,
    permanent: true,
  },
  "make-public": {
    title: (name) => m.channel_settings_make_public_title({ name }),
    body: (name) => m.channel_settings_make_public_confirm({ name }),
    confirm: m.channel_settings_make_public_action,
    ...VISIBILITY_COPY,
  },
};

/** Confirms leaving a private channel, deleting a channel or making it public; the write runs here
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
  const leave = useServerFn(leavePublicChannel);
  const deleteChannel = useServerFn(deletePublicChannel);
  const setVisibility = useServerFn(setPublicChannelVisibility);
  const writes: Record<ConfirmedAction, () => Promise<unknown>> = {
    leave: () => leave({ data: { channelId } }),
    delete: () => deleteChannel({ data: { channelId } }),
    "make-public": () =>
      setVisibility({ data: { channelId, visibility: CHANNEL_VISIBILITY.PUBLIC } }),
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keeps the last action's copy while the dialog animates closed.
  const lastKind = useRef<ConfirmedAction>("leave");
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
      confirmation
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
              <DialogHeader title={copy.title(channelName)} onClose={busy ? undefined : close} />
              {copy.body && (
                <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                  {copy.body(channelName)}
                </Text>
              )}
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <DialogActions className="mt-6 px-6 pb-6">
                <DialogCancel isDisabled={busy} onPress={close}>
                  {m.channel_settings_cancel()}
                </DialogCancel>
                <DialogAction
                  autoFocus
                  color={copy.permanent ? "secondary-destructive" : "primary"}
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {busy ? copy.pending() : copy.confirm()}
                </DialogAction>
              </DialogActions>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
