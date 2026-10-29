import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Heading } from "react-aria-components";
import { Settings01 as Settings } from "@untitledui/icons";

import {
  Dialog as SlideoutDialog,
  Modal as SlideoutModal,
  ModalOverlay as SlideoutOverlay,
  SlideoutMenu,
} from "#src/components/application/slideout-menus/slideout-menu";
import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Toggle } from "#src/components/base/toggle/toggle";
import { m } from "#src/paraglide/messages";
import { SettingsPanelHeader } from "./channel-settings-header";
import { HEADER_ICON_CLASS } from "./conversation-header-tabs";
import { setDirectConversationCollapseLongMessages } from "./conversations.functions";
import { PanelSection, PreferenceRow } from "./settings-panel-parts";
import { useSidebarActions, useSidebarLists } from "./sidebar-lists";

type DirectSettings = {
  conversationId: string;
  /** What the DM is called: the other side's name. */
  name: string;
  /** The viewer's own preference as the page read it. Absent means on. */
  collapseLongMessages?: boolean;
  /** Re-reads the page after the preference changed, so the open stream folds at once. */
  onChanged: () => Promise<void>;
};

/**
 * The gear in a direct message's header and the panel it opens: the viewer's own preferences for
 * this DM, the same three (pin, mute, collapse long messages) for a DM with an Agent and one between
 * members. The panel mounts only while open, so a header outside Chat reads no sidebar until then.
 */
export function DirectSettingsButton(props: DirectSettings) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ButtonUtility
        icon={Settings}
        size="sm"
        color="tertiary"
        className={HEADER_ICON_CLASS}
        tooltip={m.direct_settings_open()}
        onClick={() => setOpen(true)}
      />
      {open && <DirectSettingsPanel {...props} open={open} onOpenChange={setOpen} />}
    </>
  );
}

function DirectSettingsPanel({
  name,
  open,
  onOpenChange,
  ...settings
}: DirectSettings & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <SlideoutOverlay isOpen={open} isDismissable onOpenChange={onOpenChange}>
      <SlideoutModal className="max-w-136">
        <SlideoutDialog aria-label={m.direct_settings_open()} className="gap-0">
          <SettingsPanelHeader>
            <div className="flex min-w-0 items-center gap-2">
              <Heading slot="title" className="truncate text-lg font-semibold text-primary">
                {name}
              </Heading>
              <Badge size="sm" color="gray" className="shrink-0">
                {m.direct_settings_label()}
              </Badge>
            </div>
          </SettingsPanelHeader>
          <SlideoutMenu.Content className="gap-0 pb-6">
            <DirectPreferences {...settings} />
          </SlideoutMenu.Content>
        </SlideoutDialog>
      </SlideoutModal>
    </SlideoutOverlay>
  );
}

function DirectPreferences({
  conversationId,
  collapseLongMessages,
  onChanged,
}: Omit<DirectSettings, "name">) {
  const setCollapse = useServerFn(setDirectConversationCollapseLongMessages);
  const actions = useSidebarActions();
  // The sidebar owns pins and mutes: its row is the truth, and its optimistic action is the write,
  // so the list moves as the toggle does and the row menu's items agree with it. A DM the sidebar
  // does not list yet reads as unpinned and audible.
  const row = useSidebarLists().directs.rows.find(
    (entry) => entry.conversationId === conversationId,
  );
  const pinned = row?.pinned === true;
  const muted = row?.muted === true;
  const [pending, setPending] = useState<"pin" | "mute" | "collapse" | null>(null);
  const [error, setError] = useState("");

  async function change(which: "pin" | "mute" | "collapse", write: () => Promise<unknown>) {
    setPending(which);
    setError("");
    try {
      await write();
    } catch {
      setError(m.direct_settings_preference_error());
    } finally {
      setPending(null);
    }
  }

  return (
    <PanelSection title={m.direct_settings_preferences()}>
      <div className="divide-y divide-secondary">
        <PreferenceRow
          title={m.direct_settings_pin()}
          description={m.direct_settings_pin_description()}
        >
          <Toggle
            size="md"
            aria-label={m.direct_settings_pin()}
            isSelected={pinned}
            isDisabled={pending !== null}
            onChange={(next) =>
              void change("pin", () => actions.setPinned({ kind: "direct", conversationId }, next))
            }
          />
        </PreferenceRow>
        <PreferenceRow
          title={m.direct_settings_mute()}
          description={m.direct_settings_mute_description()}
        >
          <Toggle
            size="md"
            aria-label={m.direct_settings_mute()}
            isSelected={muted}
            isDisabled={pending !== null}
            onChange={(next) =>
              void change("mute", () => actions.setMuted({ kind: "direct", conversationId }, next))
            }
          />
        </PreferenceRow>
        <PreferenceRow
          title={m.direct_settings_collapse_long_messages()}
          description={m.direct_settings_collapse_long_messages_description()}
        >
          <Toggle
            size="md"
            aria-label={m.direct_settings_collapse_long_messages()}
            isSelected={collapseLongMessages === true}
            isDisabled={pending !== null}
            onChange={(next) =>
              void change("collapse", async () => {
                await setCollapse({ data: { conversationId, collapseLongMessages: next } });
                await onChanged();
              })
            }
          />
        </PreferenceRow>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </PanelSection>
  );
}
