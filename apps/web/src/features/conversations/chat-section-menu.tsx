import { DotsHorizontal, Edit01, Plus, Trash01 } from "@untitledui/icons";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import type { ChatSection } from "./chat-section.schemas";

/** A visible button keeps the section actions available to touch and keyboard users. */
export function ChatSectionMenu({
  section,
  onCreate,
  onEdit,
  onDelete,
  disabled,
}: {
  section?: ChatSection;
  onCreate: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  disabled?: boolean;
}) {
  const label = m.chat_section_menu({ name: section?.name ?? m.navigation_chat() });
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
            if (key === "create") onCreate();
            if (key === "edit") onEdit?.();
            if (key === "delete") onDelete?.();
          }}
        >
          <Dropdown.Item
            id="create"
            icon={Plus}
            label={m.chat_section_create()}
            selectionIndicator="none"
          />
          {section && (
            <Dropdown.Item
              id="edit"
              icon={Edit01}
              label={m.chat_section_edit()}
              selectionIndicator="none"
            />
          )}
          {section && <Dropdown.Separator />}
          {section && (
            <Dropdown.Item
              id="delete"
              icon={Trash01}
              label={m.chat_section_delete()}
              selectionIndicator="none"
            />
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
