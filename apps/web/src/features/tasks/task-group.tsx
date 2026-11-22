import { type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useDroppable } from "@dnd-kit/core";
import {
  Check,
  ChevronDown,
  DotsHorizontal,
  EyeOff,
  Plus,
  SwitchVertical01,
} from "@untitledui/icons";
import { useEffect, useState, type ReactNode } from "react";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { EmptyState } from "#src/components/ui/empty";
import { formatNumber } from "#src/lib/format-number";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  HIDDEN_COLUMN_CLASS,
  isTaskColumnHidden,
} from "#src/features/settings/task-hidden-columns";
import { dropTargetClass, type DropState } from "./task-drop-target";
import { TaskStatusIcon, statusLabel } from "./task-status-icon";

export type PagedTaskGroup = {
  count: number;
  onExpandedChange: (expanded: boolean) => void;
  footer: ReactNode;
};

const RENDER_PAGE = 50;

export function TaskGroup({
  status,
  count,
  loaded,
  board,
  compact = false,
  dropState,
  paged,
  hidable,
  onHide,
  onAdd,
  onSortByPriority,
  sortedByPriority,
  children,
}: {
  status: TaskStatus;
  hidable?: boolean;
  onHide?: () => void;
  onAdd?: () => void;
  onSortByPriority?: (on: boolean) => void;
  sortedByPriority?: boolean;
  count: number;
  loaded: number;
  board: boolean;
  compact?: boolean;
  dropState: DropState;
  paged?: PagedTaskGroup;
  children: (shown: number) => ReactNode;
}) {
  const drop = useDroppable({ id: status, disabled: dropState !== "open" });
  const label = statusLabel(status);
  const formattedCount = formatNumber(count);
  const [expanded, setExpanded] = useState(true);
  const onExpandedChange = paged?.onExpandedChange;
  useEffect(() => {
    if (hidable && isTaskColumnHidden(status)) return;
    onExpandedChange?.(expanded);
    return () => onExpandedChange?.(false);
  }, [onExpandedChange, expanded, hidable, status]);
  const [shown, setShown] = useState(RENDER_PAGE);
  const hidden = paged ? 0 : loaded - shown;
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={label}
      data-drop-blocked={dropState === "blocked" || undefined}
      className={
        board
          ? cn(
              "flex min-w-0 flex-col rounded-xl bg-secondary md:max-w-80 md:flex-1",
              compact ? "md:min-w-46" : "md:min-w-52",
              hidable && HIDDEN_COLUMN_CLASS[status],
              !expanded && "md:self-start",
              dropTargetClass(dropState, drop.isOver),
            )
          : cn(
              "min-w-0 overflow-hidden rounded-xl border border-secondary bg-primary",
              dropTargetClass(dropState, drop.isOver),
            )
      }
    >
      <Disclosure
        isExpanded={expanded}
        onExpandedChange={setExpanded}
        className={board ? "flex min-h-0 flex-1 flex-col" : undefined}
      >
        <div
          className={cn(
            "flex items-center",
            board ? "shrink-0 pe-1" : cn("bg-secondary", expanded && "border-b border-secondary"),
          )}
        >
          <Heading level={2} className="min-w-0 flex-1">
            <AriaButton
              slot="trigger"
              aria-label={`${label} ${formattedCount}`}
              className={cn(
                "flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 text-sm font-semibold text-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2 any-pointer-coarse:min-h-11",
                board ? "rounded-xl px-3" : "px-4",
              )}
            >
              <TaskStatusIcon status={status} />
              <span className="truncate">{label}</span>
              <span className="font-medium text-quaternary tabular-nums">{formattedCount}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "ms-auto size-4 shrink-0 text-fg-quaternary transition-transform duration-(--duration-sm) ease-in-out motion-reduce:transition-none",
                  board && "md:hidden",
                  !expanded && "-rotate-90 rtl:rotate-90",
                )}
              />
            </AriaButton>
          </Heading>
          {board && onAdd && (
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={Plus}
              tooltip={m.task_board_add_to({ status: label })}
              aria-label={m.task_board_add_to({ status: label })}
              onClick={onAdd}
              className="any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-9"
            />
          )}
          {(onHide || (board && (onAdd || onSortByPriority))) && (
            <Dropdown.Root>
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.tasks_column_menu({ status: label })}
                className="any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-9"
              />
              <Dropdown.Popover placement="bottom end" className="w-48">
                <Dropdown.Menu aria-label={m.tasks_column_menu({ status: label })}>
                  {board && onSortByPriority && (
                    <Dropdown.Item
                      icon={sortedByPriority ? Check : SwitchVertical01}
                      label={m.task_board_sort_priority()}
                      onAction={() => onSortByPriority(!sortedByPriority)}
                    />
                  )}
                  {board && onAdd && (
                    <Dropdown.Item icon={Plus} label={m.task_board_add_here()} onAction={onAdd} />
                  )}
                  {onHide && (
                    <Dropdown.Item icon={EyeOff} label={m.tasks_hide_column()} onAction={onHide} />
                  )}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          )}
        </div>
        <DisclosurePanel
          className={cn(
            board
              ? "flex min-h-16 flex-col gap-2 px-2 pb-4 md:min-h-0 md:flex-1 md:overflow-y-auto [@media(max-height:32rem)]:md:overflow-y-visible"
              : "flex flex-col divide-y divide-secondary",
            !expanded && "hidden",
          )}
        >
          {expanded && children(paged ? loaded : shown)}
          {expanded && hidden > 0 && (
            <div className={cn("flex", board ? "justify-center" : "justify-start px-4 py-2")}>
              <Button
                size="sm"
                color="link-gray"
                onPress={() => setShown((current) => current + RENDER_PAGE)}
              >
                {m.tasks_group_show_more({
                  count: formatNumber(Math.min(hidden, RENDER_PAGE)),
                })}
              </Button>
            </div>
          )}
          {expanded && paged?.footer}
          {expanded && !board && count === 0 && !paged?.footer && (
            <EmptyState size="row" className="px-4" title={m.tasks_group_empty()} />
          )}
        </DisclosurePanel>
      </Disclosure>
    </section>
  );
}

export function HiddenColumn({
  status,
  count,
  dropState,
  onShow,
}: {
  status: TaskStatus;
  count: number;
  dropState: DropState;
  onShow: () => void;
}) {
  const drop = useDroppable({ id: status, disabled: dropState !== "open" });
  const label = statusLabel(status);
  const formattedCount = formatNumber(count);
  return (
    <AriaButton
      ref={drop.setNodeRef}
      aria-label={m.tasks_show_column({ status: label, count: formattedCount })}
      onPress={onShow}
      data-drop-blocked={dropState === "blocked" || undefined}
      className={({ isFocusVisible, isHovered }) =>
        cn(
          "flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-secondary bg-primary px-3 text-sm text-secondary outline-focus-ring transition-[background-color] any-pointer-coarse:min-h-11",
          isHovered && "bg-primary_hover",
          isFocusVisible && "outline-2 outline-offset-2",
          dropTargetClass(dropState, drop.isOver),
        )
      }
    >
      <TaskStatusIcon status={status} />
      <span className="min-w-0 flex-1 truncate text-start">{label}</span>
      <span className="text-quaternary tabular-nums">{formattedCount}</span>
    </AriaButton>
  );
}
