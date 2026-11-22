import {
  Moon01 as Moon,
  MessageSquare01 as MessagesSquare,
  Sun,
  SunSetting01 as SunMoon,
  Type01 as TypeIcon,
} from "@untitledui/icons";
import { Toggle } from "#src/components/base/toggle/toggle";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import {
  MESSAGE_FONT_SIZES,
  parseMessageFontSize,
  useMessageFontSize,
  type MessageFontSize,
} from "#src/features/settings/message-font-size";
import { MessageFontSizePreview } from "#src/features/settings/message-font-size-preview";
import { useShowAgentModel } from "#src/features/settings/show-agent-model";
import { useLiveAgentActivity } from "#src/features/settings/live-agent-activity";
import {
  SettingsCard,
  SettingsField,
  SettingsGroup,
  SettingsPage,
} from "#src/components/settings-layout";
import { m } from "#src/paraglide/messages";
import type { SettingsContentProps } from "./settings-content";

const BUTTON_GROUP_RESPONSIVE_CLASS = "max-w-full flex-wrap";
const BUTTON_GROUP_ITEM_RTL_CLASS =
  "rtl:first:rounded-l-none rtl:first:rounded-s-lg rtl:last:rounded-r-none rtl:last:rounded-e-lg";

export function PreferencesSettings({
  profile,
  theme,
  onThemeChange,
  hideEmptySidebarSections,
  onHideEmptySidebarSectionsChange,
  messageFullWidth,
  onMessageFullWidthChange,
}: Pick<
  SettingsContentProps,
  | "profile"
  | "theme"
  | "onThemeChange"
  | "hideEmptySidebarSections"
  | "onHideEmptySidebarSectionsChange"
  | "messageFullWidth"
  | "onMessageFullWidthChange"
>) {
  const [messageFontSize, setMessageFontSize] = useMessageFontSize();
  const [showAgentModel, setShowAgentModel] = useShowAgentModel();
  const [liveAgentActivity, setLiveAgentActivity] = useLiveAgentActivity();
  const messageFontSizeLabels: Record<MessageFontSize, string> = {
    sm: m.preferences_message_font_size_small(),
    md: m.preferences_message_font_size_medium(),
    lg: m.preferences_message_font_size_large(),
  };

  return (
    <SettingsPage>
      <p className="text-sm text-tertiary">{m.preferences_saved_on_device()}</p>
      <SettingsGroup icon={TypeIcon} label={m.preferences_appearance()}>
        <SettingsCard>
          <SettingsField
            label={m.preferences_light_dark()}
            description={m.preferences_appearance_description()}
          >
            <ButtonGroup
              aria-label={m.preferences_appearance()}
              size="sm"
              className={BUTTON_GROUP_RESPONSIVE_CLASS}
              selectedKeys={[theme]}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next !== undefined) onThemeChange(String(next) as typeof theme);
              }}
            >
              <ButtonGroupItem
                id="system"
                iconLeading={SunMoon}
                className={BUTTON_GROUP_ITEM_RTL_CLASS}
              >
                {m.preferences_system()}
              </ButtonGroupItem>
              <ButtonGroupItem id="light" iconLeading={Sun} className={BUTTON_GROUP_ITEM_RTL_CLASS}>
                {m.preferences_light()}
              </ButtonGroupItem>
              <ButtonGroupItem id="dark" iconLeading={Moon} className={BUTTON_GROUP_ITEM_RTL_CLASS}>
                {m.preferences_dark()}
              </ButtonGroupItem>
            </ButtonGroup>
          </SettingsField>
        </SettingsCard>
        <SettingsCard>
          <SettingsField
            label={m.preferences_message_font_size()}
            description={m.preferences_message_font_size_description()}
          >
            <ButtonGroup
              aria-label={m.preferences_message_font_size()}
              size="sm"
              className={BUTTON_GROUP_RESPONSIVE_CLASS}
              selectedKeys={[messageFontSize]}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next !== undefined) setMessageFontSize(parseMessageFontSize(String(next)));
              }}
            >
              {MESSAGE_FONT_SIZES.map((size) => (
                <ButtonGroupItem key={size} id={size} className={BUTTON_GROUP_ITEM_RTL_CLASS}>
                  {messageFontSizeLabels[size]}
                </ButtonGroupItem>
              ))}
            </ButtonGroup>
          </SettingsField>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-tertiary">{m.preferences_preview()}</p>
            <MessageFontSizePreview senderName={profile.name} senderAvatarUrl={profile.avatarUrl} />
          </div>
        </SettingsCard>
        <SettingsCard>
          <SettingsField
            inline
            label={m.preferences_show_agent_model()}
            description={m.preferences_show_agent_model_description()}
          >
            <span dir="ltr" className="inline-flex">
              <Toggle
                size="md"
                aria-label={m.preferences_show_agent_model()}
                isSelected={showAgentModel}
                onChange={setShowAgentModel}
              />
            </span>
          </SettingsField>
          <SettingsField
            inline
            label={m.preferences_live_agent_activity()}
            description={m.preferences_live_agent_activity_description()}
          >
            <span dir="ltr" className="inline-flex">
              <Toggle
                size="md"
                aria-label={m.preferences_live_agent_activity()}
                isSelected={liveAgentActivity}
                onChange={setLiveAgentActivity}
              />
            </span>
          </SettingsField>
          <SettingsField
            inline
            label={m.preferences_hide_empty_sidebar_sections()}
            description={m.preferences_hide_empty_sidebar_sections_description()}
          >
            <span dir="ltr" className="inline-flex">
              <Toggle
                size="md"
                aria-label={m.preferences_hide_empty_sidebar_sections()}
                isSelected={hideEmptySidebarSections}
                onChange={onHideEmptySidebarSectionsChange}
              />
            </span>
          </SettingsField>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup icon={MessagesSquare} label={m.preferences_conversations()}>
        <SettingsCard>
          <SettingsField
            inline
            label={m.preferences_message_full_width()}
            description={m.preferences_message_full_width_description()}
          >
            <span dir="ltr" className="inline-flex">
              <Toggle
                size="md"
                aria-label={m.preferences_message_full_width()}
                isSelected={messageFullWidth}
                onChange={onMessageFullWidthChange}
              />
            </span>
          </SettingsField>
        </SettingsCard>
      </SettingsGroup>
    </SettingsPage>
  );
}
