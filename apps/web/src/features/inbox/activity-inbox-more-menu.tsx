import { Check, CheckDone01, DotsHorizontal } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";

/**
 * Activity's quiet "⋯" in the header (Linear keeps "mark everything" out of it, Frank 11-09): each
 * action shows only when the caller passes it, that is, while it has something to do.
 */
export function ActivityInboxMoreMenu({
  onReadAll,
  onDoneAll,
}: {
  onReadAll?: () => void;
  onDoneAll?: () => void;
}) {
  return (
    <Dropdown.Root>
      <ButtonUtility
        size="sm"
        color="tertiary"
        icon={DotsHorizontal}
        tooltip={m.activity_inbox_more_actions()}
      />
      <Dropdown.Popover placement="bottom end" className="w-48">
        <Dropdown.Menu aria-label={m.activity_inbox_more_actions()}>
          {onReadAll && (
            <Dropdown.Item
              id="read-all"
              icon={CheckDone01}
              label={m.activity_inbox_mark_all_read()}
              onAction={onReadAll}
            />
          )}
          {onDoneAll && (
            <Dropdown.Item
              id="done-all"
              icon={Check}
              label={m.activity_bulk_mark_all_done()}
              onAction={onDoneAll}
            />
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
