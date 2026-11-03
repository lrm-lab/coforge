import type { TaskLabel, TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "@untitledui/icons";
import { useCallback, useState } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Input as AriaInput,
  SearchField as AriaSearchField,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { BadgeWithDot } from "#src/components/base/badges/badges";
import type { BadgeColors } from "#src/components/base/badges/badge-types";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { decodeLabelChangedEvent, decodeLabelGroupChangedEvent } from "./label-realtime";
import { createTaskLabel, loadWorkspaceLabels } from "./labels.functions";
import { TaskFieldTrigger } from "./task-field-trigger";

/** A Task carries at most this many labels (the server refuses a sixth). */
export const TASK_LABELS_MAX = 5;
/** How many labels a card shows before the rest fold into `+N`. */
const CARD_LABELS = 2;

const BADGE_COLORS = new Set<string>([
  "gray",
  "brand",
  "error",
  "warning",
  "success",
  "slate",
  "sky",
  "blue",
  "indigo",
  "purple",
  "pink",
  "orange",
]);
/** A label's color as a Badge takes it; an unknown key (a newer server) reads as gray. */
const badgeColor = (color: string) => (BADGE_COLORS.has(color) ? color : "gray") as BadgeColors;

/** One label: its color as a dot, then its name, as Linear's labels read. */
export function TaskLabelChip({ label, className }: { label: TaskLabel; className?: string }) {
  return (
    <BadgeWithDot type="modern" size="sm" color={badgeColor(label.color)} className={className}>
      <span className="min-w-0 max-w-32 truncate">{label.name}</span>
    </BadgeWithDot>
  );
}

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

/** The query key of the Workspace's labels, read by every picker and refreshed by their events. */
const workspaceLabelsKey = (workspaceId: string) => ["workspace-labels", workspaceId];

/**
 * The Workspace's labels for a picker, read once and kept fresh by `label.changed.v1` (and
 * `label.group.changed.v1`, which can rename what a label is listed under).
 */
export function useWorkspaceLabels(enabled: boolean) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const load = useServerFn(loadWorkspaceLabels);
  const queryClient = useQueryClient();
  const labels = useQuery({
    queryKey: workspaceLabelsKey(workspaceId),
    queryFn: () => load(),
    enabled: enabled && workspaceId !== "",
    staleTime: 60_000,
  });
  const onPublication = useCallback(
    ({ data }: { data: unknown }) => {
      if (decodeLabelChangedEvent(data) || decodeLabelGroupChangedEvent(data))
        void queryClient.invalidateQueries({ queryKey: workspaceLabelsKey(workspaceId) });
    },
    [queryClient, workspaceId],
  );
  useRealtimeSubscription({
    channel: enabled && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication,
  });
  return { labels: labels.data ?? [], workspaceId };
}

/** The colors a new label is given, in turn by its name: never gray, so it stands out. */
const NEW_LABEL_COLORS = [
  "blue",
  "purple",
  "pink",
  "orange",
  "success",
  "sky",
  "indigo",
  "warning",
  "error",
  "brand",
] as const;

/** The color a label created by `name` gets: the same name always gets the same one. */
export function newLabelColor(name: string): (typeof NEW_LABEL_COLORS)[number] {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return NEW_LABEL_COLORS[hash % NEW_LABEL_COLORS.length]!;
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
  const labels = task.labels ?? [];
  const { labels: workspaceLabels, workspaceId } = useWorkspaceLabels(open);
  const queryClient = useQueryClient();
  const create = useServerFn(createTaskLabel);
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const [createFailed, setCreateFailed] = useState(false);
  const on = new Set(labels.map((label) => label.id));
  const full = labels.length >= TASK_LABELS_MAX;
  // Archived labels stay on the Tasks that have them but are not offered again.
  const offered = workspaceLabels.filter((label) => !label.archivedAt);
  const offeredIds = new Set(offered.map((label) => label.id));
  const disabledKeys = full ? offered.filter((label) => !on.has(label.id)).map((l) => l.id) : [];
  const wanted = search.trim();
  const exists = offered.some((label) => label.name.toLowerCase() === wanted.toLowerCase());

  async function createAndAdd(name: string) {
    setCreateFailed(false);
    try {
      const created = await create({ data: { name, color: newLabelColor(name) } });
      await queryClient.invalidateQueries({ queryKey: workspaceLabelsKey(workspaceId) });
      setSearch("");
      onChange({ add: [created.name] });
    } catch {
      setCreateFailed(true);
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {labels.map((label) => (
        <TaskLabelChip key={label.id} label={label} />
      ))}
      <Dropdown.Root
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
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
                  if (wanted && !exists && !full) void createAndAdd(wanted);
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
                  onClick={() => void createAndAdd(wanted)}
                >
                  <span className="truncate">{m.tasks_labels_create({ name: wanted })}</span>
                </Button>
                {createFailed && (
                  <p role="alert" className="px-2.5 pb-1 text-xs text-error-primary">
                    {m.tasks_labels_create_failed()}
                  </p>
                )}
              </div>
            )}
            <p className="border-t border-secondary px-3 py-2 text-xs text-tertiary">
              {full
                ? m.tasks_labels_full({ max: String(TASK_LABELS_MAX) })
                : m.tasks_labels_count({
                    count: String(labels.length),
                    max: String(TASK_LABELS_MAX),
                  })}
            </p>
          </AriaAutocomplete>
        </Dropdown.Popover>
      </Dropdown.Root>
    </div>
  );
}

const DOT: Record<string, string> = {
  gray: "bg-utility-neutral-500",
  brand: "bg-utility-brand-500",
  error: "bg-utility-red-500",
  warning: "bg-utility-yellow-500",
  success: "bg-utility-green-500",
  slate: "bg-utility-slate-500",
  sky: "bg-utility-sky-500",
  blue: "bg-utility-blue-500",
  indigo: "bg-utility-indigo-500",
  purple: "bg-utility-purple-500",
  pink: "bg-utility-pink-500",
  orange: "bg-utility-orange-500",
};

/** A label's color as a dot, as its chip shows it. */
function LabelDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", DOT[color] ?? DOT.gray)}
    />
  );
}
