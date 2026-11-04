import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useMemo, type ReactNode } from "react";
import { Columns03, FilterLines, List, Sliders04 } from "@untitledui/icons";
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Radio,
  RadioGroup,
  SubmenuTrigger,
  Tag,
  TagGroup,
  TagList,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Toggle } from "#src/components/base/toggle/toggle";
import { cn } from "#src/lib/utils";
import { ActorName } from "#src/features/avatars/actor-name";
import { messageSlots } from "#src/lib/message-slots";
import { TagCloseX } from "#src/components/base/tags/base-components/tag-close-x";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Select } from "#src/components/base/select/select";
import {
  agentHandle,
  PickerMenu,
  projectOption,
  type PickerOption,
} from "#src/features/pickers/entity-picker";
import { m } from "#src/paraglide/messages";
import {
  TASK_DISPLAY_FIELDS,
  useTaskDisplayFields,
  type TaskDisplayField,
} from "#src/features/settings/task-display-fields";
import {
  NO_OWNER,
  NO_PROJECT,
  labelOptions,
  NO_LABEL,
  ownerOptions,
  projectOptions,
  type FilterableTask,
  type OwnerOption,
  type TaskFilter,
} from "./task-filters";
import { statusLabel, type TaskLayout } from "./task-workflow";
import type { FinishedWindow } from "./finished-tasks";

/** The status choices in the board's column order; read per render, so the language follows. */
const STATUS_OPTIONS = (): PickerOption[] =>
  TASK_STATUSES.map((value) => ({ id: value, label: statusLabel(value) }));

/**
 * A Task board's toolbar: "Filter" (owner, Project, labels and status, each a submenu where
 * several may be picked; owners, Projects and labels show how many Tasks each has) followed by
 * one removable chip per filter in use, and "Display" on
 * the right (board or list, and which parts of a Task show).
 */
