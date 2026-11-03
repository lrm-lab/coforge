import {
  ChevronDown,
  ChevronRightDouble,
  DotsHorizontal,
  Edit01 as Edit,
  Pin01 as Pin,
  Plus,
  Trash01 as Trash,
} from "@untitledui/icons";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { RecordSideRenameDialog } from "./record-side-rename-dialog";
import type { ChatSessionRow, useRecordSideChatSessions } from "./use-record-side-chat-sessions";

export function RecordSideChatHeader({
  busy,
  chatSessions,
  activeSessionId,
  sessionTitle,
  totalCount,
  pinned,
  actions,
  onTogglePinned,
  onCollapse,
}: {
  busy: boolean;
  chatSessions: ChatSessionRow[];
  activeSessionId: string | null;
  sessionTitle: string;
  totalCount: number;
  pinned: boolean;
  actions: ReturnType<typeof useRecordSideChatSessions>;
  onTogglePinned: () => void;
  onCollapse: () => void;
}) {
  const {
    onNewChat,
    onSelectSession,
    renameOpen,
    setRenameOpen,
    renameDraft,
    setRenameDraft,
    openRename,
    submitRename,
    onDeleteSession,
  } = actions;
  return (
    <>
      <div className="flex items-center gap-1 border-b border-secondary px-3 py-2.5">
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={Plus}
          aria-label={m.records_side_chat_new()}
          tooltip={m.records_side_chat_new()}
          isDisabled={busy}
          onClick={() => void onNewChat()}
        />
        <Dropdown.Root>
          <Button
            size="sm"
            color="tertiary"
            className="min-w-0 flex-1 justify-start"
            iconTrailing={ChevronDown}
            isDisabled={busy || chatSessions.length === 0}
            aria-label={m.records_side_chat_history()}
          >
            <span className="truncate">{sessionTitle}</span>
          </Button>
          <Dropdown.Popover placement="bottom start" className="w-64">
            <Dropdown.Menu
              aria-label={m.records_side_chat_history()}
              selectedKeys={activeSessionId ? [activeSessionId] : []}
              selectionMode="single"
              onAction={(key) => {
                if (typeof key === "string") void onSelectSession(key);
              }}
            >
              {chatSessions.length === 0 ? (
                <Dropdown.Item id="empty" isDisabled label={m.records_side_chat_no_history()} />
              ) : (
                chatSessions.map((row) => (
                  <Dropdown.Item
                    key={row.id}
                    id={row.id}
                    label={row.title.trim() || m.records_side_chat_untitled()}
                    addon={new Date(row.updatedAt).toLocaleString()}
                  />
                ))
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
        <span className="shrink-0 text-xs text-tertiary">
          {m.records_side_chat_count({ count: totalCount })}
        </span>
        <Dropdown.Root>
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={DotsHorizontal}
            aria-label={m.records_side_chat_menu()}
            tooltip={m.records_side_chat_menu()}
            isDisabled={busy || !activeSessionId}
          />
          <Dropdown.Popover placement="bottom end" className="w-40">
            <Dropdown.Menu
              aria-label={m.records_side_chat_menu()}
              onAction={(key) => {
                if (key === "rename") openRename();
                if (key === "delete") void onDeleteSession();
              }}
            >
              <Dropdown.Item id="rename" icon={Edit} label={m.records_side_chat_rename()} />
              <Dropdown.Item id="delete" icon={Trash} label={m.records_side_chat_delete()} />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={Pin}
          aria-label={pinned ? m.records_side_chat_unpin() : m.records_side_chat_pin()}
          tooltip={pinned ? m.records_side_chat_unpin() : m.records_side_chat_pin()}
          aria-pressed={pinned}
          className={pinned ? "text-brand-secondary" : undefined}
          onClick={onTogglePinned}
        />
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={ChevronRightDouble}
          aria-label={m.controls_hide_sidebar()}
          tooltip={m.controls_hide_sidebar()}
          onClick={onCollapse}
        />
      </div>

      <RecordSideRenameDialog
        open={renameOpen}
        draft={renameDraft}
        busy={busy}
        onDraftChange={setRenameDraft}
        onClose={() => setRenameOpen(false)}
        onSubmit={() => void submitRename()}
      />
    </>
  );
}
