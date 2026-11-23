import { useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { CHANNEL_VISIBILITY } from "./channel-visibility";
import { leavePublicChannel } from "./channels.functions";
import { deletePublicChannel, setPublicChannelVisibility } from "./channel-lifecycle.functions";

export type ConfirmedAction = "leave" | "delete" | "make-public";

const VISIBILITY_COPY = {
  pending: m.channel_settings_changing_visibility,
  error: m.channel_settings_visibility_error,
  denied: m.channel_settings_visibility_denied,
};

const CONFIRM_COPY: Record<
  ConfirmedAction,
  {
    title: (name: string) => string;
    body: (name: string) => string;
    confirm: () => string;
    pending: () => string;
    error: () => string;
    denied?: () => string;
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
  const lastKind = useRef<ConfirmedAction>("leave");
  if (kind) lastKind.current = kind;
  const copy = CONFIRM_COPY[lastKind.current];

  return (
    <ConfirmDialog
      open={kind !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      tone={copy.permanent ? "destructive" : "default"}
      title={copy.title(channelName)}
      description={copy.body(channelName)}
      cancelLabel={m.channel_settings_cancel()}
      confirmLabel={copy.confirm()}
      pendingLabel={copy.pending()}
      errorMessage={(cause) =>
        isAppErrorCode(cause, "ACCESS_DENIED") && copy.denied ? copy.denied() : copy.error()
      }
      onConfirm={async () => {
        try {
          await writes[lastKind.current]();
        } catch (cause) {
          if (!isAppErrorCode(cause, "NOT_FOUND")) throw cause;
        }
        await onDone();
      }}
    />
  );
}