export function TaskToolbar({
  tasks,
  filter,
  statuses,
  layout,
  onFilterChange,
  onStatusesChange,
  onLayoutChange,
  completedWindow,
  onWindowChange,
  conversation = false,
  project = false,
  action,
}: {
  tasks: readonly FilterableTask[];
  filter: TaskFilter;
  /** The statuses shown; none picked shows every status. */
  statuses: readonly TaskStatus[];
  layout: TaskLayout;
  onFilterChange: (filter: TaskFilter) => void;
  onStatusesChange: (statuses: readonly TaskStatus[]) => void;
  onLayoutChange: (layout: TaskLayout) => void;
  /** How far back Done and Closed reach; Display offers it, as Linear's completed issues do. */
  completedWindow: FinishedWindow;
  onWindowChange: (completedWindow: FinishedWindow) => void;
  /** One conversation's board: every Task shares its source and Project, so neither is offered. */
  conversation?: boolean;
  /** One Project's board: every Task shares its Project, so none is offered. */
  project?: boolean;
  /** The board's own button (a conversation's "Create task"), before Display. */
  action?: ReactNode;
}) {
  // Counted over every Task, so the numbers hold still while picking.
  const owners = useMemo(
    () =>
      ownerOptions(tasks).map((option): PickerOption => ({
        id: option.id,
        label: ownerLabel(option),
        face:
          option.kind === "none"
            ? undefined
            : {
                kind: "identity",
                name: option.name,
                src: option.avatarUrl,
                // The ids give an Agent its mascot and a person their status dot (task #521).
                ...(option.kind === "agent" ? { agentId: option.id } : { userId: option.id }),
              },
        ...(option.handle !== undefined && agentHandle(option.handle)),
        count: option.count,
      })),
    [tasks],
  );
  const projects = useMemo(
    () =>
      projectOptions(tasks).map((option): PickerOption => ({
        ...(option.id === NO_PROJECT
          ? { id: option.id, label: m.tasks_overview_no_project() }
          : projectOption(option)),
        count: option.count,
      })),
    [tasks],
  );
  const labels = useMemo(
    () =>
      labelOptions(tasks).map((option): PickerOption => ({
        id: option.id,
        label: option.id === NO_LABEL ? m.tasks_labels_none() : option.name,
        count: option.count,
      })),
    [tasks],
  );
  // A pick no listed Task has (a saved link, an older finished Task's owner) has no name here.
  const labelsOf = (options: readonly PickerOption[], picked: readonly string[], none: string) =>
    picked.map(
      (id) =>
        options.find((option) => option.id === id)?.label ??
        (id === NO_OWNER || id === NO_PROJECT || id === NO_LABEL ? none : m.tasks_filter_other()),
    );
  const candidates: (Chip | false | undefined)[] = [
    filter.owners.length > 0 && {
      id: "owners",
      label: m.tasks_filter_owner_is({
        names: namesLabel(labelsOf(owners, filter.owners, m.tasks_unassigned())),
      }),
      content: ownersChip(
        owners,
        filter.owners,
        labelsOf(owners, filter.owners, m.tasks_unassigned()),
      ),
      remove: () => onFilterChange({ ...filter, owners: [] }),
    },
    !conversation &&
      !project &&
      filter.projects.length > 0 && {
        id: "projects",
        label: m.tasks_filter_project_is({
          names: namesLabel(labelsOf(projects, filter.projects, m.tasks_overview_no_project())),
        }),
        remove: () => onFilterChange({ ...filter, projects: [] }),
      },
    filter.labels.length > 0 && {
      id: "labels",
      label: m.tasks_filter_labels_are({
        names: namesLabel(labelsOf(labels, filter.labels, m.tasks_labels_none())),
      }),
      remove: () => onFilterChange({ ...filter, labels: [] }),
    },
    statuses.length > 0 && {
      id: "status",
      label: m.tasks_filter_status_is({ name: namesLabel(statuses.map(statusLabel)) }),
      remove: () => onStatusesChange([]),
    },
  ];
  const chips = candidates.filter((chip) => chip !== false && chip !== undefined);

  return (
    <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-secondary px-4 py-1.5 md:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Dropdown.Root>
          <Button size="sm" color="tertiary" iconLeading={FilterLines}>
            {m.tasks_filter()}
          </Button>
          <Dropdown.Popover placement="bottom start" className="w-52">
            <Dropdown.Menu aria-label={m.tasks_filter()}>
              <FilterSubmenu
                name={m.tasks_overview_owner()}
                options={owners}
                picked={filter.owners}
                onChange={(picked) => onFilterChange({ ...filter, owners: picked })}
              />
              {!conversation && !project && (
                <FilterSubmenu
                  name={m.tasks_overview_project()}
                  options={projects}
                  picked={filter.projects}
                  onChange={(picked) => onFilterChange({ ...filter, projects: picked })}
                />
              )}
              <FilterSubmenu
                name={m.tasks_labels()}
                options={labels}
                picked={filter.labels}
                // "No label" stands alone: it cannot be had together with a label.
                onChange={(picked) => {
                  const fresh = picked.filter((id) => !filter.labels.includes(id));
                  onFilterChange({
                    ...filter,
                    labels: fresh.includes(NO_LABEL)
                      ? [NO_LABEL]
                      : picked.filter((id) => id !== NO_LABEL),
                  });
                }}
              />
              {/* Several statuses at once, picked like owners and labels (task #506). */}
              <FilterSubmenu
                name={m.tasks_overview_status()}
                options={STATUS_OPTIONS()}
                picked={statuses}
                onChange={(picked) =>
                  onStatusesChange(TASK_STATUSES.filter((value) => picked.includes(value)))
                }
              />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
        {
          // Removing one moves focus to its neighbour, or to the group once none is left, so the
          // group stays mounted (React Aria TagGroup).
          <TagGroup
            aria-label={m.tasks_filters_in_use()}
            onRemove={(keys) => {
              for (const chip of chips) if (keys.has(chip.id)) chip.remove();
            }}
          >
            <TagList className="flex flex-wrap items-center gap-2">
              {chips.map((chip) => (
                <Tag
                  key={chip.id}
                  id={chip.id}
                  textValue={chip.label}
                  className="inline-flex h-7 max-w-[20rem] cursor-default items-center gap-1 rounded-md border border-secondary pr-1.5 pl-2.5 text-xs text-secondary outline-focus-ring focus-visible:outline-2"
                >
                  <span className="truncate">{chip.content ?? chip.label}</span>
                  {/* React Aria names it "<this label> <the chip>". */}
                  <TagCloseX size="md" aria-label={m.tasks_filter_remove()} />
                </Tag>
              ))}
            </TagList>
          </TagGroup>
        }
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        <DisplayMenu
          layout={layout}
          onLayoutChange={onLayoutChange}
          completedWindow={completedWindow}
          onWindowChange={onWindowChange}
          fields={
            conversation ? CONVERSATION_FIELDS : project ? PROJECT_FIELDS : TASK_DISPLAY_FIELDS
          }
        />
      </div>
    </div>
  );
}

function ownerLabel(option: OwnerOption) {
  if (option.kind === "me") return m.tasks_overview_me();
  if (option.kind === "none") return m.tasks_unassigned();
  return option.name;
}

/** Up to two names, then how many more. */
function namesLabel(names: readonly string[]) {
  return names.length <= 2
    ? names.join(", ")
    : m.tasks_filter_names_more({ names: names.slice(0, 2).join(", "), count: names.length - 2 });
}

type Chip = { id: string; label: string; content?: ReactNode; remove: () => void };

