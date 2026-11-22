import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Sliders04 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { useAppToast } from "#src/components/ui/toast";
import { memberOption } from "#src/features/pickers/entity-picker";
import { EntityPickerField } from "#src/features/pickers/entity-picker-field";
import { m } from "#src/paraglide/messages";
import type { ConfirmedAction } from "./channel-action-confirm-dialog";
import type { ChannelConversationView } from "./channel-conversation";
import type { DirectChannelAction } from "./channel-direct-actions";
import { isPrivateChannel } from "./channel-visibility";
import { setPublicChannelCoordinator } from "./channels.functions";
import { PreferenceRow, SectionEyebrow, SettingsCard } from "./settings-panel-parts";

export function ChannelSettingsGroup({
  conversation,
  onAction,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onAction: (kind: ConfirmedAction | DirectChannelAction) => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useAppToast();
  const setCoordinator = useServerFn(setPublicChannelCoordinator);
  const [saving, setSaving] = useState(false);

  const canUpdate = conversation.channelCapabilities.update;
  const showVisibility =
    (conversation.canChangeVisibility || conversation.canHideGeneral) && !conversation.archived;

  if (!canUpdate && !showVisibility) return null;

  const agents = (conversation.mentionables ?? []).filter(
    (entry) => entry.kind === "agent" && !entry.outsider,
  );
  const selected = conversation.coordinatorAgent
    ? `agent:${conversation.coordinatorAgent.id}`
    : "none";
  const priv = isPrivateChannel(conversation);

  async function changeCoordinator(value: string) {
    setSaving(true);
    try {
      await setCoordinator({
        data: {
          channelId: conversation.conversationId,
          coordinatorAgentId: value === "none" ? null : value.slice("agent:".length),
        },
      });
      await onChanged();
    } catch {
      toast.error(m.channel_settings_coordinator_error());
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <SectionEyebrow icon={Sliders04} title={m.channel_settings_group_title()} />
      <SettingsCard divided>
        {canUpdate && (
          <div className="p-3.5">
            <EntityPickerField
              fieldLabel={m.channel_settings_coordinator_label()}
              label={m.channel_settings_coordinator_label()}
              hint={m.channel_settings_coordinator_hint()}
              selectedKey={selected}
              isDisabled={saving || conversation.archived}
              options={[
                { id: "none", label: m.channel_settings_coordinator_none() },
                ...agents.map(memberOption),
              ]}
              onSelect={(key) => void changeCoordinator(key)}
            />
          </div>
        )}
        {showVisibility && (
          <PreferenceRow
            title={priv ? m.channel_private() : m.channel_settings_public()}
            description={
              priv
                ? m.channel_settings_private_description()
                : m.channel_settings_public_description()
            }
          >
            {conversation.canHideGeneral ? (
              <Button size="sm" color="secondary" onPress={() => onAction("hide-general")}>
                {m.channel_settings_hide_general()}
              </Button>
            ) : (
              <Button
                size="sm"
                color="secondary"
                onPress={() => onAction(priv ? "make-public" : "make-private")}
              >
                {priv ? m.channel_settings_make_public() : m.channel_settings_make_private()}
              </Button>
            )}
          </PreferenceRow>
        )}
      </SettingsCard>
    </section>
  );
}
