import type { TaskLabel } from "@lrm/coforge-sdk/internal";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash01 } from "@untitledui/icons";
import { useState } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
} from "react-aria-components";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { BadgeWithDot } from "#src/components/base/badges/badges";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { LabelColorSwatches } from "./label-color-swatches";
import { badgeColor, LABEL_DOT } from "./label-colors";
import { updateTaskLabel } from "./labels.functions";
import { useCloseOnBack } from "./use-close-on-back";
import { useCachedLabel, workspaceLabelsKey, type WorkspaceLabels } from "./workspace-labels";

/** A label's color as a dot, as its chip shows it. */
export function LabelDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", LABEL_DOT[color] ?? LABEL_DOT.gray, className)}
    />
  );
}

/** One label: its color as a dot, then its name, as Linear's labels read. */
export function TaskLabelChip({ label, className }: { label: TaskLabel; className?: string }) {
  const { color, archived } = useCachedLabel(label);
  // Archived (deleted) while the Task is on screen: it is off the Task already, though the Task
  // has not been read again.
  if (archived) return null;
  return (
    <BadgeWithDot type="modern" size="sm" color={badgeColor(color)} className={className}>
      <span className="min-w-0 max-w-32 truncate">{label.name}</span>
    </BadgeWithDot>
  );
}

/**
 * A Task's label chip for an owner or admin: it opens a small menu to recolor the label (a pick
 * applies at once) or delete it. Deleting archives the label, which takes it off every Task and out
 * of the pickers and filters but keeps its rows, so it can come back.
 */
export function ManageableLabelChip({ label }: { label: TaskLabel }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const { color } = useCachedLabel(label);
  const [picked, setPicked] = useState(color);
  const desktop = useBreakpoint("md");
  const queryClient = useQueryClient();
  const update = useServerFn(updateTaskLabel);
  const key = workspaceLabelsKey(useCurrentWorkspaceId() ?? "");
  useCloseOnBack(open && !desktop, () => setOpen(false));

  function patch(change: { color?: string; archivedAt?: Date }) {
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
          className="cursor-pointer rounded-md outline-focus-ring focus-visible:outline-2"
        >
          <TaskLabelChip label={label} />
        </AriaButton>
        <Dropdown.Popover placement="bottom start" className="w-56">
          <AriaDialog aria-label={label.name} className="outline-hidden">
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <LabelDot color={color} />
              <span className="truncate text-sm font-medium text-primary">{label.name}</span>
            </div>
            <div className="px-3 pb-3">
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
                  setConfirming(true);
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-error-primary outline-hidden hover:bg-error-primary focus-visible:bg-error-primary"
              >
                <Trash01 aria-hidden="true" className="size-4" />
                {m.tasks_label_delete()}
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
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={m.tasks_label_delete_title({ name: label.name })}
        description={m.tasks_label_delete_body()}
        confirmLabel={m.tasks_label_delete()}
        pendingLabel={m.tasks_label_delete_pending()}
        errorMessage={m.tasks_label_delete_failed()}
        onConfirm={async () => {
          await update({ data: { id: label.id, archived: true } });
          patch({ archivedAt: new Date() });
          setConfirming(false);
        }}
      />
    </>
  );
}
