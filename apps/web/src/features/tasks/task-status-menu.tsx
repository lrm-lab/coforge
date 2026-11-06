import type { TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { TaskStatusIcon } from "./task-status-icon";
import { TaskFieldTrigger as EditableTrigger } from "./task-field-trigger";
import { taskStatusOptions } from "./task-move";
import { statusLabel } from "./task-workflow";

/** The popup's status: a badge, which opens the moves the viewer may make when there are any. */
export function StatusMenu({
  task,
  currentMemberId,
  disabled,
  onSelect,
}: {
  task: TaskView;
  currentMemberId: string | null;
  disabled: boolean;
  onSelect: (status: TaskStatus) => void;
}) {
  const options = taskStatusOptions(task, currentMemberId);
  if (options.length === 1) return <StatusText status={task.status} />;
  return (
    <StatusPicker
      status={task.status}
      options={options}
      disabled={disabled}
      onSelect={onSelect}
      itemLabel={(status) =>
        task.status === "closed" && status === "todo"
          ? m.tasks_reopen_to_todo()
          : statusLabel(status)
      }
    />
  );
}

/** A status that opens the given ones to pick, in the popup and in the board's New task form. */
export function StatusPicker({
  status: current,
  options,
  disabled,
  onSelect,
  itemLabel = statusLabel,
}: {
  status: TaskStatus;
  options: readonly TaskStatus[];
  disabled: boolean;
  onSelect: (status: TaskStatus) => void;
  itemLabel?: (status: TaskStatus) => string;
}) {
  return (
    <Dropdown.Root>
      <EditableTrigger
        label={`${m.tasks_change_status()}: ${statusLabel(current)}`}
        disabled={disabled}
      >
        <StatusText status={current} />
      </EditableTrigger>
      <Dropdown.Popover placement="bottom start" className="w-52">
        <Dropdown.Menu
          aria-label={m.tasks_change_status()}
          selectionMode="single"
          selectedKeys={[current]}
          onAction={(key) => {
            const status = options.find((option) => option === key);
            if (status && status !== current) onSelect(status);
          }}
        >
          {options.map((status) => (
            <Dropdown.Item key={status} id={status} label={itemLabel(status)} />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/** A status as its ring and its name: the ring carries the colour, the name reads as text. */
function StatusText({ status }: { status: TaskStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-primary">
      <TaskStatusIcon status={status} />
      {statusLabel(status)}
    </span>
  );
}
