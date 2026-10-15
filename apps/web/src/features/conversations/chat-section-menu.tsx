import type { ReactNode } from "react";
import { Check, Edit01, FolderPlus, Plus, Trash01 } from "@untitledui/icons";
import type { Selection } from "react-aria-components";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Button } from "#src/components/base/buttons/button";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import {
  chatSectionSortModes,
  type ChatSection,
  type ChatSectionSortMode,
} from "./chat-section.schemas";

function sortLabel(mode: ChatSectionSortMode): string {
  if (mode === "recent") return m.chat_section_sort_recent();
  if (mode === "alpha") return m.chat_section_sort_alpha();
  return m.chat_section_sort_manual();
}

/** A menu choice's own check, at the item's end as the design draws it (the Dropdown item puts
 * its built-in indicator before an icon-less label). */
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

const SECTION_HEADER_CLASS = "px-4 pt-1.5 pb-1 text-xs font-semibold text-tertiary uppercase";

function onlyKey(selection: Selection): string | undefined {
  if (selection === "all") return undefined;
  const [key] = selection;
  return key === undefined ? undefined : String(key);
}

/**
 * A custom section's menu: its title row is the trigger of a React Aria context menu
 * (`MenuTrigger trigger="contextMenu"`, as a conversation row's is), so it opens on right click,
 * long-press on touch and the platform's keyboard shortcut (Shift+F10 / the Menu key), at that
 * point; a left click still collapses the section. Sort is the section's own (saved with it);
 * Display is this device's "Hide empty sidebar sections" setting.
 */
export function ChatSectionMenu({
  section,
  hideEmpty,
  onSort,
  onHideEmptyChange,
  onEdit,
  onCreate,
  onDelete,
  children,
}: {
  section: ChatSection;
  hideEmpty: boolean;
  onSort: (mode: ChatSectionSortMode) => void;
  onHideEmptyChange: (hide: boolean) => void;
  onEdit: () => void;
  onCreate: () => void;
  onDelete: () => void;
  /** The section's title row, whose toggle must be a React Aria button: the trigger attaches to
   * the first pressable inside it. */
  children: ReactNode;
}) {
  const label = m.chat_section_menu({ name: section.name });
  return (
    <Dropdown.Root trigger="contextMenu">
      {children}
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu
          aria-label={label}
          onAction={(key) => {
            if (key === "edit") onEdit();
            if (key === "create") onCreate();
            if (key === "delete") onDelete();
          }}
        >
          <Dropdown.Section
            aria-label={m.chat_section_sort()}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[section.sortMode]}
            onSelectionChange={(selection) => {
              const mode = chatSectionSortModes.find((entry) => entry === onlyKey(selection));
              if (mode && mode !== section.sortMode) onSort(mode);
            }}
          >
            <Dropdown.SectionHeader className={SECTION_HEADER_CLASS}>
              {m.chat_section_sort()}
            </Dropdown.SectionHeader>
            {chatSectionSortModes.map((mode) => (
              <Dropdown.Item
                key={mode}
                id={mode}
                textValue={sortLabel(mode)}
                selectionIndicator="none"
              >
                <Choice label={sortLabel(mode)} selected={section.sortMode === mode} />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Dropdown.Separator />
          <Dropdown.Section
            aria-label={m.chat_section_display()}
            selectionMode="multiple"
            selectedKeys={hideEmpty ? ["hide-empty"] : []}
            onSelectionChange={(selection) =>
              onHideEmptyChange(selection === "all" || selection.has("hide-empty"))
            }
          >
            <Dropdown.SectionHeader className={SECTION_HEADER_CLASS}>
              {m.chat_section_display()}
            </Dropdown.SectionHeader>
            <Dropdown.Item
              id="hide-empty"
              textValue={m.chat_section_hide_empty()}
              selectionIndicator="none"
            >
              <Choice label={m.chat_section_hide_empty()} selected={hideEmpty} />
            </Dropdown.Item>
          </Dropdown.Section>
          <Dropdown.Separator />
          <Dropdown.Item
            id="edit"
            icon={Edit01}
            label={m.chat_section_edit()}
            selectionIndicator="none"
          />
          <Dropdown.Item
            id="create"
            icon={FolderPlus}
            label={m.chat_section_create()}
            selectionIndicator="none"
          />
          <Dropdown.Separator />
          <Dropdown.Item
            id="delete"
            icon={Trash01}
            label={m.chat_section_delete()}
            selectionIndicator="none"
          />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/** Creation belongs to the list's blank space, independent of any existing section. */
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
        className="min-h-24 w-full flex-1 rounded-none hover:bg-transparent!"
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
