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
import { UNDO_TOAST_MS, useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { PinRef } from "./pinned-conversations";
import { useSidebarActions } from "./sidebar-lists";
import type { ChatSection } from "./chat-section.schemas";
import { ChatSectionDialog } from "./chat-section-dialog";
import {
  CHANNEL_NOTIFICATION_LEVELS,
  notificationLevelLabel,
  type ChannelNotificationLevel,
} from "./notification-levels";
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
  | {
      kind: "channel";
      id: string;
      joined: boolean;
      pinned: boolean;
      muted: boolean;
      notificationLevel: ChannelNotificationLevel;
    }
  | { kind: "direct"; conversationId: string; pinned: boolean; muted: boolean };

/**
 * The list item around a conversation row: the row's link is the trigger of a React Aria context
 * menu (`MenuTrigger trigger="contextMenu"`, #122/#126/#128). The framework opens it on right
 * click, long-press on touch and the platform's keyboard/screen-reader shortcuts, and places it
 * at that point; a left click stays an ordinary navigation. Close Chat acts at once, without a
 * confirm: it only hides the chat from the viewer's own list, a new message from someone else
 * brings it back, and its toast offers Undo.
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
    if (String(key).startsWith("notify:") && target.kind === "channel") {
      const level = String(key).slice("notify:".length) as ChannelNotificationLevel;
      if (level === target.notificationLevel) return;
      actions.setNotificationLevel(target.id, level).catch((cause: unknown) => {
        console.error("conversation row menu action failed", cause);
        toast.error(m.conversation_menu_action_error());
      });
      return;
    }
    if (String(key).startsWith("section:")) {
      const id = String(key).slice("section:".length);
      moveTo(id === "home" ? null : id);
      return;
    }
    /** Closes the chat, then offers the way back: Undo reopens it where it stood in the list. */
    const closeChat = async () => {
      await actions.close(row);
      toast.success(m.conversation_closed(), {
        // Closing chat A then chat B keeps both Undos.
        key: row.kind === "channel" ? `channel:${row.channelId}` : `direct:${row.conversationId}`,
        durationMs: UNDO_TOAST_MS,
        action: {
          label: m.action_undo(),
          onClick: () =>
            void actions.reopen(row).catch((cause: unknown) => {
              console.error("closed chat could not be reopened", cause);
              toast.error(m.conversation_menu_action_error());
            }),
        },
      });
    };
    const run = {
      "mark-unread": () => actions.markUnread(row),
      pin: () => actions.setPinned(row, !target.pinned),
      mute: () => actions.setMuted(row, !target.muted),
      "close-chat": closeChat,
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
              <Dropdown.SubmenuPopover>
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
              </Dropdown.SubmenuPopover>
            </SubmenuTrigger>
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.id === "close-chat" && <Dropdown.Separator />}
                {item.id === "notify" && target.kind === "channel" ? (
                  <NotifySubmenu level={target.notificationLevel} onAction={handleAction} />
                ) : (
                  <Dropdown.Item
                    id={item.id}
                    icon={itemIcon(item)}
                    label={itemLabel(item)}
                    selectionIndicator="none"
                  />
                )}
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

/** A channel's four notification levels, the current one ticked (Slack's channel menu). */
function NotifySubmenu({
  level,
  onAction,
}: {
  level: ChannelNotificationLevel;
  onAction: (key: unknown) => void;
}) {
  return (
    <SubmenuTrigger>
      <Dropdown.Item
        id="notify"
        icon={level === "muted" ? BellOff01 : Bell01}
        label={m.channel_notify()}
        selectionIndicator="none"
      />
      <Dropdown.SubmenuPopover>
        <Dropdown.Menu
          aria-label={m.channel_notify()}
          selectionMode="single"
          selectedKeys={[`notify:${level}`]}
          onAction={onAction}
        >
          {CHANNEL_NOTIFICATION_LEVELS.map((each) => (
            <Fragment key={each}>
              {each === "muted" && <Dropdown.Separator />}
              <Dropdown.Item id={`notify:${each}`} label={notificationLevelLabel(each)} />
            </Fragment>
          ))}
        </Dropdown.Menu>
      </Dropdown.SubmenuPopover>
    </SubmenuTrigger>
  );
}
