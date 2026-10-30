import { Fragment, useState, type ReactNode } from "react";
import {
  Bell01,
  BellOff01,
  Folder,
  MessageChatSquare,
  Pin01,
  Plus,
  XClose,
} from "@untitledui/icons";
import { SubmenuTrigger } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { PinRef } from "./pinned-conversations";
import { useSidebarActions } from "./sidebar-lists";
import type { ChatSection } from "./chat-section.schemas";
import { ChatSectionDialog } from "./chat-section-dialog";
import {
  conversationRowMenuEnabled,
  conversationRowMenuItems,
  type ConversationRowMenuItem,
} from "./conversation-row-menu-model";

function itemIcon(item: ConversationRowMenuItem) {
  if (item.id === "mark-unread") return MessageChatSquare;
  if (item.id === "pin") return Pin01;
  // The icon shows what choosing it does: a muted row offers the bell back.
  if (item.id === "mute") return item.muted ? Bell01 : BellOff01;
  return XClose;
}

function itemLabel(item: ConversationRowMenuItem): string {
  if (item.id === "mark-unread") return m.conversation_menu_mark_unread();
  if (item.id === "pin")
    return item.pinned ? m.conversation_menu_unpin() : m.conversation_menu_pin();
  if (item.id === "mute")
    return item.muted ? m.conversation_menu_unmute() : m.conversation_menu_mute();
  return m.conversation_menu_close();
}

/** What the menu acts on: a channel row (membership decides) or a direct-message row (always the
 * viewer's own conversation). */
export type ConversationRowMenuTarget =
  | { kind: "channel"; id: string; joined: boolean; pinned: boolean; muted: boolean }
  | { kind: "direct"; conversationId: string; pinned: boolean; muted: boolean };

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
  /** A move that failed for good, with the section it was moving the row into. */
  onSectionError: (retry: () => Promise<void>, sectionId?: string) => void;
  /** The row, whose link must be a React Aria link (`ConversationRow`): the trigger attaches to the
   * first pressable inside it. */
  children: ReactNode;
}) {
  const enabled = target.kind === "direct" || conversationRowMenuEnabled(target);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const toast = useAppToast();
  const actions = useSidebarActions();
  const items = conversationRowMenuItems(target);
  const row: PinRef =
    target.kind === "channel"
      ? { kind: "channel", channelId: target.id }
      : { kind: "direct", conversationId: target.conversationId };

  function moveTo(sectionId: string | null) {
    const save = () => actions.moveToSection(row, sectionId);
    save().catch(() => onSectionError(save, sectionId ?? undefined));
  }

  /** Applies the change to the row at once (the menu closes as it would for any choice) and saves
   * it; a save that fails for good puts the row back, and the section it was moving into says so
   * (§13). */
  function handleAction(key: unknown) {
    if (key === "section-new") return setCreating(true);
    if (String(key).startsWith("section:")) {
      const id = String(key).slice("section:".length);
      moveTo(id === "home" ? null : id);
      return;
    }
    const run = {
      "mark-unread": () => actions.markUnread(row),
      pin: () => actions.setPinned(row, !target.pinned),
      mute: () => actions.setMuted(row, !target.muted),
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
    <>
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
                  <Dropdown.Separator />
                  <Dropdown.Item
                    id="section-new"
                    icon={Plus}
                    label={m.chat_section_create()}
                    selectionIndicator="none"
                  />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </SubmenuTrigger>
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.id === "close-chat" && <Dropdown.Separator />}
                <Dropdown.Item
                  id={item.id}
                  icon={itemIcon(item)}
                  label={itemLabel(item)}
                  selectionIndicator="none"
                />
              </Fragment>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      {/* A section made from here takes the row in. */}
      {creating && (
        <ChatSectionDialog
          onClose={() => setCreating(false)}
          onCreated={(section) => moveTo(section.id)}
        />
      )}
    </>
  );
}
