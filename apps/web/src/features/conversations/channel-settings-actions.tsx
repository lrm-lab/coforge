import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Text } from "react-aria-components";
import {
  Archive,
  EyeOff,
  LogOut01 as LogOut,
  RefreshCcw01 as Unarchive,
  StopCircle,
  Trash01,
} from "@untitledui/icons";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import type { ConfirmedAction } from "./channel-action-confirm-dialog";
import { setPublicChannelArchived } from "./channel-lifecycle.functions";
import { PanelSection } from "./settings-panel-parts";

/* The channel settings slideout's Actions section and its unsaved-changes prompt
 * (`channel-settings-panel`). */

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
        {conversation.archived
          ? capabilities.unarchive && (
              <Button
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

export function UnsavedChangesDialog({
  open,
  saving,
  onKeepEditing,
  onDiscard,
  onSaveAndClose,
}: {
  open: boolean;
  saving: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
  onSaveAndClose: () => Promise<void>;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      isDismissable={!saving}
      onOpenChange={(next) => {
        if (!next && !saving) onKeepEditing();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog className="text-left">
          <DialogHeader title={m.channel_settings_unsaved_title()} />
          <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
            {m.channel_settings_unsaved_message()}
          </Text>
          <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
            <Button color="secondary" isDisabled={saving} onPress={onKeepEditing}>
              {m.channel_settings_keep_editing()}
            </Button>
            <Button color="secondary-destructive" isDisabled={saving} onPress={onDiscard}>
              {m.channel_settings_discard()}
            </Button>
            <Button
              isDisabled={saving}
              isLoading={saving}
              showTextWhileLoading
              onPress={() => void onSaveAndClose()}
            >
              {saving ? m.channel_settings_saving() : m.channel_settings_save_and_close()}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
