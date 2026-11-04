import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import type { ReactElement } from "react";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";

import { TaskStatusIcon } from "./task-status-icon";

/** The menu's own icon class greys an icon; a status keeps its colour. One component per status,
 * so a row does not remount its icon on every keystroke. */
const statusIcon = (status: TaskStatus) => () => (
  <TaskStatusIcon status={status} className="mr-2.5" />
);
const STATUS_ICON: Record<TaskStatus, () => ReactElement> = {
  todo: statusIcon("todo"),
  in_progress: statusIcon("in_progress"),
  in_review: statusIcon("in_review"),
  done: statusIcon("done"),
  closed: statusIcon("closed"),
};

/**
 * One row of a Task picker (parent, blocker, existing sub-task). A row that cannot be picked is not
 * a disabled menu item, which React Aria leaves out of the arrow keys and so out of a screen
 * reader's reach (task #525): it stays in the keyboard's path, reads as greyed, and its accessible
 * name says why it cannot be picked. The picker ignores it when it is chosen.
 */
export function TaskPickerItem({
  name,
  title,
  status,
  refusal,
  note,
}: {
  /** The Task's name as the picker's conversation writes it (`#3`, `#design:#3`), its key. */
  name: string;
  title: string;
  status: TaskStatus;
  /** Why it cannot be picked, if it cannot. */
  refusal?: string;
  /** What else the row says on its right (the parent it would leave). */
  note?: string;
}) {
  const label = `${name} ${title}`;
  return (
    <Dropdown.Item
      id={name}
      textValue={label}
      icon={STATUS_ICON[status]}
      label={label}
      addon={refusal ?? note}
      aria-label={refusal ? m.tasks_pick_refused({ name: label, reason: refusal }) : undefined}
      data-refused={refusal ? "" : undefined}
      className={refusal ? "cursor-not-allowed opacity-50" : undefined}
    />
  );
}
