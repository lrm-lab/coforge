import type { TaskLabel } from "@lrm/coforge-sdk/internal";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive } from "@untitledui/icons";
import { createContext, useContext, useState, type ReactNode } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
} from "react-aria-components";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { BadgeWithDot } from "#src/components/base/badges/badges";
import { useAppToast } from "#src/components/ui/toast";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { LabelColorSwatches } from "./label-color-swatches";
import { badgeColor, LABEL_DOT } from "./label-colors";
import { updateTaskLabel } from "./labels.functions";
import { useCloseOnBack } from "./use-close-on-back";
import {
  useCachedLabel,
  useCachedLabelsIndex,
  workspaceLabelsKey,
  type WorkspaceLabels,
  type WorkspaceLabelsIndex,
} from "./workspace-labels";

const WorkspaceLabelsIndexContext = createContext<WorkspaceLabelsIndex | undefined>(undefined);

export function WorkspaceLabelsIndexProvider({ children }: { children: ReactNode }) {
  const index = useCachedLabelsIndex();
  return <WorkspaceLabelsIndexContext value={index}>{children}</WorkspaceLabelsIndexContext>;
}

export function LabelDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", LABEL_DOT[color] ?? LABEL_DOT.gray, className)}
    />
  );
}

export function TaskLabelChip({
  label,
  className,
  full = false,
}: {
  label: TaskLabel;
  className?: string;
  full?: boolean;
}) {
  const index = useContext(WorkspaceLabelsIndexContext);
  if (index !== undefined) {
    const { color, archived } = index.get(label.id) ?? { color: label.color, archived: false };
    return (
      <TaskLabelChipView
        name={label.name}
        color={color}
        archived={archived}
        className={className}
        full={full}
      />
    );
  }
  return <CachedTaskLabelChip label={label} className={className} full={full} />;
}

function CachedTaskLabelChip({
  label,
  className,
  full,
}: {
  label: TaskLabel;
  className?: string;
  full: boolean;
}) {
  const { color, archived } = useCachedLabel(label);
  return (
    <TaskLabelChipView
      name={label.name}
      color={color}
      archived={archived}
      className={className}
      full={full}
    />
  );
}

function TaskLabelChipView({
  name,
  color,
  archived,
  className,
  full,
}: {
  name: string;
  color: string;
  archived: boolean;
  className?: string;
  full: boolean;
}) {
  if (archived) return null;
  return (
    <BadgeWithDot
      type="modern"
      size="sm"
      color={badgeColor(color)}
      className={
        full
          ? cn(
              "h-auto w-fit max-w-full items-start whitespace-normal text-start [&>svg]:mt-1.25 [&>svg]:shrink-0",
              className,
            )
          : cn("w-auto max-w-full min-w-0 overflow-hidden", className)
      }
    >
      <span className={full ? "min-w-0 wrap-anywhere" : "min-w-0 max-w-32 truncate"}>{name}</span>
    </BadgeWithDot>
  );
}

export function ManageableLabelChip({ label }: { label: TaskLabel }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const { color } = useCachedLabel(label);
  const [picked, setPicked] = useState(color);
  const desktop = useBreakpoint("md");
  const queryClient = useQueryClient();
  const update = useServerFn(updateTaskLabel);
  const key = workspaceLabelsKey(useCurrentWorkspaceId() ?? "");
  useCloseOnBack(open && !desktop, () => setOpen(false));

  const toast = useAppToast();

  async function archive() {
    setFailed(false);
    try {
      await update({ data: { id: label.id, archived: true } });
      patch({ archivedAt: new Date() });
      toast.undoable(m.tasks_label_archived_toast({ name: label.name }), {
        key: `label-archive-${label.id}`,
        onUndo: restore,
      });
    } catch {
      setFailed(true);
    }
  }

  async function restore() {
    try {
      await update({ data: { id: label.id, archived: false } });
      patch({ archivedAt: null });
    } catch (cause) {
      setFailed(true);
      throw cause;
    }
  }

  function patch(change: { color?: string; archivedAt?: Date | null }) {
    queryClient.setQueryData<WorkspaceLabels>(
      key,
      (data) =>
        data && {
          ...data,
          labels: data.labels.map((each) => (each.id === label.id ? { ...each, ...change } : each)),
        },
    );
  }

  async function recolor(next: string) {
    setOpen(false);
    if (next === color) return;
    const before = queryClient.getQueryData<WorkspaceLabels>(key);
    setFailed(false);
    patch({ color: next });
    try {
      await update({ data: { id: label.id, color: next as never } });
    } catch {
      queryClient.setQueryData(key, before);
      setFailed(true);
    }
  }

  return (
    <>
      <AriaDialogTrigger
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setPicked(color);
        }}
      >
        <AriaButton
          aria-label={m.tasks_label_color_change({ name: label.name })}
          className="relative max-w-full min-w-0 cursor-pointer rounded-md text-start outline-focus-ring focus-visible:outline-2 any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-x-1 any-pointer-coarse:after:-inset-y-2.5"
        >
          <TaskLabelChip label={label} full />
        </AriaButton>
        <Dropdown.Popover placement="bottom start" className="w-56">
          <AriaDialog aria-label={label.name} className="outline-hidden">
            <div className="p-3">
              <LabelColorSwatches
                value={picked}
                onChange={setPicked}
                onPick={(next) => void recolor(next)}
                onSubmit={() => void recolor(picked)}
              />
            </div>
            <div className="border-t border-secondary p-1.5">
              <AriaButton
                onPress={() => {
                  setOpen(false);
                  void archive();
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-secondary outline-hidden hover:bg-primary_hover focus-visible:bg-primary_hover"
              >
                <Archive aria-hidden="true" className="size-4 text-fg-quaternary" />
                {m.tasks_label_archive()}
              </AriaButton>
            </div>
          </AriaDialog>
        </Dropdown.Popover>
      </AriaDialogTrigger>
      {failed && (
        <span role="alert" className="text-xs text-error-primary">
          {m.tasks_label_color_failed()}
        </span>
      )}
    </>
  );
}
