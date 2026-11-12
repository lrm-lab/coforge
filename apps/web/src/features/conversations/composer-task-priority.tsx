import type { TaskPriorityLevel } from "@lrm/coforge-sdk/internal";

import { TaskPriorityMenu } from "#src/features/tasks/task-priority-menu";

/** An armed Task send's priority chip under the composer field (task #12): the last one picked
 * on this device until changed; it opens upward, over the stream. */
export function ComposerTaskPriority({
  priority,
  disabled,
  onSelect,
}: {
  priority: TaskPriorityLevel;
  disabled: boolean;
  onSelect: (priority: TaskPriorityLevel) => void;
}) {
  return (
    <div className="flex items-center px-1">
      <TaskPriorityMenu
        priority={priority}
        disabled={disabled}
        onSelect={onSelect}
        placement="top start"
      />
    </div>
  );
}
