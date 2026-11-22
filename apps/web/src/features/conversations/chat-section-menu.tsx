import { useState, type ReactNode } from "react";
import { Check, Edit01, FolderPlus, Plus, SwitchVertical02, Trash01 } from "@untitledui/icons";
import type { Selection } from "react-aria-components";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Button } from "#src/components/base/buttons/button";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import type { ChatSectionSortMode } from "./chat-section.schemas";

function sortLabel(mode: ChatSectionSortMode): string {
  if (mode === "recent") return m.chat_section_sort_recent();
  if (mode === "alpha") return m.chat_section_sort_alpha();
  return m.chat_section_sort_manual();
}

function Choice({ label, selected }: { label: string; selected: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Check
        aria-hidden="true"
        className={cx(
          "size-4 shrink-0 stroke-[2.25px] text-fg-brand-primary",
          !selected && "invisible",
        )}
      />
    </span>
  );
}

const SECTION_HEADER_CLASS = "px-4 pt-1.5 pb-1 text-xs font-semibold text-tertiary";

function onlyKey(selection: Selection): string | undefined {
  if (selection === "all") return undefined;
  const [key] = selection;
  return key === undefined ? undefined : String(key);
}

export function SectionSortMenu<Mode extends ChatSectionSortMode>({
  name,
  mode,
  modes,
  onSort,
}: {
  name: string;
  mode: Mode;
  modes: readonly Mode[];
  onSort: (mode: Mode) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = m.chat_section_sort_for({ name });
  return (
    <Dropdown.Root isOpen={open} onOpenChange={setOpen}>
      <Button
        color="tertiary"
        size="xs"
        aria-label={label}
        iconLeading={SwitchVertical02}
        className={cx(
          "relative shrink-0 rounded-md data-icon-only:p-1.5 *:data-icon:stroke-[1.75px] hover:bg-active hover:*:data-icon:text-fg-secondary after:absolute after:-inset-2 after:hidden pointer-coarse:after:block",
          open && "bg-active *:data-icon:text-fg-secondary",
        )}
      />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[mode]}
          onSelectionChange={(selection) => {
            const next = modes.find((entry) => entry === onlyKey(selection));
            if (next && next !== mode) onSort(next);
          }}
        >
          {modes.map((entry) => (
            <Dropdown.Item
              key={entry}
              id={entry}
              textValue={sortLabel(entry)}
              selectionIndicator="none"
            >
              <Choice label={sortLabel(entry)} selected={mode === entry} />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function ChatSectionMenu<Mode extends ChatSectionSortMode>({
  name,
  sortMode,
  sortModes,
  hideEmpty,
  showJoinedOnly = false,
  createDisabled = false,
  onCreateChannel,
  onSort,
  onShowJoinedOnlyChange,
  onHideEmptyChange,
  onEdit,
  onCreate,
  onDelete,
  children,
}: {
  name: string;
  sortMode: Mode;
  sortModes: readonly Mode[];
  hideEmpty: boolean;
  showJoinedOnly?: boolean;
  createDisabled?: boolean;
  onCreateChannel?: () => void;
  onSort: (mode: Mode) => void;
  onShowJoinedOnlyChange?: (joinedOnly: boolean) => void;
  onHideEmptyChange: (hide: boolean) => void;
  onEdit?: () => void;
  onCreate: () => void;
  onDelete?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = m.chat_section_menu({ name });
  const displayKeys = [
    ...(onShowJoinedOnlyChange && showJoinedOnly ? ["show-joined-only"] : []),
    ...(hideEmpty ? ["hide-empty"] : []),
  ];
  return (
    <Dropdown.Root trigger="contextMenu" isOpen={open} onOpenChange={setOpen}>
      {children}
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu
          aria-label={label}
          disabledKeys={createDisabled ? ["create"] : undefined}
          onAction={(key) => {
            if (key === "create-channel") {
              setOpen(false);
              onCreateChannel?.();
            }
            if (key === "edit") {
              setOpen(false);
              onEdit?.();
            }
            if (key === "create") {
              setOpen(false);
              onCreate();
            }
            if (key === "delete") {
              setOpen(false);
              onDelete?.();
            }
          }}
        >
          {onCreateChannel && (
            <>
              <Dropdown.Item
                id="create-channel"
                icon={Plus}
                label={m.channel_create()}
                selectionIndicator="none"
              />
              <Dropdown.Separator />
            </>
          )}
          <Dropdown.Section
            aria-label={m.chat_section_sort()}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[sortMode]}
            onSelectionChange={(selection) => {
              const mode = sortModes.find((entry) => entry === onlyKey(selection));
              if (mode && mode !== sortMode) onSort(mode);
            }}
          >
            <Dropdown.SectionHeader className={SECTION_HEADER_CLASS}>
              {m.chat_section_sort()}
            </Dropdown.SectionHeader>
            {sortModes.map((mode) => (
              <Dropdown.Item
                key={mode}
                id={mode}
                textValue={sortLabel(mode)}
                selectionIndicator="none"
              >
                <Choice label={sortLabel(mode)} selected={sortMode === mode} />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Dropdown.Separator />
          <Dropdown.Section
            aria-label={m.chat_section_display()}
            selectionMode="multiple"
            selectedKeys={displayKeys}
            onSelectionChange={(selection) => {
              if (onShowJoinedOnlyChange) {
                const nextJoined = selection === "all" || selection.has("show-joined-only");
                if (nextJoined !== showJoinedOnly) onShowJoinedOnlyChange(nextJoined);
              }
              const nextHideEmpty = selection === "all" || selection.has("hide-empty");
              if (nextHideEmpty !== hideEmpty) onHideEmptyChange(nextHideEmpty);
            }}
          >
            <Dropdown.SectionHeader className={SECTION_HEADER_CLASS}>
              {m.chat_section_display()}
            </Dropdown.SectionHeader>
            {onShowJoinedOnlyChange && (
              <Dropdown.Item
                id="show-joined-only"
                textValue={m.chat_section_joined_channels_only()}
                selectionIndicator="none"
              >
                <Choice label={m.chat_section_joined_channels_only()} selected={showJoinedOnly} />
              </Dropdown.Item>
            )}
            <Dropdown.Item
              id="hide-empty"
              textValue={m.chat_section_hide_empty()}
              selectionIndicator="none"
            >
              <Choice label={m.chat_section_hide_empty()} selected={hideEmpty} />
            </Dropdown.Item>
          </Dropdown.Section>
          <Dropdown.Separator />
          {onEdit && (
            <Dropdown.Item
              id="edit"
              icon={Edit01}
              label={m.chat_section_edit()}
              selectionIndicator="none"
            />
          )}
          <Dropdown.Item
            id="create"
            icon={FolderPlus}
            label={m.chat_section_create()}
            selectionIndicator="none"
          />
          {onDelete && (
            <>
              <Dropdown.Separator />
              <Dropdown.Item
                id="delete"
                icon={Trash01}
                label={m.chat_section_delete()}
                selectionIndicator="none"
              />
            </>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function ChatSectionCreateMenu({
  onCreate,
  disabled,
}: {
  onCreate: () => void;
  disabled: boolean;
}) {
  return (
    <Dropdown.Root trigger="contextMenu">
      <Button
        color="tertiary"
        isDisabled={disabled}
        aria-label={m.chat_section_create()}
        data-chat-section-blank
        onPress={(event) => {
          if (event.pointerType === "keyboard") onCreate();
        }}
        className="min-h-24 w-full flex-1 cursor-default rounded-none hover:bg-transparent! disabled:cursor-default"
      >
        <span className="sr-only">{m.chat_section_create()}</span>
      </Button>
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu aria-label={m.chat_section_create()} onAction={onCreate}>
          <Dropdown.Item
            id="create"
            icon={Plus}
            label={m.chat_section_create()}
            selectionIndicator="none"
          />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
