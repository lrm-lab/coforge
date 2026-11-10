import type { TaskView } from "@lrm/coforge-sdk/internal";
import { ArrowLeft, ChevronRight } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useChannelMembers } from "#src/features/conversations/channel-members";
import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { m } from "#src/paraglide/messages";
import type { VisibleTaskName } from "./task-relation-edits";
import { TaskStatusIcon } from "./task-status-icon";

/**
 * Where the Task sits, above its title: a back arrow to the popup it was opened from, if any; the
 * Task it is a step of, to go up to; then its conversation and number. A parent the reader cannot
 * see is named as such and opens nothing.
 */
export function TaskTrail({
  task,
  conversationName,
  onBack,
  onOpenRelated,
}: {
  task: TaskView;
  conversationName?: string;
  onBack?: () => void;
  onOpenRelated?: (task: VisibleTaskName) => void;
}) {
  const parent = task.parent;
  const openParent =
    parent && !parent.hidden && onOpenRelated ? () => onOpenRelated(parent) : undefined;
  // A channel reads its group avatar and its name, no `#` (Frank, 11-10, task #74); the number
  // after it is the Task's.
  const members = useChannelMembers({ id: task.conversationId });
  const place = conversationName?.replace(/^#/, "");
  return (
    <nav
      aria-label={m.tasks_trail()}
      className="flex min-w-0 flex-1 items-center gap-1 text-sm text-tertiary max-sm:justify-center"
    >
      {onBack ? (
        <ButtonUtility
          icon={ArrowLeft}
          size="sm"
          color="tertiary"
          tooltip={m.tasks_back()}
          onClick={onBack}
        />
      ) : (
        <span aria-hidden="true" className="w-1 max-sm:hidden" />
      )}
      {parent && (
        <>
          {openParent && !parent.hidden ? (
            <AriaButton
              onPress={openParent}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 outline-none hover:bg-primary_hover hover:text-secondary focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <TaskStatusIcon status={parent.status} className="size-3.5" />
              <span className="max-w-[24em] truncate">{parent.title}</span>
            </AriaButton>
          ) : (
            <span className="truncate px-1">{m.tasks_ref_hidden()}</span>
          )}
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
        </>
      )}
      <span className="flex min-w-0 shrink-0 items-center gap-1.5 px-1 max-sm:shrink">
        {members?.length ? <GroupAvatar members={members} className="avatar-group-xs" /> : null}
        {place && <span className="max-w-[16em] truncate">{place}</span>}
        <span className="shrink-0 tabular-nums">#{task.number}</span>
      </span>
    </nav>
  );
}
