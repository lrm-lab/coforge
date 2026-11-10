import { Check, CheckDone01, DotsHorizontal } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";

/**
 * The Activity header's one quiet "⋯": Linear keeps "mark everything" out of the header (Frank,
 * 11-09), so the bulk actions live here, offered only while they have something to do. Renders
 * nothing when neither applies.
 */
export function ActivityInboxMoreActions({
  unreadCount,
  onReadAll,
  onDoneAll,
}: {
  unreadCount: number;
  onReadAll: () => void;
  /** Set only when "mark all done" applies to the list on screen. */
  onDoneAll?: () => void;
}) {
  if (unreadCount === 0 && !onDoneAll) return null;
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
          {unreadCount > 0 && (
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
