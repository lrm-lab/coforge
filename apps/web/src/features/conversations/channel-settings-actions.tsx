import { useState, type ComponentType } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button as AriaButton } from "react-aria-components";
import {
  Archive,
  LogOut01 as LogOut,
  RefreshCcw01 as Unarchive,
  StopCircle,
  Trash01,
} from "@untitledui/icons";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConfirmedAction } from "./channel-action-confirm-dialog";
import type { ChannelConversationView } from "./channel-conversation";
import type { DirectChannelAction } from "./channel-direct-actions";
import { setPublicChannelArchived } from "./channel-lifecycle.functions";
import { SettingsCard } from "./settings-panel-parts";

const ROW_CLASS =
  "flex min-h-11 w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

function ActionRow({
  icon: Icon,
  label,
  destructive = false,
  disabled = false,
  onPress,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <AriaButton
      isDisabled={disabled}
      onPress={onPress}
      className={cn(
        ROW_CLASS,
        destructive
          ? "text-error-primary hover:bg-error-primary hover:text-error-primary_hover"
          : "text-primary",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", destructive ? "text-current" : "text-fg-quaternary")}
      />
      <span>{label}</span>
    </AriaButton>
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
