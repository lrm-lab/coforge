import { taskNameLabel, type TaskLink, type TaskView } from "@lrm/coforge-sdk/internal";
import { useMemo, useState } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Input as AriaInput,
  Heading,
  SearchField as AriaSearchField,
} from "react-aria-components";
import { SearchLg } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";

import { useCanSetAnyTaskStatus } from "./task-board-authority";
import {
  subtaskCandidates,
  type SubtaskCandidate,
  type VisibleTaskName,
} from "./task-relation-edits";
import { TaskPickerItem } from "./task-picker-item";
import { useUnfinishedTasks } from "./use-conversation-tasks";

/** Why a row cannot be picked, if it cannot. */
function refusalOf(candidate: SubtaskCandidate) {
  if (candidate.refusal === "above") return m.tasks_subtask_above();
  if (candidate.refusal === "denied") return m.tasks_subtask_denied();
  return undefined;
}

/** The parent a pickable row would leave. */
function noteOf(candidate: SubtaskCandidate) {
  if (candidate.from?.hidden) return m.tasks_subtask_under_hidden();
  if (candidate.from) return m.tasks_subtask_under({ name: taskNameLabel(candidate.from) });
  return undefined;
}

/** The move's question; a parent the viewer cannot name is not named. */
function moveBody(candidate: SubtaskCandidate, from: TaskLink, to: string) {
  const name = taskNameLabel(candidate);
  return from.hidden
    ? m.tasks_subtask_move_body_hidden({ name, to })
    : m.tasks_subtask_move_body({ name, from: taskNameLabel(from), to });
}

type Props = {
  task: Pick<TaskView, "conversationId" | "number" | "parent">;
  /** The viewer's member in the Task's conversation (null when unknown). */
  currentMemberId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** While an earlier change is still saving, nothing can be picked. */
  disabled?: boolean;
  onPick: (task: VisibleTaskName) => void;
};

/**
 * "Add existing sub-task" (task #505, after Linear's "Add existing sub-issue"): a search over the
 * conversation's unfinished Tasks, by number or title. The Task itself and its sub-tasks are left
 * out; the Tasks above it, and those the viewer may not move, are listed greyed with the reason. A
 * Task that already has a parent is moved only after the dialog says from where.
 */
export function SubtaskPickerDialog({
  task,
  currentMemberId,
  open,
  onOpenChange,
  disabled,
  onPick,
}: Props) {
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="max-h-[inherit]">
          {open && (
            <SubtaskPicker
              task={task}
              currentMemberId={currentMemberId}
              disabled={disabled}
              onCancel={() => onOpenChange(false)}
              onPick={(picked) => {
                onOpenChange(false);
                onPick(picked);
              }}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The list, then, for a Task under another parent, the question whether to move it. */
function SubtaskPicker({
  task,
  currentMemberId,
  disabled,
  onCancel,
  onPick,
}: Omit<Props, "open" | "onOpenChange"> & { onCancel: () => void }) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const [moving, setMoving] = useState<SubtaskCandidate | null>(null);
  const manager = useCanSetAnyTaskStatus();
  const { tasks: rows, loading } = useUnfinishedTasks(task.conversationId);
  const candidates = useMemo(
    () => subtaskCandidates(task, rows, { memberId: currentMemberId, manager }),
    [task, rows, currentMemberId, manager],
  );
  const here = taskNameLabel({ hidden: false, number: task.number, channel: null });

  if (moving?.from) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Heading slot="title" className="text-md font-semibold text-primary">
          {m.tasks_subtask_move_title({ name: taskNameLabel(moving) })}
        </Heading>
        <p className="text-sm text-tertiary">{moveBody(moving, moving.from, here)}</p>
        <DialogActions className="mt-2">
          <DialogCancel type="button" onPress={() => setMoving(null)}>
            {m.tasks_create_cancel()}
          </DialogCancel>
          <DialogAction type="button" isDisabled={disabled} onPress={() => onPick(moving)}>
            {m.tasks_subtask_move_confirm()}
          </DialogAction>
        </DialogActions>
      </div>
    );
  }

  return (
    <>
      <Heading slot="title" className="px-4 pt-4 pb-1 text-md font-semibold text-primary">
        {m.tasks_pick_subtask()}
      </Heading>
      <AriaAutocomplete filter={contains} inputValue={search} onInputChange={setSearch}>
        <div className="border-b border-secondary py-1">
          <AriaSearchField
            aria-label={m.tasks_search_tasks()}
            value={search}
            onChange={setSearch}
            autoFocus
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
              <AriaInput
                placeholder={m.tasks_search_tasks()}
                className="w-full bg-transparent text-sm text-primary outline-hidden placeholder:text-placeholder"
              />
            </div>
          </AriaSearchField>
        </div>
        <Dropdown.Menu
          aria-label={m.tasks_pick_subtask()}
          className="max-h-72"
          // Only a change still saving disables the rows; a refused one stays reachable and says
          // why (TaskPickerItem), and choosing it does nothing.
          disabledKeys={disabled ? candidates.map(taskNameLabel) : []}
          onAction={(key) => {
            const picked = candidates.find((candidate) => taskNameLabel(candidate) === key);
            if (!picked || picked.refusal !== null) return;
            if (picked.from) setMoving(picked);
            else onPick(picked);
          }}
          // Still reading, a search that matches nothing, and a conversation with nothing to offer
          // each say so differently.
          renderEmptyState={() => (
            <p className="px-3 py-2 text-sm text-tertiary">
              {loading
                ? m.tasks_subtask_loading()
                : search.trim()
                  ? m.tasks_subtask_no_match()
                  : m.tasks_subtask_none()}
            </p>
          )}
        >
          {candidates.map((candidate) => {
            const name = taskNameLabel(candidate);
            return (
              <TaskPickerItem
                key={name}
                name={name}
                title={candidate.title}
                status={candidate.status}
                refusal={refusalOf(candidate)}
                note={noteOf(candidate)}
              />
            );
          })}
        </Dropdown.Menu>
      </AriaAutocomplete>
      <div className="flex justify-end px-4 py-3">
        <DialogCancel type="button" onPress={onCancel}>
          {m.tasks_create_cancel()}
        </DialogCancel>
      </div>
    </>
  );
}
