import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Settings01 as Settings, User01 } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Toggle } from "#src/components/base/toggle/toggle";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { HEADER_ICON_CLASS } from "./conversation-header-tabs";
import { setDirectConversationCollapseLongMessages } from "./conversations.functions";
import {
  DetailsPaneHeader,
  PreferenceRow,
  SectionEyebrow,
  SettingsCard,
} from "./settings-panel-parts";
import { useSidebarActions, useSidebarLists } from "./sidebar-lists";
import { SidebarSectionSelect } from "./sidebar-section-select";

export function DirectSettingsToggleButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <ButtonUtility
      icon={Settings}
      size="sm"
      color="tertiary"
      aria-expanded={open}
      className={cn(HEADER_ICON_CLASS, open && "bg-primary_hover")}
      tooltip={m.direct_settings_open()}
      onClick={onToggle}
    />
  );
}

export function DirectSettingsPanel({
  conversationId,
  name,
  avatar,
  open,
  onClose,
  collapseLongMessages,
  onChanged,
}: {
  conversationId: string;
  name: string;
  avatar?: ReactNode;
  open: boolean;
  onClose: () => void;
  collapseLongMessages?: boolean;
  onChanged: () => Promise<void>;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229
    )
      return;
    if (sectionRef.current?.offsetParent === null) return;
    if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
    event.preventDefault();
    onClose();
  });

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <section
      ref={sectionRef}
      aria-label={m.direct_settings_open()}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary"
    >
      <DetailsPaneHeader title={m.conversation_details_title()} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 pb-6 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          {avatar}
          <h3 className="min-w-0 truncate text-md font-semibold text-primary">{name}</h3>
          <Badge size="sm" color="gray" className="shrink-0">
            {m.direct_settings_label()}
          </Badge>
        </div>
        <DirectPreferences
          conversationId={conversationId}
          collapseLongMessages={collapseLongMessages}
          onChanged={onChanged}
        />
      </div>
    </section>
  );
}

function DirectPreferences({
  conversationId,
  collapseLongMessages,
  onChanged,
}: {
  conversationId: string;
  collapseLongMessages?: boolean;
  onChanged: () => Promise<void>;
}) {
  const setCollapse = useServerFn(setDirectConversationCollapseLongMessages);
  const actions = useSidebarActions();
  const row = useSidebarLists().directs.rows.find(
    (entry) => entry.conversationId === conversationId,
  );
  const muted = row?.muted === true;
  const [pending, setPending] = useState<"mute" | "collapse" | null>(null);
  const [error, setError] = useState("");

  async function change(which: "mute" | "collapse", write: () => Promise<unknown>) {
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
    <section>
      <SectionEyebrow icon={User01} title={m.direct_settings_preferences()} />
      <SettingsCard divided>
        <PreferenceRow title={m.conversation_sidebar_section()}>
          <SidebarSectionSelect
            target={{ kind: "direct", conversationId }}
            isDisabled={pending !== null}
            onError={() => setError(m.direct_settings_preference_error())}
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
        <PreferenceRow title={m.direct_settings_collapse_long_messages()}>
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
      </SettingsCard>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </section>
  );
}
