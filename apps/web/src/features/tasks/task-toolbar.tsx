import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useMemo, type ReactNode } from "react";
import { Columns03, FilterLines, List } from "@untitledui/icons";
import { SubmenuTrigger, Tag, TagGroup, TagList } from "react-aria-components";

import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { ActorName } from "#src/features/avatars/actor-name";
import { messageSlots } from "#src/lib/message-slots";
import { TagCloseX } from "#src/components/base/tags/base-components/tag-close-x";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import {
  agentHandle,
  PickerMenu,
  projectOption,
  type PickerOption,
} from "#src/features/pickers/entity-picker";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import {
  NO_OWNER,
  NO_PROJECT,
  channelOptions,
  labelOptions,
  NO_LABEL,
  ownerOptions,
  projectOptions,
  type FilterableTask,
  type OwnerOption,
  type TaskFilter,
} from "./task-filters";
import { statusLabel, type TaskLayout } from "./task-workflow";

/** The status choices in the board's column order; read per render, so the language follows. */
const STATUS_OPTIONS = (): PickerOption[] =>
  TASK_STATUSES.map((value) => ({ id: value, label: statusLabel(value) }));

/**
 * A Task board's toolbar: "Filter" (owner, Project, labels and status, each a submenu where
 * several may be picked; owners, Projects and labels show how many Tasks each has) followed by
 * one removable chip per filter in use, and the board or list switch on
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
  project = false,
  tree = false,
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
  /** One Project's board: every Task shares its Project, so none is offered. */
  project?: boolean;
  /** A Project's task tree shows (task #462): its Tasks span conversations, so the channel picks
   * are offered; it lists no finished Task and no card, so Display offers only the layout. */
  tree?: boolean;
  /** The board's own button (a conversation's "Create task"), after the switch. */
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
  const channels = useMemo(
    () =>
      channelOptions(tasks).map((option): PickerOption => ({
        id: option.id,
        label: option.name,
        count: option.count,
      })),
    [tasks],
  );
  const pickedChannels = tree ? (filter.channels ?? []) : [];
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
    !project &&
      filter.projects.length > 0 && {
        id: "projects",
        label: m.tasks_filter_project_is({
          names: namesLabel(labelsOf(projects, filter.projects, m.tasks_overview_no_project())),
        }),
        remove: () => onFilterChange({ ...filter, projects: [] }),
      },
    pickedChannels.length > 0 && {
      id: "channels",
      label: m.tasks_filter_channel_is({
        names: namesLabel(labelsOf(channels, pickedChannels, m.tasks_filter_other())),
      }),
      remove: () => onFilterChange({ ...filter, channels: [] }),
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
    <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 px-4 py-1.5 md:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Dropdown.Root>
          {/* The two views of the board read alike, and Filter's icon starts on the page's edge. */}
          <Button size="sm" color="tertiary" iconLeading={FilterLines} className="-ml-3">
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
              {!project && (
                <FilterSubmenu
                  name={m.tasks_overview_project()}
                  options={projects}
                  picked={filter.projects}
                  onChange={(picked) => onFilterChange({ ...filter, projects: picked })}
                />
              )}
              {tree && (
                <FilterSubmenu
                  name={m.tasks_filter_channel()}
                  options={channels}
                  picked={pickedChannels}
                  onChange={(picked) => onFilterChange({ ...filter, channels: picked })}
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
        <LayoutSwitch layout={layout} onLayoutChange={onLayoutChange} />
        {action}
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

/** Board or list, in the bar itself (Frank, 11-06: not behind a menu). */
function LayoutSwitch({
  layout,
  onLayoutChange,
}: {
  layout: TaskLayout;
  onLayoutChange: (layout: TaskLayout) => void;
}) {
  // A phone's toolbar has no room for the words: Filter, the two views and New task side by side
  // need the icons alone, named for a screen reader.
  const words = useBreakpoint("sm");
  return (
    <ButtonGroup
      size="sm"
      aria-label={m.tasks_layout()}
      selectedKeys={[layout]}
      disallowEmptySelection
      onSelectionChange={(keys) => {
        const [key] = [...keys];
        if (key === "board" || key === "list") onLayoutChange(key);
      }}
    >
      <ButtonGroupItem id="board" iconLeading={Columns03} aria-label={m.tasks_layout_board()}>
        {words && m.tasks_layout_board()}
      </ButtonGroupItem>
      <ButtonGroupItem id="list" iconLeading={List} aria-label={m.tasks_layout_list()}>
        {words && m.tasks_layout_list()}
      </ButtonGroupItem>
    </ButtonGroup>
  );
}