/** The owner chip with a face before each name shown (task #521); the others stay text. */
function ownersChip(
  options: readonly PickerOption[],
  picked: readonly string[],
  labels: readonly string[],
) {
  const names = picked.slice(0, 2).map((id, index) => {
    const face = options.find((option) => option.id === id)?.face;
    if (face?.kind !== "identity") return labels[index];
    return (
      <ActorName
        key={id}
        actor={{
          kind: face.agentId ? "agent" : "user",
          id: face.agentId ?? face.userId,
          name: face.name,
          avatarUrl: face.src,
        }}
      />
    );
  });
  const joined = names.flatMap((name, index) => (index ? [", ", name] : [name]));
  return messageSlots(m.tasks_filter_owner_is, {
    names:
      picked.length <= 2
        ? joined
        : messageSlots(m.tasks_filter_names_more, {
            names: joined,
            count: String(picked.length - 2),
          }),
  });
}

function FilterSubmenu({
  name,
  options,
  picked,
  onChange,
}: {
  name: string;
  options: readonly PickerOption[];
  picked: readonly string[];
  onChange: (picked: string[]) => void;
}) {
  return (
    <SubmenuTrigger>
      <Dropdown.Item label={name} />
      <Dropdown.SubmenuPopover className="w-64">
        <PickerMenu
          label={name}
          options={options}
          selectedKeys={picked}
          onSelectedKeysChange={onChange}
        />
      </Dropdown.SubmenuPopover>
    </SubmenuTrigger>
  );
}

/** A conversation's board has no source or Project to show. */
const CONVERSATION_FIELDS: readonly TaskDisplayField[] = ["number", "owner"];

/** A Project's board has no Project to show. */
const PROJECT_FIELDS: readonly TaskDisplayField[] = ["number", "source", "owner"];

const FIELD_LABEL: Record<TaskDisplayField, () => string> = {
  number: () => m.tasks_field_number(),
  source: () => m.tasks_field_source(),
  project: () => m.tasks_overview_project(),
  owner: () => m.tasks_overview_owner(),
};

function DisplayMenu({
  layout,
  onLayoutChange,
  completedWindow,
  onWindowChange,
  fields: shownFields,
}: {
  layout: TaskLayout;
  onLayoutChange: (layout: TaskLayout) => void;
  completedWindow: FinishedWindow;
  onWindowChange: (completedWindow: FinishedWindow) => void;
  fields: readonly TaskDisplayField[];
}) {
  const [fields, setFields] = useTaskDisplayFields();
  return (
    <DialogTrigger>
      <Button size="sm" color="secondary" iconLeading={Sliders04}>
        {m.tasks_display()}
      </Button>
      <Dropdown.Popover placement="bottom end" className="w-72">
        <AriaDialog
          aria-label={m.tasks_display()}
          className="flex flex-col gap-3 p-3 outline-hidden"
        >
          {/* Board or list as two tiles, the chosen one filled, as Linear's Display does. */}
          <RadioGroup
            aria-label={m.tasks_layout()}
            value={layout}
            onChange={(value) => {
              if (value === "board" || value === "list") onLayoutChange(value);
            }}
            className="grid grid-cols-2 gap-2"
          >
            {(
              [
                ["board", Columns03, m.tasks_layout_board()],
                ["list", List, m.tasks_layout_list()],
              ] as const
            ).map(([value, Icon, label]) => (
              <Radio
                key={value}
                value={value}
                className={({ isSelected, isFocusVisible, isHovered }) =>
                  cn(
                    "flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border text-sm font-medium outline-focus-ring transition-colors",
                    isSelected
                      ? "border-brand bg-brand-primary text-brand-secondary"
                      : cn("border-secondary text-tertiary", isHovered && "bg-primary_hover"),
                    isFocusVisible && "outline-2 outline-offset-2",
                  )
                }
              >
                <Icon aria-hidden="true" className="size-5" />
                {label}
              </Radio>
            ))}
          </RadioGroup>
          <div className="flex items-center justify-between gap-3 border-t border-secondary pt-3">
            <span className="text-sm text-secondary">{m.tasks_finished_window()}</span>
            <Select
              aria-label={m.tasks_finished_window()}
              size="sm"
              className="w-32"
              selectedKey={completedWindow}
              onSelectionChange={(key) => {
                if (key === "week" || key === "month" || key === "all") onWindowChange(key);
              }}
            >
              <Select.Item id="week" label={m.tasks_finished_week()} />
              <Select.Item id="month" label={m.tasks_finished_month()} />
              <Select.Item id="all" label={m.tasks_finished_all()} />
            </Select>
          </div>
          {/* One switch per field: on or off at a glance. */}
          <div className="flex flex-col gap-2.5 border-t border-secondary pt-3">
            <p className="text-xs font-medium text-tertiary">{m.tasks_display_fields()}</p>
            {shownFields.map((field) => (
              <Toggle
                key={field}
                size="sm"
                label={FIELD_LABEL[field]()}
                isSelected={fields[field]}
                onChange={(shown) => setFields({ ...fields, [field]: shown })}
              />
            ))}
          </div>
        </AriaDialog>
      </Dropdown.Popover>
    </DialogTrigger>
  );
}
