import type { TaskLabel, TaskView } from "@lrm/coforge-sdk/internal";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "@untitledui/icons";
import { useState } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Input as AriaInput,
  SearchField as AriaSearchField,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { LabelColorSwatches } from "./label-color-swatches";
import { newLabelColor } from "./label-colors";
import { createTaskLabel } from "./labels.functions";
import { LabelDot, ManageableLabelChip, TaskLabelChip } from "./task-label-chip";
import { TaskFieldTrigger } from "./task-field-trigger";
import { useCloseOnBack } from "./use-close-on-back";
import { useWorkspaceLabels, workspaceLabelsKey } from "./workspace-labels";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";

/** A Task carries at most this many labels (the server refuses a sixth). */
export const TASK_LABELS_MAX = 5;
/** How many labels a card shows before the rest fold into `+N`. */
const CARD_LABELS = 2;

/**
 * A card's labels: the first two, then `+N` for the rest, whose names are its tooltip. Nothing
 * when the Task has none.
 */
export function TaskCardLabels({ labels }: { labels: readonly TaskLabel[] | undefined }) {
  if (!labels?.length) return null;
  const shown = labels.slice(0, CARD_LABELS);
  const rest = labels.slice(CARD_LABELS);
  return (
    // One line: where two and +N do not fit, the names are cut before the row wraps; +N stays
    // whole (task #455).
    <span className="flex min-w-0 items-center gap-1">
      {shown.map((label) => (
        <TaskLabelChip key={label.id} label={label} className="min-w-0 shrink" />
      ))}
      {rest.length > 0 && (
        <Tooltip title={rest.map((label) => label.name).join(", ")}>
          <TooltipTrigger className="h-auto w-auto shrink-0 rounded-md outline-focus-ring focus-visible:outline-2">
            <span className="inline-flex h-5.5 items-center rounded-md border border-secondary px-1.5 text-xs font-medium text-secondary">
              +{rest.length}
            </span>
          </TooltipTrigger>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * The popup's labels: the Task's chips, then a control that opens the Workspace's labels to tick
 * on and off. A Task holds five at most; at five the rest cannot be picked. A name no label has is
 * created on the spot, with a color of its own (task #455, the simple version Frank asked for).
 */
export function TaskLabelsField({
  task,
  disabled,
  onChange,
}: {
  task: Pick<TaskView, "labels">;
  disabled: boolean;
  /** Labels to add and to take off, by name. */
  onChange: (change: { add?: string[]; remove?: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const desktop = useBreakpoint("md");
  useCloseOnBack(open && !desktop, () => setOpen(false));
  // The Workspace's labels are read while the picker is open and whenever the Task has a label: a
  // chip's menu needs to know whether the viewer manages labels, and follows a recolor.
  const taskLabels = task.labels ?? [];
  const {
    labels: workspaceLabels,
    workspaceId,
    canManage,
    loaded: labelsLoaded,
  } = useWorkspaceLabels(open || taskLabels.length > 0);
  // A label deleted (archived) since the Task was read is off it already.
  const archivedIds = new Set(
    workspaceLabels.filter((label) => label.archivedAt).map((label) => label.id),
  );
  const labels = taskLabels.filter((label) => !archivedIds.has(label.id));
  const queryClient = useQueryClient();
  const workspaceSlug = useWorkspaceSlug();
  const create = useServerFn(createTaskLabel);
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const [createFailed, setCreateFailed] = useState(false);
  // The color picked for the label being made, kept with the name it was picked for: a new name
  // starts from its default again.
  const [picked, setPicked] = useState<{ name: string; color: string } | null>(null);
  const on = new Set(labels.map((label) => label.id));
  const full = labels.length >= TASK_LABELS_MAX;
  // Archived labels stay on the Tasks that have them but are not offered again.
  const offered = workspaceLabels.filter((label) => !label.archivedAt);
  const offeredIds = new Set(offered.map((label) => label.id));
  const disabledKeys = full ? offered.filter((label) => !on.has(label.id)).map((l) => l.id) : [];
  const wanted = search.trim();
  const exists = offered.some((label) => label.name.toLowerCase() === wanted.toLowerCase());

  const newColor = picked?.name === wanted ? picked.color : newLabelColor(wanted);

  async function createAndAdd(name: string, color: string) {
    setCreateFailed(false);
    try {
      const created = await create({ data: { name, color: color as never } });
      await queryClient.invalidateQueries({ queryKey: workspaceLabelsKey(workspaceId) });
      setSearch("");
      onChange({ add: [created.name] });
    } catch {
      setCreateFailed(true);
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {labels.map((label) =>
        canManage ? (
          <ManageableLabelChip key={label.id} label={label} />
        ) : (
          <TaskLabelChip key={label.id} label={label} />
        ),
      )}
      <Dropdown.Root
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setSearch("");
            setPicked(null);
          }
        }}
      >
        <TaskFieldTrigger label={m.tasks_labels_edit()} disabled={disabled}>
          {labels.length ? (
            <Plus aria-hidden="true" className="size-4 text-fg-quaternary" />
          ) : (
            <span className="text-sm text-tertiary">{m.tasks_labels_add()}</span>
          )}
        </TaskFieldTrigger>
        <Dropdown.Popover placement="bottom start" className="w-72">
          <AriaAutocomplete filter={contains} inputValue={search} onInputChange={setSearch}>
            <div className="border-b border-secondary py-1">
              <AriaSearchField
                aria-label={m.tasks_labels_search()}
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setCreateFailed(false);
                }}
                onSubmit={() => {
                  if (wanted && !exists && !full) void createAndAdd(wanted, newColor);
                }}
                onKeyDown={(event) => {
                  // Esc with nothing typed closes the picker (with text, it clears the text first).
                  // The search box hands Esc to the list, which keeps it, so the picker stayed open.
                  if (event.key === "Escape" && !search) setOpen(false);
                }}
                autoFocus
              >
                <AriaInput
                  placeholder={m.tasks_labels_search()}
                  className="w-full bg-transparent px-3 py-2 text-sm text-primary outline-hidden placeholder:text-placeholder"
                />
              </AriaSearchField>
            </div>
            <Dropdown.Menu
              aria-label={m.tasks_labels()}
              className="max-h-80"
              selectionMode="multiple"
              selectedKeys={[...on].filter((id) => offeredIds.has(id))}
              disabledKeys={disabledKeys}
              onAction={(key) => {
                const label = workspaceLabels.find((each) => each.id === key);
                if (!label) return;
                onChange(on.has(label.id) ? { remove: [label.name] } : { add: [label.name] });
              }}
            >
              {offered.map((label) => (
                <Dropdown.Item
                  key={label.id}
                  id={label.id}
                  textValue={label.name}
                  selectionIndicator="checkbox"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <LabelDot color={label.color} />
                    <span className="truncate">{label.name}</span>
                  </span>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
            {wanted && !exists && !full && (
              <div className="border-t border-secondary px-1.5 py-1">
                <Button
                  size="sm"
                  color="tertiary"
                  iconLeading={Plus}
                  className="w-full justify-start text-brand-secondary"
                  onClick={() => void createAndAdd(wanted, newColor)}
                >
                  <span className="truncate">{m.tasks_labels_create({ name: wanted })}</span>
                </Button>
                <div className="px-2.5 pt-2 pb-1.5">
                  <LabelColorSwatches
                    value={newColor}
                    onChange={(color) => setPicked({ name: wanted, color })}
                    onSubmit={() => void createAndAdd(wanted, newColor)}
                  />
                </div>
                {createFailed && (
                  <p role="alert" className="px-2.5 pb-1 text-xs text-error-primary">
                    {m.tasks_labels_create_failed()}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 border-t border-secondary px-3 py-2 text-xs">
              <span className="text-tertiary">
                {full
                  ? m.tasks_labels_full({ max: String(TASK_LABELS_MAX) })
                  : m.tasks_labels_count({
                      count: String(labels.length),
                      max: String(TASK_LABELS_MAX),
                    })}
              </span>
              {/* Settings → Labels (task #508): "manage" only for whoever may change them, so it
                  waits until that is known rather than flipping from "view all". */}
              {labelsLoaded && (
                <Link
                  to="/w/$workspaceSlug/settings"
                  params={{ workspaceSlug }}
                  search={{ section: "labels" }}
                  onClick={() => setOpen(false)}
                  className="shrink-0 rounded-sm font-medium text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2"
                >
                  {canManage ? m.tasks_labels_manage() : m.tasks_labels_view_all()}
                </Link>
              )}
            </div>
          </AriaAutocomplete>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}
