import { useServerFn } from "@tanstack/react-start";
import { useAppToast } from "#src/components/ui/toast";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { CHANNEL_VISIBILITY } from "./channel-visibility";
import { joinPublicChannel, leavePublicChannel } from "./channels.functions";
import {
  setGeneralChannelHidden,
  setPublicChannelArchived,
  setPublicChannelVisibility,
} from "./channel-lifecycle.functions";

/** The channel actions that run at once, with Undo in their toast instead of a confirmation
 * (Frank, task #coforge-designer-team:#7): each can be put back by the person who did it. */
export type DirectChannelAction = "archive" | "leave" | "hide-general" | "make-private";

/**
 * Runs a channel action at once and offers Undo. Leaving a private channel is not one of them: its
 * leaver cannot join again, so it still asks (`ChannelActionConfirmDialog`); nor are deleting and
 * making a channel public, whose effects cannot be taken back.
 */
export function useDirectChannelAction({
  channelId,
  channelName,
  onDone,
}: {
  channelId: string;
  channelName: string;
  /** Closes the settings and reads the channel again (after hiding #general that leaves for Chat). */
  onDone: () => Promise<void>;
}) {
  const toast = useAppToast();
  const setArchived = useServerFn(setPublicChannelArchived);
  const leave = useServerFn(leavePublicChannel);
  const join = useServerFn(joinPublicChannel);
  const setGeneralHidden = useServerFn(setGeneralChannelHidden);
  const setVisibility = useServerFn(setPublicChannelVisibility);
  const name = channelName;
  const actions: Record<
    DirectChannelAction,
    {
      run: () => Promise<unknown>;
      undo: () => Promise<unknown>;
      done: () => string;
      error: () => string;
      denied?: () => string;
    }
  > = {
    archive: {
      run: () => setArchived({ data: { channelId, archived: true } }),
      undo: () => setArchived({ data: { channelId, archived: false } }),
      done: () => m.channel_archived_toast({ name }),
      error: m.channel_settings_archive_error,
      denied: m.channel_settings_access_denied,
    },
    leave: {
      run: () => leave({ data: { channelId } }),
      undo: () => join({ data: { channelId } }),
      done: () => m.channel_left_toast({ name }),
      error: m.channel_settings_leave_error,
    },
    "hide-general": {
      run: () => setGeneralHidden({ data: { hidden: true } }),
      undo: () => setGeneralHidden({ data: { hidden: false } }),
      done: m.channel_general_hidden_toast,
      error: m.channel_settings_hide_general_error,
      denied: m.channel_settings_hide_general_denied,
    },
    "make-private": {
      run: () => setVisibility({ data: { channelId, visibility: CHANNEL_VISIBILITY.PRIVATE } }),
      undo: () => setVisibility({ data: { channelId, visibility: CHANNEL_VISIBILITY.PUBLIC } }),
      done: () => m.channel_made_private_toast({ name }),
      error: m.channel_settings_visibility_error,
      denied: m.channel_settings_visibility_denied,
    },
  };

  return async function runDirect(kind: DirectChannelAction) {
    const action = actions[kind];
    try {
      await action.run();
    } catch (cause) {
      if (isAppErrorCode(cause, "NOT_FOUND")) return onDone();
      toast.error(
        isAppErrorCode(cause, "ACCESS_DENIED") && action.denied ? action.denied() : action.error(),
      );
      return;
    }
    toast.undoable(action.done(), {
      key: `${kind}:${channelId}`,
      failed: m.channel_undo_failed(),
      onUndo: () => action.undo().then(onDone),
    });
    await onDone();
  };
}
