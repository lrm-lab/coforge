import { Fragment, useState, type ReactNode } from "react";
import { Folder, MessageChatSquare, Pin01, XClose } from "@untitledui/icons";
import { SubmenuTrigger } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { PinRef } from "./pinned-conversations";
import { useSidebarActions } from "./sidebar-lists";
import type { ChatSection } from "./chat-section.schemas";
import {
  conversationRowMenuEnabled,
  conversationRowMenuItems,
  type ConversationRowMenuItem,
} from "./conversation-row-menu-model";

function itemIcon(id: ConversationRowMenuItem["id"]) {
  if (id === "mark-unread") return MessageChatSquare;
  if (id === "pin") return Pin01;
  return XClose;
}

function itemLabel(item: ConversationRowMenuItem): string {
  if (item.id === "mark-unread") return m.conversation_menu_mark_unread();
  if (item.id === "pin")
    return item.pinned ? m.conversation_menu_unpin() : m.conversation_menu_pin();
  return m.conversation_menu_close();
}

/** What the menu acts on: a channel row (membership decides) or a direct-message row (always the
 * viewer's own conversation). */
export type ConversationRowMenuTarget =
  | { kind: "channel"; id: string; joined: boolean; pinned: boolean }
  | { kind: "direct"; conversationId: string; pinned: boolean };

/**
 * The list item around a conversation row: the row's link is the trigger of a React Aria context
 * menu (`MenuTrigger trigger="contextMenu"`, #122/#126/#128). The framework opens it on right
 * click, long-press on touch and the platform's keyboard/screen-reader shortcuts, and places it
 * at that point; a left click stays an ordinary navigation. Close Chat acts at once, without a
 * confirm: it only hides the chat from the viewer's own list, and a new message from someone else
 * brings it back.
 */
export function ConversationRowMenu({
  target,
  sections,
  sectionsReady,
  onSectionError,
  children,
}: {
  target: ConversationRowMenuTarget;
  sections: readonly ChatSection[];
  sectionsReady: boolean;
  onSectionError: (retry: () => Promise<void>) => void;
  /** The row, whose link must be a React Aria link (`ConversationRow`): the trigger attaches to the
   * first pressable inside it. */
  children: ReactNode;
}) {
  const enabled = target.kind === "direct" || conversationRowMenuEnabled(target);
  const [open, setOpen] = useState(false);
  const toast = useAppToast();
  const actions = useSidebarActions();
  const items = conversationRowMenuItems(target);
  const row: PinRef =
    target.kind === "channel"
      ? { kind: "channel", channelId: target.id }
      : { kind: "direct", conversationId: target.conversationId };

  /** Applies the change to the row at once (the menu closes as it would for any choice) and saves
   * it; a failed save puts the row back, and the toast says it failed (§13). */
  function handleAction(key: unknown) {
    if (String(key).startsWith("section:")) {
      const id = String(key).slice("section:".length);
      const save = () => actions.moveToSection(row, id === "home" ? null : id);
      save().catch(() => onSectionError(save));
      return;
    }
    const run = {
      "mark-unread": () => actions.markUnread(row),
      pin: () => actions.setPinned(row, !target.pinned),
      "close-chat": () => actions.close(row),
    }[String(key)];
    run?.().catch((cause: unknown) => {
      console.error("conversation row menu action failed", cause);
      toast.error(m.conversation_menu_action_error());
    });
  }

  // The list item around the row belongs to the list (`DirectoryDragRow`).
  if (!enabled) return children;

  return (
    <Dropdown.Root trigger="contextMenu" isOpen={open} onOpenChange={setOpen}>
      {children}
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu aria-label={m.conversation_menu_label()} onAction={handleAction}>
          <SubmenuTrigger>
            <Dropdown.Item
              id="move-section"
              icon={Folder}
              label={m.chat_section_move()}
              isDisabled={!sectionsReady}
              selectionIndicator="none"
            />
            <Dropdown.Popover placement="right top">
              <Dropdown.Menu aria-label={m.chat_section_move()} onAction={handleAction}>
                <Dropdown.Item
                  id="section:home"
                  label={
                    target.kind === "channel" ? m.channels_title() : m.messages_agents_action()
                  }
                  selectionIndicator="none"
                />
                {sections.map((section) => (
                  <Dropdown.Item
                    key={section.id}
                    id={`section:${section.id}`}
                    label={`${section.emoji ? `${section.emoji} ` : ""}${section.name}`}
                    selectionIndicator="none"
                  />
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </SubmenuTrigger>
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.id === "close-chat" && <Dropdown.Separator />}
              <Dropdown.Item
                id={item.id}
                icon={itemIcon(item.id)}
                label={itemLabel(item)}
                selectionIndicator="none"
              />
            </Fragment>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
