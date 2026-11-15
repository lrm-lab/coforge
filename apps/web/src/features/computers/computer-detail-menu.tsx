import { useState } from "react";
import { DotsHorizontal, Eraser, LogOut01, Trash01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";

/**
 * The header's "more" menu: the rare actions that change or end the Computer. They stay out of the
 * page body so nothing red sits under the content; each opens a confirmation that says what it does.
 * Format disk has its own typed-name dialog, which the detail page owns.
 */
export function ComputerDetailMenu({
  name,
  onFormat,
  onRemove,
  onDelete,
}: {
  name: string;
  onFormat?: () => void;
  onRemove?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<"remove" | "delete" | null>(null);
  // Someone who does not own the Computer has none of these, and no menu.
  if (!onFormat && !onRemove && !onDelete) return null;
  return (
    <>
      <Dropdown.Root>
        <ButtonUtility
          icon={DotsHorizontal}
          size="sm"
          color="tertiary"
          className="shrink-0"
          tooltip={m.computer_more_actions()}
        />
        {/* As wide as its longest label ("Remove from this Workspace"), never past the screen. */}
        <Dropdown.Popover placement="bottom end" className="w-max max-w-[calc(100vw-1rem)]">
          <Dropdown.Menu
            aria-label={m.computer_more_actions()}
            onAction={(key) => {
              if (key === "format") onFormat?.();
              else if (key === "remove" || key === "delete") setConfirming(key);
            }}
          >
            {onFormat && (
              <Dropdown.Item id="format" icon={Eraser} label={m.computer_format_action()} />
            )}
            {/* Wiping the disk first, then leaving this Workspace, then deleting the Computer
                everywhere: least to most final. */}
            {onFormat && (onRemove || onDelete) && <Dropdown.Separator />}
            {onRemove && (
              <Dropdown.Item id="remove" icon={LogOut01} label={m.computer_remove_action()} />
            )}
            {onDelete && (
              <Dropdown.Item id="delete" icon={Trash01} label={m.computer_delete_action()} />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      {onRemove && (
        <ConfirmDialog
          open={confirming === "remove"}
          onOpenChange={(open) => setConfirming(open ? "remove" : null)}
          // It can be linked again, so it asks with the primary button, not the red one.
          tone="default"
          title={m.computer_remove_dialog_title({ name })}
          description={m.computer_remove_description()}
          confirmLabel={m.computer_remove_confirm_action()}
          errorMessage={m.computer_remove_error()}
          onConfirm={onRemove}
        />
      )}
      {onDelete && (
        <ConfirmDialog
          open={confirming === "delete"}
          onOpenChange={(open) => setConfirming(open ? "delete" : null)}
          title={m.computer_delete_dialog_title({ name })}
          description={m.computer_delete_description()}
          confirmLabel={m.computer_delete_action()}
          errorMessage={m.computer_delete_error()}
          onConfirm={onDelete}
        />
      )}
    </>
  );
}
