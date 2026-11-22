import { useState, type FC } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Archive,
  LogOut01 as LogOut,
  RefreshCcw01 as Unarchive,
  StopCircle,
  Trash01,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConfirmedAction } from "./channel-action-confirm-dialog";
import type { ChannelConversationView } from "./channel-conversation";
import type { DirectChannelAction } from "./channel-direct-actions";
import { setPublicChannelArchived } from "./channel-lifecycle.functions";
import { SettingsCard } from "./settings-panel-parts";

function ActionRow({
  icon: Icon,
  label,
  destructive = false,
  disabled = false,
  loading = false,
  onPress,
}: {
  icon: FC<{ className?: string }>;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      size="md"
      color={destructive ? "tertiary-destructive" : "tertiary"}
      iconLeading={Icon}
      isDisabled={disabled}
      isLoading={loading}
      showTextWhileLoading
      onPress={onPress}
      className={cn(
        "min-h-11 w-full justify-start gap-2.5 rounded-none font-medium *:data-icon:size-4 focus-visible:-outline-offset-2",
        !destructive && "text-primary hover:text-primary",
      )}
    >
      {label}
    </Button>
  );
}

export function ActionsSection({
  conversation,
  onConfirm,
  onStopAgents,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onConfirm: (kind: ConfirmedAction | DirectChannelAction) => void;
  onStopAgents: () => void;
  onChanged: () => Promise<void>;
}) {
  const setArchived = useServerFn(setPublicChannelArchived);
  const [unarchiving, setUnarchiving] = useState(false);
  const [error, setError] = useState("");
  const capabilities = conversation.channelCapabilities;

  const showArchive = conversation.archived ? capabilities.unarchive : capabilities.archive;
  const showLeave = capabilities.leave && !conversation.archived;
  const showStop = conversation.canStopAgents;
  const showDelete = conversation.canDelete && !conversation.archived;

  if (!showArchive && !showLeave && !showStop && !showDelete) return null;

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
    <section>
      <SettingsCard divided className="overflow-hidden">
        {conversation.archived
          ? capabilities.unarchive && (
              <ActionRow
                icon={Unarchive}
                label={
                  unarchiving ? m.channel_settings_unarchiving() : m.channel_settings_unarchive()
                }
                disabled={unarchiving}
                loading={unarchiving}
                onPress={() => void unarchive()}
              />
            )
          : capabilities.archive && (
              <ActionRow
                icon={Archive}
                label={m.channel_settings_archive()}
                onPress={() => onConfirm("archive")}
              />
            )}
        {showLeave && (
          <ActionRow
            icon={LogOut}
            label={m.channel_settings_leave()}
            onPress={() => onConfirm("leave")}
          />
        )}
        {showStop && (
          <ActionRow icon={StopCircle} label={m.channel_stop_agents()} onPress={onStopAgents} />
        )}
        {showDelete && (
          <ActionRow
            icon={Trash01}
            label={m.channel_settings_delete()}
            destructive
            onPress={() => onConfirm("delete")}
          />
        )}
      </SettingsCard>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </section>
  );
}
