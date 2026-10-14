import { DotsHorizontal, Edit01, Plus, Trash01 } from "@untitledui/icons";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import type { ChatSection } from "./chat-section.schemas";

/** A visible button keeps the section actions available to touch and keyboard users. */
export function ChatSectionMenu({
  section,
  onEdit,
  onDelete,
  disabled,
}: {
  section: ChatSection;
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const label = m.chat_section_menu({ name: section.name });
  return (
    <Dropdown.Root>
      <ButtonUtility
        icon={DotsHorizontal}
        size="xs"
        color="tertiary"
        tooltip={label}
        aria-label={label}
        isDisabled={disabled}
        className="shrink-0 hover:bg-transparent!"
      />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          onAction={(key) => {
            if (key === "edit") onEdit();
            if (key === "delete") onDelete();
          }}
        >
          <Dropdown.Item
            id="edit"
            icon={Edit01}
            label={m.chat_section_edit()}
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
