import {
  TASK_PRIORITY_LEVELS,
  type TaskPriority,
  type TaskPriorityLevel,
} from "@lrm/coforge-sdk/internal";
import { BarChart07 } from "@untitledui/icons";
import type { ComponentProps } from "react";
import { UnsetValue } from "./task-property";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { TaskFieldTrigger } from "./task-field-trigger";
import { priorityLabel } from "./task-history-more";
import { TaskPriorityIcon } from "./task-priority-icon";

/** A priority by its mark and its name. "None" alone would not say of what, on a phone's chip. */
function PriorityText({ priority }: { priority: TaskPriority | undefined }) {
  if (priority === undefined || priority === "none")
    return (
      <UnsetValue icon={BarChart07} text={m.tasks_priority_unset()} field={m.tasks_priority()} />
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-primary">
      <TaskPriorityIcon priority={priority} />
      {priorityLabel(priority)}
    </span>
  );
}

/**
 * A Task's priority, in its popup and in the forms that make one. A priority is only ever set to
 * one of the four levels (task #12): `none` is the stored level of a Task nobody prioritized, so
 * it shows as unset and is never a choice — there is no way back to it.
 */
export function TaskPriorityMenu({
  priority,
  disabled,
  onSelect,
  placement = "bottom start",
}: {
  priority?: TaskPriority;
  disabled: boolean;
  onSelect: (priority: TaskPriorityLevel) => void;
  placement?: ComponentProps<typeof Dropdown.Popover>["placement"];
}) {
  const shown =
    priority === undefined || priority === "none"
      ? m.tasks_priority_unset()
      : priorityLabel(priority);
  const selected = priority !== undefined && priority !== "none" ? [priority] : [];
  return (
    <Dropdown.Root>
      <TaskFieldTrigger label={`${m.tasks_change_priority()}: ${shown}`} disabled={disabled}>
        <PriorityText priority={priority} />
      </TaskFieldTrigger>
      <Dropdown.Popover placement={placement} className="w-44">
        <Dropdown.Menu
          aria-label={m.tasks_change_priority()}
          selectionMode="single"
          selectedKeys={selected}
          onAction={(key) => {
            const picked = TASK_PRIORITY_LEVELS.find((each) => each === key);
            if (picked && picked !== priority) onSelect(picked);
          }}
        >
          {TASK_PRIORITY_LEVELS.map((each) => (
            <Dropdown.Item key={each} id={each} textValue={priorityLabel(each)}>
              <span className="flex items-center gap-2">
                <span className="flex size-4 shrink-0">
                  <TaskPriorityIcon priority={each} />
                </span>
                {priorityLabel(each)}
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
