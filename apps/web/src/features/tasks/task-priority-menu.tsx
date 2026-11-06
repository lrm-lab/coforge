import { TASK_PRIORITIES, type TaskPriority } from "@lrm/coforge-sdk/internal";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { TaskFieldTrigger } from "./task-field-trigger";
import { priorityLabel } from "./task-history-more";
import { TaskPriorityIcon } from "./task-priority-icon";

/** A priority by its mark and its name. "None" alone would not say of what, on a phone's chip. */
function PriorityText({ priority }: { priority: TaskPriority }) {
  if (priority === "none")
    return <span className="text-sm text-tertiary">{m.tasks_priority_unset()}</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-primary">
      <TaskPriorityIcon priority={priority} />
      {priorityLabel(priority)}
    </span>
  );
}

/** A Task's priority, in its popup and in the form that makes one, which opens the five to pick. */
export function TaskPriorityMenu({
  priority,
  disabled,
  onSelect,
}: {
  priority: TaskPriority;
  disabled: boolean;
  onSelect: (priority: TaskPriority) => void;
}) {
  const shown = priority === "none" ? m.tasks_priority_unset() : priorityLabel(priority);
  return (
    <Dropdown.Root>
      <TaskFieldTrigger label={`${m.tasks_change_priority()}: ${shown}`} disabled={disabled}>
        <PriorityText priority={priority} />
      </TaskFieldTrigger>
      <Dropdown.Popover placement="bottom start" className="w-44">
        <Dropdown.Menu
          aria-label={m.tasks_change_priority()}
          selectionMode="single"
          selectedKeys={[priority]}
          onAction={(key) => {
            const picked = TASK_PRIORITIES.find((each) => each === key);
            if (picked && picked !== priority) onSelect(picked);
          }}
        >
          {TASK_PRIORITIES.map((each) => (
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
