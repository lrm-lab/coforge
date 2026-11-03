import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Archive,
  EyeOff,
  Lock01,
  LockUnlocked01,
  LogOut01 as LogOut,
  RefreshCcw01 as Unarchive,
  StopCircle,
  Trash01,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { DIALOG_BUTTON_SIZE } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import type { ConfirmedAction } from "./channel-action-confirm-dialog";
import { isPrivateChannel } from "./channel-visibility";
import { setPublicChannelArchived } from "./channel-lifecycle.functions";
import { PanelSection } from "./settings-panel-parts";

/* The channel settings slideout's Actions section (`channel-settings-panel`). */

export function ActionsSection({
  conversation,
  onConfirm,
  onStopAgents,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onConfirm: (kind: ConfirmedAction) => void;
  onStopAgents: () => void;
  onChanged: () => Promise<void>;
}) {
  const setArchived = useServerFn(setPublicChannelArchived);
  const [unarchiving, setUnarchiving] = useState(false);
  const [error, setError] = useState("");
  const capabilities = conversation.channelCapabilities;
  const priv = isPrivateChannel(conversation);

  async function unarchive() {
    setUnarchiving(true);
    setError("");
    try {
      await setArchived({ data: { channelId: conversation.conversationId, archived: false } });
      await onChanged();
    } catch {
      setError(m.channel_settings_unarchive_error());
    } finally {
      setUnarchiving(false);
    }
  }

  return (
    <PanelSection title={m.channel_settings_actions()}>
      <div className="flex flex-col gap-2">
        {/* A Workspace owner or admin in the channel makes it private or public, as in Slack's
            channel settings. */}
        {conversation.canChangeVisibility && (
          <Button
            size={DIALOG_BUTTON_SIZE}
            color="secondary"
            iconLeading={priv ? LockUnlocked01 : Lock01}
            className="w-full"
            onPress={() => onConfirm(priv ? "make-public" : "make-private")}
          >
            {priv ? m.channel_settings_make_public() : m.channel_settings_make_private()}
          </Button>
        )}
        {conversation.archived
          ? capabilities.unarchive && (
              <Button
                size={DIALOG_BUTTON_SIZE}
                color="secondary"
                iconLeading={Unarchive}
                className="w-full"
                isDisabled={unarchiving}
                isLoading={unarchiving}
                showTextWhileLoading
                onPress={() => void unarchive()}
              >
                {unarchiving ? m.channel_settings_unarchiving() : m.channel_settings_unarchive()}
              </Button>
            )
          : capabilities.archive && (
              <Button
                size={DIALOG_BUTTON_SIZE}
                color="secondary"
                iconLeading={Archive}
                className="w-full"
                onPress={() => onConfirm("archive")}
              >
                {m.channel_settings_archive()}
              </Button>
            )}
        {/* A Workspace owner or admin may hide #general from the whole Workspace (restored from
            Settings → Members → System channels). */}
        {conversation.canHideGeneral && (
          <Button
            size={DIALOG_BUTTON_SIZE}
            color="secondary"
            iconLeading={EyeOff}
            className="w-full"
            onPress={() => onConfirm("hide-general")}
          >
            {m.channel_settings_hide_general()}
          </Button>
        )}
        {capabilities.leave && !conversation.archived && (
          <Button
            size={DIALOG_BUTTON_SIZE}
            color="secondary"
            iconLeading={LogOut}
            className="w-full"
            onPress={() => onConfirm("leave")}
          >
            {m.channel_settings_leave()}
          </Button>
        )}
        {conversation.canStopAgents && (
          <Button
            size={DIALOG_BUTTON_SIZE}
            color="secondary"
            iconLeading={StopCircle}
            className="w-full"
            onPress={onStopAgents}
          >
            {m.channel_stop_agents()}
          </Button>
        )}
        {conversation.canDelete && !conversation.archived && (
          <Button
            size={DIALOG_BUTTON_SIZE}
            color="secondary-destructive"
            iconLeading={Trash01}
            className="w-full"
            onPress={() => onConfirm("delete")}
          >
            {m.channel_settings_delete()}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </PanelSection>
  );
}
