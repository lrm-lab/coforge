import { taskNameLabel } from "@lrm/coforge-sdk/internal";
import type { TaskLink, TaskView } from "@lrm/coforge-sdk/internal";
import type { ReactNode } from "react";
import { Dialog as AriaDialog, DialogTrigger, Button as AriaButton } from "react-aria-components";
import { CornerLeftUp, Dataflow02, Flag01, XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";

import { TaskLinkRow } from "./task-relations";
import { TaskStatusIcon } from "./task-status-icon";
import {
  canAddBlocker,
  canRemoveBlockers,
  openBlockers,
  type PickerRules,
  type VisibleTaskName,
} from "./task-relation-edits";
import { TaskPickerButton } from "./task-picker";

function InlineTask({ task }: { task: TaskLink }) {
  if (task.hidden) return <span className="min-w-0 truncate">{m.tasks_ref_hidden()}</span>;
  return (
    <>
      <TaskStatusIcon status={task.status} className="size-3.5" />
      <span className="min-w-0 truncate text-primary">{task.title}</span>
    </>
  );
}

const VALUE_BUTTON =
  "-mx-1.5 inline-flex h-7 max-w-[calc(100%+0.75rem)] min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-sm text-secondary outline-none hover:bg-primary_hover focus-visible:ring-2 focus-visible:ring-focus-ring pressed:bg-primary_hover";

const REVEAL_ON_ROW_HOVER =
  "shrink-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 any-pointer-coarse:opacity-100";

function FirstAndMore({ tasks }: { tasks: readonly TaskLink[] }) {
  const first = tasks.find((link) => !link.hidden) ?? tasks[0];
  if (!first) return null;
  return (
    <>
      <InlineTask task={first} />
      {tasks.length > 1 && (
        <span className="shrink-0">{m.tasks_and_more({ count: tasks.length - 1 })}</span>
      )}
    </>
  );
}

function ValuePopover({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogTrigger>
      <AriaButton className={VALUE_BUTTON}>{value}</AriaButton>
      <Dropdown.Popover placement="bottom start" className="w-[min(26rem,calc(100vw-1rem))]">
        <AriaDialog aria-label={label} className="flex flex-col gap-1 p-2 outline-hidden">
          <h3 className="px-1.5 pt-1 pb-0.5 text-xs font-medium text-tertiary">{label}</h3>
          {children}
        </AriaDialog>
      </Dropdown.Popover>
    </DialogTrigger>
  );
}

export function TaskParentValue({
  parent,
  disabled,
  onOpen,
  onClear,
}: {
  parent: TaskLink;
  disabled: boolean;
  onOpen?: (task: VisibleTaskName) => void;
  onClear?: () => void;
}) {
  return (
    <div className="group/row flex max-w-full min-w-0 items-center gap-2">
      {parent.hidden || !onOpen ? (
        <span className="flex h-7 min-w-0 items-center gap-1.5 overflow-hidden text-sm text-secondary">
          <InlineTask task={parent} />
        </span>
      ) : (
        <AriaButton onPress={() => onOpen(parent)} className={VALUE_BUTTON}>
          <InlineTask task={parent} />
        </AriaButton>
      )}
      {onClear && (
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          tooltip={m.tasks_clear_parent()}
          isDisabled={disabled}
          className={REVEAL_ON_ROW_HOVER}
          onClick={onClear}
        />
      )}
    </div>
  );
}

export function TaskBlockedByValue({
  task,
  blockedBy,
  rules,
  disabled,
  onOpen,
  onAdd,
  onRemove,
}: {
  task: Pick<TaskView, "conversationId">;
  blockedBy: readonly TaskLink[];
  rules: PickerRules;
  disabled: boolean;
  onOpen?: (task: VisibleTaskName) => void;
  onAdd: (task: VisibleTaskName) => void;
  onRemove: (task: VisibleTaskName) => void;
}) {
  const removable = canRemoveBlockers(blockedBy);
  return (
    <ValuePopover
      label={m.tasks_blocked_by()}
      value={<FirstAndMore tasks={openBlockers(blockedBy)} />}
    >
      <ul className="max-h-72 overflow-y-auto">
        {blockedBy.map((link, index) => (
          <TaskLinkRow
            key={link.hidden ? `hidden-${index}` : taskNameLabel(link)}
            task={link}
            onOpen={onOpen}
            trailing={
              !link.hidden &&
              removable && (
                <ButtonUtility
                  icon={XClose}
                  size="xs"
                  color="tertiary"
                  isDisabled={disabled}
                  aria-label={m.tasks_remove_blocker({ name: taskNameLabel(link) })}
                  className={REVEAL_ON_ROW_HOVER}
                  onClick={() => onRemove(link)}
                />
              )
            }
          />
        ))}
      </ul>
      {canAddBlocker(blockedBy) && (
        <div className="px-0.5">
          <TaskPickerButton
            task={task}
            rules={rules}
            label={m.tasks_pick_blocker()}
            disabled={disabled}
            onPick={onAdd}
          >
            {m.tasks_add_blocker()}
          </TaskPickerButton>
        </div>
      )}
    </ValuePopover>
  );
}

export function TaskBlockingValue({
  blocking,
  onOpen,
}: {
  blocking: readonly TaskLink[];
  onOpen?: (task: VisibleTaskName) => void;
}) {
  return (
    <ValuePopover label={m.tasks_blocking()} value={<FirstAndMore tasks={blocking} />}>
      <ul className="max-h-72 overflow-y-auto">
        {blocking.map((link, index) => (
          <TaskLinkRow
            key={link.hidden ? `hidden-${index}` : taskNameLabel(link)}
            task={link}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </ValuePopover>
  );
}

export function taskRelationMenuItems({
  canEdit,
  canAddBlocker: roomForBlocker,
  hasParent,
}: {
  canEdit: boolean;
  canAddBlocker: boolean;
  hasParent: boolean;
}) {
  return [
    <Dropdown.Item
      key="parent"
      id="parent"
      icon={CornerLeftUp}
      isDisabled={!canEdit}
      label={hasParent ? m.tasks_menu_change_parent() : m.tasks_menu_set_parent()}
    />,
    <Dropdown.Item
      key="blocker"
      id="blocker"
      icon={Flag01}
      isDisabled={!canEdit || !roomForBlocker}
      label={m.tasks_menu_add_blocker()}
    />,
    <Dropdown.Item
      key="subtask"
      id="subtask"
      icon={Dataflow02}
      isDisabled={!canEdit}
      label={m.tasks_menu_add_subtask()}
    />,
  ];
}
