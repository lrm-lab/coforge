import { taskNameLabel, type TaskStatus, type TaskView } from "@lrm/coforge-sdk/internal";
import { useState, type ReactElement } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Input as AriaInput,
  Heading,
  SearchField as AriaSearchField,
} from "react-aria-components";
import { Plus, SearchLg } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { m } from "#src/paraglide/messages";

import { pickable, type PickerRules, type VisibleTaskName } from "./task-relation-edits";
import { TaskStatusIcon } from "./task-status-icon";
import { useTaskCandidates } from "./use-task-candidates";

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

type PickerProps = {
  task: Pick<TaskView, "conversationId">;
  rules: PickerRules;
  /** What the list is for, as a screen reader hears it. */
  label: string;
  onPick: (task: VisibleTaskName) => void;
  /** While an earlier change is still saving, nothing can be picked: the popup runs one at a time. */
  disabled?: boolean;
};

/**
 * Unfinished Tasks the reader can see, this conversation's first. Until something is typed it lists
 * only this conversation's; a search (by number, title, or a name such as `#design/31`) reaches
 * other channels too. What the rules leave out is not listed; a Task that would make the chain loop
 * back stays listed but cannot be picked, so its absence is not a mystery. It reads its Tasks when
 * it mounts, so it belongs inside a popover or dialog that renders only while open.
 */
function TaskPickerList({ task, rules, label, onPick, disabled }: PickerProps) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const candidates = pickable(useTaskCandidates(task), rules);
  const shown = search.trim()
    ? candidates
    : candidates.filter((candidate) => candidate.channel === null);
  return (
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
        aria-label={label}
        className="max-h-72"
        disabledKeys={disabled ? shown.map(taskNameLabel) : [...rules.loops]}
        onAction={(key) => {
          const picked = shown.find((candidate) => taskNameLabel(candidate) === key);
          if (picked) onPick(picked);
        }}
      >
        {shown.map((candidate) => {
          const name = taskNameLabel(candidate);
          return (
            <Dropdown.Item
              key={name}
              id={name}
              textValue={`${name} ${candidate.title}`}
              icon={STATUS_ICON[candidate.status]}
              label={`${name} ${candidate.title}`}
              addon={rules.loops.has(name) ? m.tasks_blocker_loop() : undefined}
            />
          );
        })}
      </Dropdown.Menu>
    </AriaAutocomplete>
  );
}

/** The picker under a button, for a list that already has a "+" to press (the blockers'). */
export function TaskPickerButton({
  children,
  disabled,
  ...picker
}: PickerProps & { children: string }) {
  return (
    <Dropdown.Root>
      <Button color="link-gray" size="sm" iconLeading={Plus} isDisabled={disabled}>
        {children}
      </Button>
      <Dropdown.Popover placement="bottom start" className="w-80">
        <TaskPickerList {...picker} disabled={disabled} />
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/** The picker as a dialog of its own, for what the header menu opens: nothing there to anchor a
 * popover to once the menu has closed. Picking closes it. */
export function TaskPickerDialog({
  open,
  onOpenChange,
  ...picker
}: PickerProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="max-h-[inherit]">
          {/* Opened from the menu, the dialog says what is being picked. */}
          <Heading slot="title" className="px-4 pt-4 pb-1 text-md font-semibold text-primary">
            {picker.label}
          </Heading>
          <TaskPickerList
            {...picker}
            onPick={(picked) => {
              onOpenChange(false);
              picker.onPick(picked);
            }}
          />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
