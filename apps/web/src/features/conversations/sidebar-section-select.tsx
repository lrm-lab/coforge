import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import { setPublicConversationPinned } from "./channels.functions";
import type { PinRef } from "./pinned-conversations";
import { useChatSections, useSidebarActions, useSidebarLists } from "./sidebar-lists";
import {
  DEFAULT_SECTION_OPTION,
  PINNED_SECTION_OPTION,
  buildSidebarSectionOptions,
  parseSidebarSectionKey,
  resolveSidebarSectionKey,
} from "./sidebar-section-select-model";

export function SidebarSectionSelect({
  target,
  fallbackPinned = false,
  isDisabled = false,
  onChanged,
  onError,
}: {
  target: PinRef;
  fallbackPinned?: boolean;
  isDisabled?: boolean;
  onChanged?: () => Promise<void>;
  onError?: () => void;
}) {
  const actions = useSidebarActions();
  const lists = useSidebarLists();
  const { sections } = useChatSections();
  const setChannelPinned = useServerFn(setPublicConversationPinned);
  const [pending, setPending] = useState(false);

  const conversationId = target.kind === "channel" ? target.channelId : target.conversationId;
  const listedRow =
    target.kind === "channel"
      ? lists.channels.find((channel) => channel.id === conversationId)
      : lists.directs.rows.find((direct) => direct.conversationId === conversationId);
  const pinned = listedRow ? listedRow.pinned : fallbackPinned;
  const selectedKey = resolveSidebarSectionKey({ conversationId, pinned, sections });
  const defaultLabel = target.kind === "channel" ? m.channels_title() : m.messages_agents_action();
  const options = buildSidebarSectionOptions({
    sections,
    pinnedLabel: m.conversation_pinned_section(),
    defaultLabel,
  });

  async function handleSelect(nextKey: string) {
    if (nextKey === selectedKey) return;
    setPending(true);
    try {
      const choice = parseSidebarSectionKey(nextKey);
      if (choice.kind === "pinned") {
        if (target.kind === "channel" && !listedRow) {
          await setChannelPinned({ data: { channelId: target.channelId, pinned: true } });
        } else {
          await actions.setPinned(target, true);
        }
      } else if (choice.kind === "section") {
        await actions.moveToSection(target, choice.sectionId);
      } else if (
        target.kind === "channel" &&
        !listedRow &&
        !sections.some((section) => section.conversationIds.includes(conversationId))
      ) {
        await setChannelPinned({ data: { channelId: target.channelId, pinned: false } });
      } else {
        await actions.moveToSection(target, null);
      }
      await onChanged?.();
    } catch {
      onError?.();
    } finally {
      setPending(false);
    }
  }

  return (
    <Select
      aria-label={m.conversation_sidebar_section()}
      size="sm"
      className="w-44"
      selectedKey={selectedKey}
      isDisabled={isDisabled || pending}
      onSelectionChange={(key) => {
        if (key === null) return;
        const value = String(key);
        if (
          value !== PINNED_SECTION_OPTION &&
          value !== DEFAULT_SECTION_OPTION &&
          !value.startsWith("section:")
        ) {
          return;
        }
        void handleSelect(value);
      }}
    >
      {options.map((option) => (
        <Select.Item key={option.id} id={option.id} label={option.label} />
      ))}
    </Select>
  );
}
